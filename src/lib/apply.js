'use strict';

// Putting a theme on the ball, and working out what is on it now.

const { listBallVideos, writeClips, sha256File } = require('./ball');
const { ensureMedley, ballNameFor, isBallMedleyName } = require('./medley');

// Ball files are read over USB, so remember their hashes until they change.
const ballHashCache = new Map();

async function ballHash(file) {
  const key = `${file.path}|${file.size}|${file.mtimeMs}`;
  if (!ballHashCache.has(key)) ballHashCache.set(key, await sha256File(file.path));
  return ballHashCache.get(key);
}

/**
 * Which theme is on the ball: every file belongs to it (a clip or its joined video), and either
 * its joined video or all of its clips are there.
 */
async function whatsOnBall(store, mountPoint) {
  const files = await listBallVideos(mountPoint);
  if (!files.length) return { count: 0, unknown: 0, themeId: null };
  const index = await store.hashIndex();
  const owners = [];
  for (const f of files) owners.push(index.get(await ballHash(f)) || []);
  const unknown = owners.filter((o) => !o.length).length;
  let themeId = null;
  if (!unknown) {
    for (const t of await store.list()) {
      const allTheirs = owners.every((o) => o.some((x) => x.themeId === t.id));
      const clips = owners.filter((o) => o.some((x) => x.themeId === t.id && !x.medley)).length;
      const joined = owners.some((o) => o.some((x) => x.themeId === t.id && x.medley));
      if (allTheirs && (joined || clips === t.clips.length)) {
        themeId = t.id;
        break;
      }
    }
  }
  return { count: files.length, unknown, themeId };
}

/**
 * Replace the ball's videos with a theme: its joined "play all" video on its own, or the clip
 * itself for a one-clip theme (and the clips, if joining fails). Anything on the ball that isn't already in one of our themes is saved first as a
 * "Saved from ball" theme, so nothing is ever lost. `makeMedley` is injectable for tests.
 */
async function applyTheme(store, themeId, mountPoint, onProgress = () => {}, { makeMedley } = {}) {
  const theme = await store.load(themeId);
  if (!theme.clips.length) throw new Error(`“${theme.name}” has no clips yet. Add some first.`);

  onProgress({ step: 'checking' });
  const onBall = await listBallVideos(mountPoint);
  const index = await store.hashIndex();
  const unknown = [];
  for (const f of onBall) {
    // An out-of-date joined video is only a copy of clips we keep, so it needn't be saved.
    if (!index.has(await ballHash(f)) && !isBallMedleyName(f.name)) unknown.push(f);
  }

  let saved = null;
  if (unknown.length) {
    onProgress({ step: 'saving', total: unknown.length });
    saved = await store.saveFromBall(unknown);
  }

  let medley = null;
  let warning = null;
  if (theme.clips.length > 1) {
    onProgress({ step: 'joining', progress: 0 });
    try {
      medley = await ensureMedley(store.dataDir, theme, {
        make: makeMedley,
        onProgress: (progress) => onProgress({ step: 'joining', progress }),
      });
    } catch (err) {
      warning = `Couldn’t join the clips into one video (${err.message}), so the ball will repeat the first clip until someone presses the dial.`;
    }
  }

  // The joined video goes on alone. The ball loops whichever file it starts on, and it doesn't
  // always start on the first, so a single clip beside the joined video can end up repeating.
  const files = medley
    ? [{ path: medley, name: ballNameFor(store.resolve(themeId).slug) }]
    : theme.clips.map((c) => ({ path: c.path, name: c.file }));
  const written = await writeClips(mountPoint, files, onProgress);

  // Read back what landed, so a half-written card never reports success.
  const after = await listBallVideos(mountPoint);
  const landed = written.filter((w) => after.some((a) => a.name === w.name && a.size === w.size));
  if (landed.length !== written.length || after.length !== written.length) {
    throw new Error(`Only ${landed.length} of ${written.length} videos made it onto the ball. Try again.`);
  }
  ballHashCache.clear();
  return {
    themeId,
    name: theme.name,
    count: theme.clips.length,
    playAll: Boolean(medley),
    warning,
    saved: saved && { id: saved.id, name: saved.name, count: saved.clips.length },
  };
}

module.exports = { applyTheme, whatsOnBall };
