#!/usr/bin/env node
// Checks the app that `npm run package` built for this Mac: it holds only allowlisted files, its
// Electron fuses are set, and its code signature is intact. CI runs this after every build.
//
// Usage: npm run package:verify

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

// 2. Fuses
const wire = await getCurrentFuseWire(app);
for (const [option, on] of Object.entries(FUSES)) {
  const want = on ? FuseState.ENABLE : FuseState.DISABLE;
  if (wire[option] !== want) problems.push(`fuse ${FuseV1Options[option]} should be ${on ? 'enabled' : 'disabled'}`);
}

// 3. Signature (ad-hoc unless signed for distribution) is intact after the fuses were flipped
try {
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe' });
} catch (err) {
  problems.push(`code signature is broken: ${String(err.stderr || err.message).trim()}`);
}

if (problems.length) {
  console.error(problems.map((p) => `✗ ${p}`).join('\n'));
  process.exit(1);
}
console.log(`✓ ${path.relative(ROOT, app)}: ${count} allowlisted files, fuses set, signature intact`);
