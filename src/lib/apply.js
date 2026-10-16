'use strict';

// Putting a theme on the ball, and working out what is on it now.

const { listBallVideos, writeClips, sha256File } = require('./ball');

// Ball files are read over USB, so remember their hashes until they change.
const ballHashCache = new Map();

async function ballHash(file) {
  const key = `${file.path}|${file.size}|${file.mtimeMs}`;
  if (!ballHashCache.has(key)) ballHashCache.set(key, await sha256File(file.path));
  return ballHashCache.get(key);
}

/** Which theme's clips exactly match what's on the ball, if any. */
async function whatsOnBall(store, mountPoint) {
  const files = await listBallVideos(mountPoint);
  if (!files.length) return { count: 0, themeId: null };
  const index = await store.hashIndex();
  const counts = new Map();
  let unknown = 0;
  for (const f of files) {
    const owners = index.get(await ballHash(f));
    if (!owners) unknown++;
    for (const id of new Set((owners || []).map((o) => o.themeId))) counts.set(id, (counts.get(id) || 0) + 1);
  }
  let themeId = null;
  if (!unknown) {
    for (const t of await store.list()) {
      if (t.clips.length === files.length && counts.get(t.id) === files.length) {
        themeId = t.id;
        break;
      }
    }
  }
  return { count: files.length, unknown, themeId };
}

/**
 * Replace the ball's videos with a theme. Anything on the ball that isn't already in one of
 * our themes is saved first as a "Saved from ball" theme, so nothing is ever lost.
 */
async function applyTheme(store, themeId, mountPoint, onProgress = () => {}) {
  const theme = await store.load(themeId);
  if (!theme.clips.length) throw new Error(`“${theme.name}” has no clips yet. Add some first.`);

  onProgress({ step: 'checking' });
  const onBall = await listBallVideos(mountPoint);
  const index = await store.hashIndex();
  const unknown = [];
  for (const f of onBall) if (!index.has(await ballHash(f))) unknown.push(f);

  let saved = null;
  if (unknown.length) {
    onProgress({ step: 'saving', total: unknown.length });
    saved = await store.saveFromBall(unknown);
  }

  const written = await writeClips(mountPoint, theme.clips.map((c) => ({ path: c.path, name: c.file })), onProgress);

  // Read back what landed, so a half-written card never reports success.
  const after = await listBallVideos(mountPoint);
  const landed = written.filter((w) => after.some((a) => a.name === w.name && a.size === w.size));
  if (landed.length !== written.length || after.length !== written.length) {
    throw new Error(`Only ${landed.length} of ${written.length} clips made it onto the ball. Try again.`);
  }
  ballHashCache.clear();
  return { themeId, name: theme.name, count: after.length, saved: saved && { id: saved.id, name: saved.name, count: saved.clips.length } };
}

module.exports = { applyTheme, whatsOnBall };
