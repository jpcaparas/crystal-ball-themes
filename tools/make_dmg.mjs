#!/usr/bin/env node
// Wraps the app that `npm run package` built into a disk image people can download: open it, drag
// the app onto Applications. A short note inside explains the one-time "Open Anyway" step macOS asks
// for, because the app isn't registered with Apple.
//
// Output: dist/Crystal-Ball-Themes-mac-<apple-silicon|intel>.dmg
// Usage:  npm run dmg

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './media_plan.mjs';

const LABEL = { arm64: 'apple-silicon', x64: 'intel' };
export const dmgName = (arch = process.arch) => `Crystal-Ball-Themes-mac-${LABEL[arch]}.dmg`;

const README = `Opening Crystal Ball Themes for the first time
==============================================

1. Drag "Crystal Ball Themes" onto the Applications folder next to it.
2. Open Applications and double-click Crystal Ball Themes.
3. If macOS says it can't check the app for malicious software, click Done.
4. Open System Settings > Privacy & Security. Scroll down to Security and
   click "Open Anyway" next to Crystal Ball Themes. Confirm with your
   password or Touch ID, then click Open.

You only do this once. macOS asks because the app isn't registered with
Apple, which costs a yearly fee. It's free and open source, and every copy
is built in public by GitHub from the code at:
https://github.com/jpcaparas/crystal-ball-themes

Then plug in the ball: turn it off, plug it into the Mac, and hold the
middle button until a USB picture shows on the ball.
`;

export function makeDmg(arch = process.arch) {
  const app = path.join(ROOT, 'dist', `Crystal Ball Themes-darwin-${arch}`, 'Crystal Ball Themes.app');
  if (!fs.existsSync(app)) throw new Error(`No app at ${path.relative(ROOT, app)}. Run \`npm run package\` first.`);
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'cbt-dmg-'));
  try {
    execFileSync('ditto', [app, path.join(stage, 'Crystal Ball Themes.app')]); // keeps the signature intact
    fs.symlinkSync('/Applications', path.join(stage, 'Applications'));
    fs.writeFileSync(path.join(stage, 'Read me first.txt'), README);
    const out = path.join(ROOT, 'dist', dmgName(arch));
    execFileSync('hdiutil', ['create', '-volname', 'Crystal Ball Themes', '-srcfolder', stage, '-fs', 'HFS+', '-format', 'UDZO', '-ov', out], {
      stdio: 'pipe',
    });
    return out;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = makeDmg();
  console.log(`Built ${path.relative(ROOT, out)} (${(fs.statSync(out).size / 1e6).toFixed(0)} MB)`);
}
