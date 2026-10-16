'use strict';

// Finding the crystal ball and writing to it.
//
// The ball's stock firmware exposes a single USB mass-storage LUN (FAT32) and plays every
// MP4 in its top-level `video` folder. The manual warns not to delete or rename that folder.
// We only ever touch regular files inside it.

const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { pipeline } = require('node:stream/promises');

const USB_PRODUCT = 'EVDO-M4'; // iProduct string; VID 0x33C3 (ArtInChip), PID 0xFFFF
const VIDEO_DIR = 'video';
const PLAYABLE = new Set(['.mp4']);

function run(cmd, args, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
      } else resolve(stdout);
    });
  });
}

/** BSD names (disk6, disk6s1, ...) that ioreg lists under the ball's USB device. */
function parseIoregBsdNames(text) {
  return [...new Set([...text.matchAll(/"BSD Name" = "(disk\d+(?:s\d+)*)"/g)].map((m) => m[1]))];
}

/** Parse `mount` output into { bsd, mountPoint, fsType }. */
function parseMount(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\/dev\/(disk\d+(?:s\d+)*) on (.+?) \(([^,)]+)/);
    if (m) out.push({ bsd: m[1], mountPoint: m[2], fsType: m[3] });
  }
  return out;
}

async function isDir(p) {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Look for the ball. We avoid `diskutil info`, which hangs on this device, and use ioreg + mount.
 * Falls back to any FAT volume with a top-level `video` folder (other balls may report another name).
 */
async function detectBall({ ioreg = null, mount = null } = {}) {
  let bsd = [];
  try {
    bsd = parseIoregBsdNames(ioreg ?? (await run('/usr/sbin/ioreg', ['-r', '-n', USB_PRODUCT, '-l', '-w0'])));
  } catch {
    bsd = [];
  }
  const mounts = parseMount(mount ?? (await run('/sbin/mount', [])));
  let vol = mounts.find((m) => bsd.includes(m.bsd));
  let matchedBy = vol ? 'usb' : null;
  if (!vol) {
    for (const m of mounts) {
      if (m.fsType === 'msdos' && m.mountPoint.startsWith('/Volumes/') && (await isDir(path.join(m.mountPoint, VIDEO_DIR)))) {
        vol = m;
        matchedBy = 'video-folder';
        break;
      }
    }
  }
  if (!vol) return { usbSeen: bsd.length > 0, mounted: false };
  let free = null;
  let total = null;
  try {
    const st = await fsp.statfs(vol.mountPoint);
    free = st.bavail * st.bsize;
    total = st.blocks * st.bsize;
  } catch {
    /* volume vanished mid-check */
  }
  return {
    usbSeen: bsd.length > 0,
    mounted: true,
    matchedBy,
    mountPoint: vol.mountPoint,
    volumeName: path.basename(vol.mountPoint),
    bsd: vol.bsd,
    free,
    total,
  };
}

/** Playable videos currently in the ball's `video` folder, in name order. */
async function listBallVideos(mountPoint) {
  const dir = path.join(mountPoint, VIDEO_DIR);
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || e.name.startsWith('.')) continue;
    if (!PLAYABLE.has(path.extname(e.name).toLowerCase())) continue;
    const p = path.join(dir, e.name);
    const st = await fsp.stat(p);
    out.push({ name: e.name, path: p, size: st.size, mtimeMs: st.mtimeMs });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
}

async function sha256File(p) {
  const h = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(p), h);
  return h.digest('hex');
}

/**
 * Copy without macOS metadata. fs.copyFile clones extended attributes, which on FAT turn into
 * `._name.mp4` AppleDouble files that the ball would try (and fail) to play.
 */
async function plainCopy(src, dst) {
  await pipeline(fs.createReadStream(src), fs.createWriteStream(dst));
  const fh = await fsp.open(dst, 'r+');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/**
 * A name FAT32 accepts. Long names may be Unicode (the factory clips are named 星空1.mp4),
 * so only characters FAT forbids are replaced.
 */
function fatSafeName(name) {
  const ext = path.extname(name).toLowerCase() || '.mp4';
  let base = path
    .basename(name, path.extname(name))
    .normalize('NFC')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/^[. ]+|[. ]+$/g, '');
  if (!base) base = 'clip';
  return base.slice(0, 100) + ext;
}

/** Remove AppleDouble (`._*`) and Finder litter from the video folder. */
async function removeMacLitter(dir) {
  for (const name of await fsp.readdir(dir)) {
    if (name.startsWith('._') || name === '.DS_Store') await fsp.rm(path.join(dir, name), { force: true });
  }
}

/**
 * Replace the contents of the ball's `video` folder with `clips` ([{ path, name }]).
 * Callers must have saved anything they want to keep first; see apply.js.
 */
async function writeClips(mountPoint, clips, onProgress = () => {}) {
  const dir = path.join(mountPoint, VIDEO_DIR);
  await fsp.mkdir(dir, { recursive: true });

  const need = (await Promise.all(clips.map((c) => fsp.stat(c.path)))).reduce((n, st) => n + st.size, 0);
  const existing = await fsp.readdir(dir, { withFileTypes: true });
  const st = await fsp.statfs(mountPoint);
  let reclaim = 0;
  for (const e of existing) if (e.isFile()) reclaim += (await fsp.stat(path.join(dir, e.name))).size;
  if (need > st.bavail * st.bsize + reclaim) {
    throw new Error(`Not enough space on the ball: need ${Math.ceil(need / 1e6)} MB.`);
  }

  onProgress({ step: 'clearing' });
  for (const e of existing) {
    if (e.isFile()) await fsp.rm(path.join(dir, e.name), { force: true });
  }

  const used = new Set();
  const written = [];
  for (const [i, clip] of clips.entries()) {
    let name = fatSafeName(clip.name || path.basename(clip.path));
    while (used.has(name.toLowerCase())) name = name.replace(/(\.\w+)$/, `-${i}$1`);
    used.add(name.toLowerCase());
    onProgress({ step: 'copying', index: i, total: clips.length, name });
    await plainCopy(clip.path, path.join(dir, name));
    written.push({ name, size: (await fsp.stat(clip.path)).size });
  }
  await removeMacLitter(dir);
  await run('/bin/sync', []).catch(() => {});
  onProgress({ step: 'done', total: clips.length });
  return written;
}

/** Unmount so the FAT volume is clean before unplugging. */
async function eject(mountPoint) {
  try {
    await run('/usr/sbin/diskutil', ['eject', mountPoint], 45000);
    return { ok: true };
  } catch (err) {
    try {
      await run('/usr/sbin/diskutil', ['unmount', mountPoint], 45000);
      return { ok: true };
    } catch {
      return { ok: false, error: (err.stderr || err.message || '').trim() };
    }
  }
}

module.exports = {
  USB_PRODUCT,
  VIDEO_DIR,
  detectBall,
  listBallVideos,
  writeClips,
  eject,
  sha256File,
  plainCopy,
  fatSafeName,
  parseIoregBsdNames,
  parseMount,
};
