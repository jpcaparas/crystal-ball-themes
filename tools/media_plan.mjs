#!/usr/bin/env node
// The media plan: every picture and voice line the built-in themes need, worked out from the theme
// scripts in tools/scripts/ using the same rules as the render tools (voice_theme.py, spirit_theme.py).
//
// Generated media is not kept in git. Any multimodal agent or model can read this plan, make each item
// (any image model, any text-to-speech), save it at `output`, and then `npm run themes` renders offline.
// tools/gemini_media.py is just the built-in way to do that with Gemini.
//
// Usage:
//   npm run media:plan                      summary per theme
//   npm run media:plan -- --json            the full plan as JSON
//   npm run media:plan -- --json --missing  only what still needs making
//   npm run media:plan -- --theme monster-parade

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join(ROOT, 'tools', 'scripts');
const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp'];
const AUDIO_EXT = ['.flac', '.wav', '.mp3', '.m4a', '.ogg'];

const IMAGE_RULES = [
  'Square (1:1), at least 1024 x 1024 pixels.',
  'Keep everything important inside the central circle: the screen is round and hides the corners.',
  'No text, letters, logos, frames or borders.',
];
const FACE_RULES = [
  ...IMAGE_RULES,
  'Front-facing, looking at the viewer, eyes open, mouth closed; face centred, eyes just above the middle, mouth just below.',
];
const EDIT_RULES = [
  'Edit the input picture. Keep everything else identical: same framing, position, size, lighting and colours.',
  'Only the described part may change, so the mouth and eyes line up for lip-sync.',
];
const SPEECH_RULES = [
  'Say `text` word for word. Anything in <angle brackets> is a performance cue (a laugh, a pause, a whisper), not words.',
  'Use `voice` if your engine has it; otherwise any voice that fits `style`.',
  'Any common audio format (WAV, FLAC, MP3...); mono is fine.',
];

/** The file that exists for this output, whatever image/audio extension it was saved with. */
export function existing(output, root = ROOT) {
  const base = output.replace(/\.[a-z0-9]+$/i, '');
  const exts = AUDIO_EXT.includes(path.extname(output)) ? AUDIO_EXT : IMAGE_EXT;
  for (const ext of exts) if (fs.existsSync(path.join(root, base + ext))) return base + ext;
  return null;
}

const rel = (...p) => path.join('assets', 'sources', ...p).split(path.sep).join('/');

function facePlan(theme, artDir, headPrompt, variants, refs) {
  const head = rel(theme, ...artDir, 'head.jpg');
  const items = [{ kind: 'image', output: head, prompt: headPrompt, inputs: refs, requirements: FACE_RULES }];
  for (const [key, prompt] of Object.entries(variants)) {
    items.push({ kind: 'image-edit', output: rel(theme, ...artDir, `${key}.jpg`), prompt, inputs: [head], requirements: EDIT_RULES });
  }
  return items;
}

/** Plan items for one theme script, in the order they must be made. */
export function planForScript(script) {
  const id = script.id;
  const items = [];
  if (script.characters) {
    // talking-head cast (spirit_theme.py)
    for (const [key, ch] of Object.entries(script.characters)) {
      const prompt = `${script.art_style || ''} ${ch.head}`.trim();
      const refs = ch.reference ? [rel(ch.reference)] : [];
      items.push(...facePlan(id, ['art', key], prompt, ch.variants || script.variants, refs));
    }
    for (const sc of script.scenes) {
      const ch = script.characters[sc.character] || {};
      items.push(speech(id, sc, ch.voice || script.voice, ch.style || script.style));
    }
  } else if (script.head) {
    // single talking head (spirit_theme.py): the head prompt is used as written
    items.push(...facePlan(id, ['art'], script.head, script.variants, script.reference ? [rel(script.reference)] : []));
    for (const sc of script.scenes) items.push(speech(id, sc, script.voice, script.style));
  } else {
    // voiced scenes (voice_theme.py): one or two pictures per scene, shared ones in "art"
    const art = { ...(script.art || {}) };
    for (const sc of script.scenes) if (sc.art) art[sc.file] = sc.art;
    const needed = [...new Set(script.scenes.flatMap((sc) => (sc.art ? [sc.file] : sc.shots || [])))];
    for (const key of needed) {
      items.push({ kind: 'image', output: rel(id, 'art', `${key}.jpg`), prompt: `${script.art_style} ${art[key]}`, inputs: [], requirements: IMAGE_RULES });
    }
    for (const sc of script.scenes) items.push(speech(id, sc, sc.voice || script.voice || 'Kore', sc.style || script.style));
  }
  return items.map((it) => ({ theme: id, ...it }));
}

function speech(theme, sc, voice, style) {
  return { kind: 'speech', output: rel(theme, 'voice', `${sc.file}.flac`), text: sc.line, voice, style, requirements: SPEECH_RULES };
}

/** Theme scripts in the order `npm run themes` renders them (later themes may reference earlier art). */
export function loadScripts() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const order = (pkg.scripts.themes || '').match(/themes:[a-z-]+/g) || [];
  const rank = (file) => {
    const name = Object.keys(pkg.scripts).find((k) => pkg.scripts[k].includes(`tools/scripts/${file}`));
    const i = order.indexOf(name);
    return i < 0 ? Infinity : i;
  };
  return fs
    .readdirSync(SCRIPTS)
    .filter((f) => f.endsWith('.json'))
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((file) => ({ file, script: JSON.parse(fs.readFileSync(path.join(SCRIPTS, file), 'utf8')) }));
}

export function mediaPlan() {
  return loadScripts().flatMap(({ file, script }) =>
    planForScript(script).map((it) => {
      const found = existing(it.output);
      return { ...it, script: `tools/scripts/${file}`, present: Boolean(found), found };
    }),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const theme = args.includes('--theme') ? args[args.indexOf('--theme') + 1] : null;
  let plan = mediaPlan().filter((it) => !theme || it.theme === theme);
  if (args.includes('--missing')) plan = plan.filter((it) => !it.present);
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(plan.map(({ found, ...it }) => it), null, 2)}\n`);
  } else {
    const byTheme = new Map();
    for (const it of plan) {
      const t = byTheme.get(it.theme) || { total: 0, missing: 0, kinds: {} };
      t.total++;
      if (!it.present) t.missing++;
      t.kinds[it.kind] = (t.kinds[it.kind] || 0) + 1;
      byTheme.set(it.theme, t);
    }
    for (const [id, t] of byTheme) {
      const kinds = Object.entries(t.kinds).map(([k, n]) => `${n} ${k}`).join(', ');
      console.log(`${t.missing ? '…' : '✓'} ${id.padEnd(22)} ${String(t.total - t.missing).padStart(3)}/${t.total} made  (${kinds})`);
    }
    console.log('\nFull details for any agent or model: npm run media:plan -- --json [--missing]. See docs/media.md.');
  }
}
