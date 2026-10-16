#!/usr/bin/env node
// Checks that this machine can build, run and extend the project, and says how to fix anything missing.
// Usage: npm run doctor        (exit code 1 if something required is missing)

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { tools } = require('../src/lib/convert.js');
const { detectBall } = require('../src/lib/ball.js');

const results = [];
const check = (required, ok, label, fix) => results.push({ required, ok, label, fix });
const run = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
};
const which = (name) => run('/usr/bin/which', [name])?.trim() || null;

// Platform: ball detection uses macOS tools (ioreg, mount, diskutil).
check(true, process.platform === 'darwin', 'macOS (the app talks to the ball with macOS tools)', 'Run this on a Mac.');

// Node
const [maj, min] = process.versions.node.split('.').map(Number);
check(true, maj > 22 || (maj === 22 && min >= 19), `Node.js 22.19 or newer (found ${process.versions.node})`,
  'Install Node 22: `nvm install 22 && nvm use` or `brew install node@22`.');
check(true, fs.existsSync(path.join(root, 'node_modules', 'electron')), 'npm packages installed', 'Run `npm install`.');

// ffmpeg
const { ffmpeg, ffprobe } = tools();
check(true, Boolean(ffmpeg && ffprobe), 'ffmpeg and ffprobe', 'Run `brew install ffmpeg`.');
if (ffmpeg) {
  const enc = run(ffmpeg, ['-hide_banner', '-encoders']) || '';
  check(true, enc.includes('libx264') && enc.includes('libmp3lame'), 'ffmpeg has the H.264 (libx264) and MP3 (libmp3lame) encoders',
    'Reinstall a full build: `brew reinstall ffmpeg`.');
}

// Theme tools
check(false, Boolean(which('uv')), 'uv (runs the Python theme tools)', 'Run `brew install uv`. Only needed to make or re-render themes.');
check(false, fs.existsSync('/System/Library/Fonts/Supplemental/ChalkboardSE.ttc'), 'Chalkboard SE font (used in theme captions)',
  'Comes with macOS. Only needed to make or re-render themes.');

// Rendered built-in themes
const themesDir = path.join(root, 'assets', 'themes');
for (const id of fs.existsSync(themesDir) ? fs.readdirSync(themesDir).sort() : []) {
  if (!fs.statSync(path.join(themesDir, id)).isDirectory()) continue;
  const clips = fs.readdirSync(path.join(themesDir, id)).filter((f) => f.endsWith('.mp4')).length;
  check(true, clips > 0, `built-in theme "${id}" is rendered (${clips} clips)`,
    'Run `npm run themes` (uses saved art and voices; no API key needed).');
}

// Gemini key (optional)
const envFile = path.join(root, '.env');
const keyInEnvFile = fs.existsSync(envFile) && /^\s*(export\s+)?GEMINI_API_KEY\s*=\s*['"]?[^'"\s]+/m.test(fs.readFileSync(envFile, 'utf8'));
const keyFile = process.env.GEMINI_API_KEY_FILE;
const hasKey = Boolean(process.env.GEMINI_API_KEY) || (keyFile && fs.existsSync(keyFile)) || keyInEnvFile;
check(false, hasKey, 'Gemini API key (only to make new art or voices)',
  'Put `GEMINI_API_KEY=...` in a `.env` file in the repo folder. It is git-ignored. See docs/themes.md.');

// The ball (informational)
const ball = await detectBall().catch(() => ({ mounted: false }));
check(false, ball.mounted, ball.mounted ? `crystal ball connected at ${ball.mountPoint}` : 'crystal ball connected',
  'Optional. Turn it off, plug it in, hold the middle button until the USB icon shows.');

let failed = 0;
for (const r of results) {
  const mark = r.ok ? '✓' : r.required ? '✗' : '–';
  console.log(`${mark} ${r.label}`);
  if (!r.ok) {
    console.log(`    ${r.fix}`);
    if (r.required) failed++;
  }
}
console.log(failed ? `\n${failed} required item(s) missing.` : '\nAll required items are present.');
process.exit(failed ? 1 : 0);
