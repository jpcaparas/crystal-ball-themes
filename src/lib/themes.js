'use strict';

// Themes are folders of ball-ready MP4s plus a theme.json:
//   { "name": "Halloween", "emoji": "🎃", "note": "...", "titles": { "01-x.mp4": "Pretty title" } }
// Clips play in file-name order, so new clips get the next NN- prefix.
//
//   <bundled>/<slug>/   read-only themes shipped with the app   -> id "builtin/<slug>"
//   <data>/themes/<slug>/ themes the family makes in the app    -> id "user/<slug>"

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { sha256File, plainCopy } = require('./ball');
const { convert } = require('./convert');
const { listMedleys } = require('./medley');

const META = 'theme.json';
const CLIP_EXT = '.mp4';

const DEFAULT_THEMES = [
  {
    slug: 'nightmare-before-christmas',
    name: 'Nightmare Before Christmas',
    emoji: '🦇',
    note: 'Drag in clips or pictures you have, and they get resized for the ball.',
  },
];

function slugify(name) {
  return (
    String(name)
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'theme'
  );
}

function prettyTitle(file) {
  const base = path.basename(file, path.extname(file)).replace(/^\d+[-_ ]+/, '').replace(/[-_]+/g, ' ').trim();
  return base ? base[0].toUpperCase() + base.slice(1) : file;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await fsp.rename(tmp, file);
}

async function listClips(dir, meta) {
  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const clips = [];
  for (const file of names) {
    if (file.startsWith('.') || path.extname(file).toLowerCase() !== CLIP_EXT) continue;
    const p = path.join(dir, file);
    const st = await fsp.stat(p);
    if (!st.isFile()) continue;
    clips.push({ file, path: p, size: st.size, mtimeMs: st.mtimeMs, title: meta.titles?.[file] || prettyTitle(file) });
  }
  return clips.sort((a, b) => a.file.localeCompare(b.file, 'en', { numeric: true }));
}

class ThemeStore {
  constructor({ dataDir, bundledDir, trash = (p) => fsp.rm(p, { recursive: true, force: true }) }) {
    this.dataDir = dataDir;
    this.userDir = path.join(dataDir, 'themes');
    this.bundledDir = bundledDir;
    this.trash = trash;
    this.stateFile = path.join(dataDir, 'state.json');
    this.hashCacheFile = path.join(dataDir, 'hash-cache.json');
  }

  async init() {
    await fsp.mkdir(this.userDir, { recursive: true });
    const state = await readJson(this.stateFile, {});
    const seeded = new Set(state.seeded || []);
    for (const t of DEFAULT_THEMES) {
      if (seeded.has(t.slug)) continue; // created once; if the family deletes it, it stays deleted
      const dir = path.join(this.userDir, t.slug);
      if (!fs.existsSync(dir)) {
        await fsp.mkdir(dir, { recursive: true });
        await writeJson(path.join(dir, META), { name: t.name, emoji: t.emoji, note: t.note });
      }
      seeded.add(t.slug);
    }
    await writeJson(this.stateFile, { ...state, seeded: [...seeded] });
    return this;
  }

  resolve(id) {
    const m = /^(builtin|user)\/([a-z0-9][a-z0-9-]*)$/.exec(String(id));
    if (!m) throw new Error(`Unknown theme: ${id}`);
    return { builtin: m[1] === 'builtin', slug: m[2], dir: path.join(m[1] === 'builtin' ? this.bundledDir : this.userDir, m[2]) };
  }

  async load(id) {
    const { builtin, dir } = this.resolve(id);
    if (!fs.existsSync(dir)) throw new Error('That theme no longer exists.');
    const meta = await readJson(path.join(dir, META), {});
    const clips = await listClips(dir, meta);
    return {
      id,
      builtin,
      dir,
      name: meta.name || prettyTitle(path.basename(dir)),
      emoji: meta.emoji || '✨',
      note: meta.note || '',
      createdAt: meta.createdAt || null,
      clips,
      bytes: clips.reduce((n, c) => n + c.size, 0),
    };
  }

  async list() {
    const out = [];
    for (const [source, root] of [['builtin', this.bundledDir], ['user', this.userDir]]) {
      let names = [];
      try {
        names = (await fsp.readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
      } catch {
        continue;
      }
      for (const slug of names.sort()) {
        if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) continue;
        out.push(await this.load(`${source}/${slug}`));
      }
    }
    // Built-ins first, then the family's themes, newest saved-from-ball sets last.
    return out.sort((a, b) => Number(b.builtin) - Number(a.builtin) || (a.createdAt || '').localeCompare(b.createdAt || '') || a.name.localeCompare(b.name));
  }

  async create(name, emoji = '✨', extra = {}) {
    const clean = String(name || '').trim().slice(0, 60);
    if (!clean) throw new Error('Give the theme a name.');
    let slug = slugify(clean);
    for (let i = 2; fs.existsSync(path.join(this.userDir, slug)); i++) slug = `${slugify(clean)}-${i}`;
    const dir = path.join(this.userDir, slug);
    await fsp.mkdir(dir, { recursive: true });
    await writeJson(path.join(dir, META), { name: clean, emoji, createdAt: new Date().toISOString(), ...extra });
    return this.load(`user/${slug}`);
  }

  async update(id, changes) {
    const { builtin, dir } = this.resolve(id);
    if (builtin) throw new Error('Built-in themes can’t be changed.');
    const meta = await readJson(path.join(dir, META), {});
    if (changes.name !== undefined) meta.name = String(changes.name).trim().slice(0, 60) || meta.name;
    if (changes.emoji !== undefined) meta.emoji = String(changes.emoji).slice(0, 8) || meta.emoji;
    await writeJson(path.join(dir, META), meta);
    return this.load(id);
  }

  async remove(id) {
    const { builtin, dir } = this.resolve(id);
    if (builtin) throw new Error('Built-in themes can’t be deleted.');
    await this.trash(dir);
  }

  async removeClip(id, file) {
    const { builtin, dir } = this.resolve(id);
    if (builtin) throw new Error('Built-in themes can’t be changed.');
    if (path.basename(file) !== file) throw new Error('Bad clip name.');
    await this.trash(path.join(dir, file));
    const meta = await readJson(path.join(dir, META), {});
    if (meta.titles) delete meta.titles[file];
    await writeJson(path.join(dir, META), meta);
    return this.load(id);
  }

  /** Convert a video/GIF/picture into the theme. Returns the updated theme. */
  async addClip(id, input, { fit = 'fill', onProgress } = {}) {
    const { builtin, dir } = this.resolve(id);
    if (builtin) throw new Error('Built-in themes can’t be changed.');
    const meta = await readJson(path.join(dir, META), {});
    const existing = await listClips(dir, meta);
    const next = existing.reduce((n, c) => Math.max(n, Number.parseInt(c.file, 10) || 0), 0) + 1;
    const title = prettyTitle(path.basename(input));
    const file = `${String(next).padStart(2, '0')}-${slugify(title).slice(0, 40)}${CLIP_EXT}`;
    const tmp = path.join(dir, `.converting-${file}`);
    await convert(input, tmp, { fit, onProgress });
    await fsp.rename(tmp, path.join(dir, file));
    meta.titles = { ...(meta.titles || {}), [file]: title };
    await writeJson(path.join(dir, META), meta);
    return this.load(id);
  }

  /** Keep a copy of ball videos we don't already have, as their own theme. */
  async saveFromBall(files) {
    const stamp = new Date();
    const label = stamp.toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' });
    const theme = await this.create(`Saved from ball (${label})`, '💾', {
      note: 'Videos that were on the ball before a theme replaced them.',
    });
    for (const f of files) await plainCopy(f.path, path.join(theme.dir, path.basename(f.path)));
    return this.load(theme.id);
  }

  /**
   * sha256 -> [{ themeId, file, medley }] for every clip and joined "play all" video we have,
   * cached by path + size + mtime.
   */
  async hashIndex() {
    const cache = await readJson(this.hashCacheFile, {});
    const fresh = {};
    const index = new Map();
    const add = async (filePath, themeId, file, medley) => {
      const st = await fsp.stat(filePath);
      const hit = cache[filePath];
      const sha = hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs ? hit.sha : await sha256File(filePath);
      fresh[filePath] = { size: st.size, mtimeMs: st.mtimeMs, sha };
      if (!index.has(sha)) index.set(sha, []);
      index.get(sha).push({ themeId, file, medley });
    };
    for (const theme of await this.list()) {
      for (const c of theme.clips) await add(c.path, theme.id, c.file, false);
    }
    for (const m of await listMedleys(this.dataDir)) await add(m.path, m.themeId, m.file, true);
    await writeJson(this.hashCacheFile, fresh);
    return index;
  }
}

module.exports = { ThemeStore, slugify, prettyTitle, DEFAULT_THEMES };
