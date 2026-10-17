'use strict';

// Generated pictures and voices are not kept in git; the theme scripts in tools/scripts/ are the
// source. These checks make sure every script is complete enough for any model or agent to make its
// media from the plan (`npm run media:plan`), and that every theme is wired into `npm run themes`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SCRIPTS = path.join(ROOT, 'tools', 'scripts');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const scriptFiles = fs.readdirSync(SCRIPTS).filter((f) => f.endsWith('.json'));
const mediaPlan = () => import('../tools/media_plan.mjs');

test('theme scripts exist', () => {
  assert.ok(scriptFiles.length >= 5, 'expected the built-in theme scripts in tools/scripts/');
});

test('every plan item says exactly what to make and where to save it', async () => {
  const { loadScripts, planForScript } = await mediaPlan();
  const outputs = new Set();
  for (const { script } of loadScripts()) {
    const items = planForScript(script);
    assert.ok(items.length, `${script.id}: the plan is empty`);
    for (const it of items) {
      const where = `${script.id}: ${it.output}`;
      assert.match(it.output, new RegExp(`^assets/sources/${script.id}/(art|voice)/`), `${where} is outside the theme's sources`);
      assert.ok(!outputs.has(it.output), `${where} is planned twice`);
      outputs.add(it.output);
      assert.ok(it.requirements?.length, `${where} has no requirements`);
      if (it.kind === 'speech') {
        assert.ok(it.text?.trim(), `${where} has no line to say`);
        assert.ok(it.voice, `${where} has no voice`);
        assert.ok(it.style?.trim(), `${where} has no acting direction (style)`);
      } else {
        assert.ok(['image', 'image-edit'].includes(it.kind), `${where} has unknown kind ${it.kind}`);
        assert.ok(it.prompt?.trim().length > 20, `${where} has no real prompt`);
        if (it.kind === 'image-edit') assert.equal(it.inputs.length, 1, `${where} must edit exactly one picture`);
      }
    }
  }
});

test('every input picture is made earlier in the plan', async () => {
  const { loadScripts, planForScript } = await mediaPlan();
  const made = new Set();
  for (const { script } of loadScripts()) {
    for (const it of planForScript(script)) {
      for (const input of it.inputs || []) {
        assert.ok(made.has(input), `${it.output} needs ${input}, which the plan hasn't made yet (check theme order in "npm run themes")`);
      }
      made.add(it.output);
    }
  }
});

test('a file saved in another format still counts as made', async () => {
  const { existing } = await mediaPlan();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-'));
  fs.mkdirSync(path.join(root, 'assets/sources/x/voice'), { recursive: true });
  fs.writeFileSync(path.join(root, 'assets/sources/x/voice/01-a.wav'), '');
  assert.equal(existing('assets/sources/x/voice/01-a.flac', root), 'assets/sources/x/voice/01-a.wav');
  assert.equal(existing('assets/sources/x/art/head.jpg', root), null);
});

for (const file of scriptFiles) {
  const s = JSON.parse(fs.readFileSync(path.join(SCRIPTS, file), 'utf8'));

  test(`${file}: ids, files and theme.json are consistent`, () => {
    assert.equal(`${s.id}.json`, file, 'the file name should be the theme id');
    for (const k of ['name', 'emoji', 'note']) assert.ok(s[k], `missing "${k}"`);
    const names = s.scenes.map((sc) => sc.file);
    assert.equal(new Set(names).size, names.length, 'scene file names must be unique');
    for (const sc of s.scenes) {
      assert.match(sc.file, /^\d\d-[a-z0-9-]+$/, `scene file "${sc.file}" should look like 01-some-name`);
      assert.ok(sc.title && sc.line, `${sc.file} needs a title and a line`);
      if (s.characters) assert.ok(s.characters[sc.character], `${sc.file} uses unknown character "${sc.character}"`);
      else if (!s.head) assert.ok(sc.art || sc.shots?.length, `${sc.file} needs "art" or "shots"`);
      for (const shot of sc.shots || []) assert.ok(s.art?.[shot], `${sc.file} shows "${shot}", which has no prompt in "art"`);
    }
    const meta = path.join(ROOT, 'assets', 'themes', s.id, 'theme.json');
    assert.ok(fs.existsSync(meta), `assets/themes/${s.id}/theme.json is missing; render the theme once and commit it`);
    const titles = JSON.parse(fs.readFileSync(meta, 'utf8')).titles || {};
    for (const n of names) assert.ok(titles[`${n}.mp4`], `theme.json has no title for ${n}.mp4`);
  });

  test(`${file}: "npm run themes" renders it, skipping it if its media isn't made yet`, () => {
    const name = Object.keys(pkg.scripts).find((k) => k.startsWith('themes:') && pkg.scripts[k].includes(`tools/scripts/${file}`));
    assert.ok(name, `add an npm script that renders tools/scripts/${file}`);
    assert.match(pkg.scripts.themes, new RegExp(`npm run ${name} -- --skip-missing(\\s|$)`), `add "npm run ${name} -- --skip-missing" to "themes"`);
  });
}

test('the drawn Halloween theme needs no generated media and always renders', () => {
  assert.match(pkg.scripts.themes, /^npm run themes:halloween &&/);
});
