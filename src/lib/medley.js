'use strict';

// "Play all" videos: every clip of a theme joined into one file.
//
// The ball repeats whichever file it is playing and only moves on when someone presses the dial,
// so on a door it would show one clip forever. Putting the joined video on the ball by itself
// means it cycles through the whole theme on its own, whichever file the ball would start on.
//
// Joined videos are cached in <data>/medleys/<source>--<slug>--<key>.mp4, where key changes
// whenever the theme's clips change.

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { makeMedley } = require('./convert');

const DIR = 'medleys';
const FILE_RE = /^(builtin|user)--([a-z0-9]+(?:-[a-z0-9]+)*)--([0-9a-f]{12})\.mp4$/;

const prefixFor = (themeId) => `${themeId.replace('/', '--')}--`;

function keyFor(theme) {
  const clips = theme.clips.map((c) => [c.file, c.size, Math.round(c.mtimeMs)]);
  return crypto.createHash('sha256').update(JSON.stringify(clips)).digest('hex').slice(0, 12);
}

function medleyPath(dataDir, theme) {
  return path.join(dataDir, DIR, `${prefixFor(theme.id)}${keyFor(theme)}.mp4`);
}

/** The name the joined video gets on the ball. "00-" keeps it first in every ordering. */
function ballNameFor(slug) {
  return `00-${slug}-all.mp4`;
}

/** True for file names this app gives joined videos on the ball. */
function isBallMedleyName(name) {
  return /^00-[a-z0-9-]+-all\.mp4$/.test(name);
}

/** Cached joined videos: [{ path, file, themeId }]. */
async function listMedleys(dataDir) {
  let names = [];
  try {
    names = await fsp.readdir(path.join(dataDir, DIR));
  } catch {
    return [];
  }
  return names
    .map((file) => ({ file, m: FILE_RE.exec(file) }))
    .filter((x) => x.m)
    .map(({ file, m }) => ({ file, path: path.join(dataDir, DIR, file), themeId: `${m[1]}/${m[2]}` }));
}

/**
 * Path to the theme's joined video, making it if needed. Returns null for themes with fewer
 * than two clips (nothing to join). `make` is injectable for tests.
 */
async function ensureMedley(dataDir, theme, { make = makeMedley, onProgress = () => {} } = {}) {
  if (theme.clips.length < 2) return null;
  const out = medleyPath(dataDir, theme);
  if (fs.existsSync(out)) return out;
  const dir = path.dirname(out);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.making-${path.basename(out)}`);
  await make(theme.clips.map((c) => c.path), tmp, { onProgress });
  await fsp.rename(tmp, out);
  // Older joins of this theme are out of date now.
  for (const m of await listMedleys(dataDir)) {
    if (m.themeId === theme.id && m.path !== out) await fsp.rm(m.path, { force: true });
  }
  return out;
}

module.exports = { ensureMedley, listMedleys, medleyPath, ballNameFor, isBallMedleyName, keyFor };
