'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ThemeStore, slugify, prettyTitle } = require('../src/lib/themes');
const { applyTheme, whatsOnBall } = require('../src/lib/apply');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'themes-'));
  const bundled = path.join(root, 'bundled');
  const data = path.join(root, 'data');
  const ball = path.join(root, 'ball');
  fs.mkdirSync(path.join(bundled, 'halloween'), { recursive: true });
  fs.writeFileSync(path.join(bundled, 'halloween', 'theme.json'), JSON.stringify({ name: 'Halloween', emoji: '🎃' }));
  fs.writeFileSync(path.join(bundled, 'halloween', '02-ghost.mp4'), 'ghost');
  fs.writeFileSync(path.join(bundled, 'halloween', '01-pumpkin.mp4'), 'pumpkin');
  fs.mkdirSync(path.join(ball, 'video'), { recursive: true });
  return { root, bundled, data, ball };
}

test('slugify and prettyTitle', () => {
  assert.equal(slugify('Nightmare Before Christmas!'), 'nightmare-before-christmas');
  assert.equal(slugify('   '), 'theme');
  assert.equal(prettyTitle('03-friendly-ghost.mp4'), 'Friendly ghost');
});

test('init seeds the Nightmare Before Christmas theme only once', async () => {
  const f = fixture();
  const store = await new ThemeStore({ dataDir: f.data, bundledDir: f.bundled }).init();
  let ids = (await store.list()).map((t) => t.id);
  assert.deepEqual(ids, ['builtin/halloween', 'user/nightmare-before-christmas']);
  await store.remove('user/nightmare-before-christmas');
  await store.init();
  ids = (await store.list()).map((t) => t.id);
  assert.deepEqual(ids, ['builtin/halloween']);
});

test('built-in themes are read-only and ids cannot escape the store', async () => {
  const f = fixture();
  const store = await new ThemeStore({ dataDir: f.data, bundledDir: f.bundled }).init();
  await assert.rejects(store.remove('builtin/halloween'), /can’t be deleted/);
  assert.throws(() => store.resolve('user/../../etc'), /Unknown theme/);
  const t = await store.load('builtin/halloween');
  assert.deepEqual(t.clips.map((c) => c.file), ['01-pumpkin.mp4', '02-ghost.mp4']);
});

test('applying a theme saves unknown ball videos first, then recognises the theme on the ball', async () => {
  const f = fixture();
  const store = await new ThemeStore({ dataDir: f.data, bundledDir: f.bundled }).init();
  fs.writeFileSync(path.join(f.ball, 'video', 'family.mp4'), 'precious');

  const res = await applyTheme(store, 'builtin/halloween', f.ball);
  assert.equal(res.count, 2);
  assert.equal(res.saved.count, 1);
  const saved = await store.load(res.saved.id);
  assert.equal(fs.readFileSync(saved.clips[0].path, 'utf8'), 'precious');
  assert.deepEqual(fs.readdirSync(path.join(f.ball, 'video')).sort(), ['01-pumpkin.mp4', '02-ghost.mp4']);
  assert.equal((await whatsOnBall(store, f.ball)).themeId, 'builtin/halloween');

  // Switching back restores the saved videos; nothing new needs saving.
  const back = await applyTheme(store, res.saved.id, f.ball);
  assert.equal(back.saved, null);
  assert.deepEqual(fs.readdirSync(path.join(f.ball, 'video')), ['family.mp4']);
});

test('an empty theme cannot be applied', async () => {
  const f = fixture();
  const store = await new ThemeStore({ dataDir: f.data, bundledDir: f.bundled }).init();
  await assert.rejects(applyTheme(store, 'user/nightmare-before-christmas', f.ball), /has no clips yet/);
});
