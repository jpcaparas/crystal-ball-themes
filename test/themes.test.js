'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ThemeStore, slugify, prettyTitle } = require('../src/lib/themes');
const { applyTheme, whatsOnBall } = require('../src/lib/apply');
const { ensureMedley, listMedleys, isBallMedleyName } = require('../src/lib/medley');

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

test('built-in themes that are not rendered yet are hidden', async () => {
  const f = fixture();
  fs.mkdirSync(path.join(f.bundled, 'monster-parade'));
  fs.writeFileSync(path.join(f.bundled, 'monster-parade', 'theme.json'), JSON.stringify({ name: 'Monster Parade' }));
  const store = await new ThemeStore({ dataDir: f.data, bundledDir: f.bundled }).init();
  const ids = (await store.list()).map((t) => t.id);
  assert.deepEqual(ids, ['builtin/halloween', 'user/nightmare-before-christmas']);
});

// Stands in for ffmpeg: the "joined video" is just the clips' bytes back to back.
const fakeJoin = async (paths, out) => fs.writeFileSync(out, paths.map((p) => fs.readFileSync(p, 'utf8')).join('+'));

test('applying a theme saves unknown ball videos first, puts only the joined video on, and recognises the theme', async () => {
  const f = fixture();
  const store = await new ThemeStore({ dataDir: f.data, bundledDir: f.bundled }).init();
  fs.writeFileSync(path.join(f.ball, 'video', 'family.mp4'), 'precious');

  const res = await applyTheme(store, 'builtin/halloween', f.ball, () => {}, { makeMedley: fakeJoin });
  assert.equal(res.count, 2);
  assert.equal(res.playAll, true);
  assert.equal(res.saved.count, 1);
  const saved = await store.load(res.saved.id);
  assert.equal(fs.readFileSync(saved.clips[0].path, 'utf8'), 'precious');
  // Alone, so the ball can't start on (and repeat) a single clip.
  assert.deepEqual(fs.readdirSync(path.join(f.ball, 'video')), ['00-halloween-all.mp4']);
  assert.equal(fs.readFileSync(path.join(f.ball, 'video', '00-halloween-all.mp4'), 'utf8'), 'pumpkin+ghost');
  assert.equal((await whatsOnBall(store, f.ball)).themeId, 'builtin/halloween');

  // Switching back restores the saved videos; the joined video is ours, so nothing needs saving.
  const back = await applyTheme(store, res.saved.id, f.ball, () => {}, { makeMedley: fakeJoin });
  assert.equal(back.saved, null);
  assert.equal(back.playAll, false); // one clip, nothing to join
  assert.deepEqual(fs.readdirSync(path.join(f.ball, 'video')), ['family.mp4']);
});

test('a ball from older versions, with the joined video and every clip, is still recognised', async () => {
  const f = fixture();
  const store = await new ThemeStore({ dataDir: f.data, bundledDir: f.bundled }).init();
  await applyTheme(store, 'builtin/halloween', f.ball, () => {}, { makeMedley: fakeJoin });
  for (const name of ['01-pumpkin.mp4', '02-ghost.mp4']) {
    fs.copyFileSync(path.join(f.bundled, 'halloween', name), path.join(f.ball, 'video', name));
  }
  assert.equal((await whatsOnBall(store, f.ball)).themeId, 'builtin/halloween');
});

test('an out-of-date joined video on the ball is not saved again', async () => {
  const f = fixture();
  const store = await new ThemeStore({ dataDir: f.data, bundledDir: f.bundled }).init();
  fs.writeFileSync(path.join(f.ball, 'video', '00-halloween-all.mp4'), 'an older join');
  const res = await applyTheme(store, 'builtin/halloween', f.ball, () => {}, { makeMedley: fakeJoin });
  assert.equal(res.saved, null);
});

test('if joining fails, the clips still go on and the family is told why', async () => {
  const f = fixture();
  const store = await new ThemeStore({ dataDir: f.data, bundledDir: f.bundled }).init();
  const res = await applyTheme(store, 'builtin/halloween', f.ball, () => {}, {
    makeMedley: async () => {
      throw new Error('no ffmpeg');
    },
  });
  assert.equal(res.playAll, false);
  assert.match(res.warning, /no ffmpeg/);
  assert.deepEqual(fs.readdirSync(path.join(f.ball, 'video')).sort(), ['01-pumpkin.mp4', '02-ghost.mp4']);
});

test('joined videos are cached until the theme changes', async () => {
  const f = fixture();
  const store = await new ThemeStore({ dataDir: f.data, bundledDir: f.bundled }).init();
  let calls = 0;
  const counting = async (paths, out) => {
    calls++;
    await fakeJoin(paths, out);
  };
  const t = await store.create('Spooky', '👻');
  fs.copyFileSync(path.join(f.bundled, 'halloween', '01-pumpkin.mp4'), path.join(t.dir, '01-a.mp4'));
  fs.copyFileSync(path.join(f.bundled, 'halloween', '02-ghost.mp4'), path.join(t.dir, '02-b.mp4'));
  const first = await ensureMedley(f.data, await store.load(t.id), { make: counting });
  assert.equal(await ensureMedley(f.data, await store.load(t.id), { make: counting }), first);
  assert.equal(calls, 1);

  fs.writeFileSync(path.join(t.dir, '03-c.mp4'), 'cat');
  const second = await ensureMedley(f.data, await store.load(t.id), { make: counting });
  assert.notEqual(second, first);
  assert.equal(calls, 2);
  assert.deepEqual((await listMedleys(f.data)).map((m) => m.themeId), ['user/spooky']); // old join removed
  assert.equal(isBallMedleyName('00-spooky-all.mp4'), true);
  assert.equal(isBallMedleyName('01-a.mp4'), false);
});

test('an empty theme cannot be applied', async () => {
  const f = fixture();
  const store = await new ThemeStore({ dataDir: f.data, bundledDir: f.bundled }).init();
  await assert.rejects(applyTheme(store, 'user/nightmare-before-christmas', f.ball), /has no clips yet/);
});

test('backup copies only the family\'s own themes into a dated folder', async () => {
  const f = fixture();
  const store = await new ThemeStore({ dataDir: f.data, bundledDir: f.bundled }).init();
  const mine = await store.create('Birthday', '🎂');
  fs.writeFileSync(path.join(mine.dir, '01-cake.mp4'), 'cake');
  const out = await store.backup(path.join(f.root, 'backups'));
  assert.match(path.basename(out), /^crystal-ball-themes-backup-\d{4}-\d\d-\d\d-/);
  assert.equal(fs.readFileSync(path.join(out, 'themes', 'birthday', '01-cake.mp4'), 'utf8'), 'cake');
  assert.ok(fs.existsSync(path.join(out, 'HOW-TO-RESTORE.txt')));
  assert.ok(!fs.existsSync(path.join(out, 'themes', 'halloween')), 'built-in themes are not backed up');
});
