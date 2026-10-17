#!/usr/bin/env node
// Checks the app that `npm run package` built for this Mac: it holds only allowlisted files, its
// Electron fuses are set, any bundled ffmpeg works and needs nothing macOS doesn't ship, and its
// code signature is intact. CI runs this after every build.
//
// Usage: npm run package:verify [-- --require-ffmpeg]   (releases require the bundled ffmpeg)

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getCurrentFuseWire, FuseState, FuseV1Options } from '@electron/fuses';
import { FUSES, shipped } from './package.mjs';
import { ROOT } from './media_plan.mjs';

const app = path.join(ROOT, 'dist', `Crystal Ball Themes-darwin-${process.arch}`, 'Crystal Ball Themes.app');
const problems = [];

if (!fs.existsSync(app)) {
  console.error(`No app at ${path.relative(ROOT, app)}. Run \`npm run package\` first.`);
  process.exit(1);
}

// 1. Only allowlisted files
const resources = path.join(app, 'Contents', 'Resources', 'app');
let count = 0;
for (const entry of fs.readdirSync(resources, { recursive: true, withFileTypes: true })) {
  const full = path.join(entry.parentPath, entry.name);
  const name = `/${path.relative(resources, full).split(path.sep).join('/')}`;
  count++;
  if (!shipped(name)) problems.push(`unexpected file in the app: ${name}`);
  if (/(^|\/)\.env/.test(name)) problems.push(`a .env file is inside the app: ${name}`);
}
for (const must of ['/package.json', '/src/main/main.js', '/src/main/preload.js', '/src/renderer/index.html']) {
  if (!fs.existsSync(path.join(resources, must))) problems.push(`missing from the app: ${must}`);
}

// 2. The bundled ffmpeg (Contents/Resources/ffmpeg), if any
const ffmpegDir = path.join(app, 'Contents', 'Resources', 'ffmpeg');
const hasFfmpeg = fs.existsSync(ffmpegDir);
if (!hasFfmpeg && process.argv.includes('--require-ffmpeg')) problems.push('no bundled ffmpeg: run tools/build_ffmpeg.sh first');
if (hasFfmpeg) {
  for (const f of ['ffmpeg', 'ffprobe', 'LICENSE.txt', 'SOURCES.txt']) {
    if (!fs.existsSync(path.join(ffmpegDir, f))) problems.push(`bundled ffmpeg folder is missing ${f}`);
  }
  try {
    const encoders = execFileSync(path.join(ffmpegDir, 'ffmpeg'), ['-hide_banner', '-encoders'], { encoding: 'utf8' });
    if (!encoders.includes('libx264') || !encoders.includes('libmp3lame')) problems.push('bundled ffmpeg lacks libx264 or libmp3lame');
    execFileSync(path.join(ffmpegDir, 'ffprobe'), ['-hide_banner', '-version'], { stdio: 'pipe' });
    // the silent audio track the app adds to photos, GIFs and silent videos
    execFileSync(path.join(ffmpegDir, 'ffmpeg'), ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '0.1', '-f', 'null', '-'], { stdio: 'pipe' });
    for (const tool of ['ffmpeg', 'ffprobe']) {
      const libs = execFileSync('otool', ['-L', path.join(ffmpegDir, tool)], { encoding: 'utf8' }).split('\n').slice(1);
      const foreign = libs.map((l) => l.trim()).filter((l) => l && !/^(\/usr\/lib\/|\/System\/Library\/)/.test(l));
      if (foreign.length) problems.push(`bundled ${tool} needs libraries macOS doesn't ship: ${foreign.join(', ')}`);
    }
  } catch (err) {
    problems.push(`bundled ffmpeg doesn't run: ${String(err.stderr || err.message).trim()}`);
  }
}

// 3. Fuses
const wire = await getCurrentFuseWire(app);
for (const [option, on] of Object.entries(FUSES)) {
  const want = on ? FuseState.ENABLE : FuseState.DISABLE;
  if (wire[option] !== want) problems.push(`fuse ${FuseV1Options[option]} should be ${on ? 'enabled' : 'disabled'}`);
}

// 4. Signature (ad-hoc unless signed for distribution) is intact after the fuses were flipped
try {
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe' });
} catch (err) {
  problems.push(`code signature is broken: ${String(err.stderr || err.message).trim()}`);
}

if (problems.length) {
  console.error(problems.map((p) => `✗ ${p}`).join('\n'));
  process.exit(1);
}
console.log(`✓ ${path.relative(ROOT, app)}: ${count} allowlisted files, ${hasFfmpeg ? 'working bundled ffmpeg, ' : ''}fuses set, signature intact`);
