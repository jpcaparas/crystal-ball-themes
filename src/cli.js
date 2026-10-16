#!/usr/bin/env node
'use strict';

// Same operations as the app, from the terminal:
//   npm run ball -- status
//   npm run ball -- themes
//   npm run ball -- apply builtin/halloween
//   npm run ball -- add user/nightmare-before-christmas ~/Movies/clip.mp4 [--fit]
//   npm run ball -- eject

const { dataDir, bundledThemesDir } = require('./lib/paths');
const { detectBall, listBallVideos, eject } = require('./lib/ball');
const { ThemeStore } = require('./lib/themes');
const { applyTheme, whatsOnBall } = require('./lib/apply');

const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;

async function requireBall() {
  const ball = await detectBall();
  if (!ball.mounted) {
    throw new Error(
      ball.usbSeen
        ? 'The ball is plugged in but its storage is not mounted yet.'
        : 'No ball found. Turn it off, plug it in, then hold the middle button until the USB icon shows.',
    );
  }
  return ball;
}

async function main([cmd = 'status', ...args]) {
  const store = await new ThemeStore({ dataDir: dataDir(), bundledDir: bundledThemesDir() }).init();

  if (cmd === 'themes') {
    for (const t of await store.list()) console.log(`${t.emoji} ${t.id.padEnd(40)} ${t.name} (${t.clips.length} clips, ${mb(t.bytes)})`);
    return;
  }
  if (cmd === 'status') {
    const ball = await detectBall();
    if (!ball.mounted) return console.log(ball.usbSeen ? 'Ball plugged in, storage not mounted.' : 'No ball connected.');
    console.log(`Ball at ${ball.mountPoint} (${mb(ball.free)} free of ${mb(ball.total)}, matched by ${ball.matchedBy})`);
    for (const v of await listBallVideos(ball.mountPoint)) console.log(`  ${v.name}  ${mb(v.size)}`);
    const on = await whatsOnBall(store, ball.mountPoint);
    const theme = on.themeId && (await store.load(on.themeId));
    console.log(theme ? `Showing: ${theme.emoji} ${theme.name}` : `Showing: ${on.count} clips not saved in any theme yet`);
    return;
  }
  if (cmd === 'apply') {
    const ball = await requireBall();
    let last = '';
    const res = await applyTheme(store, args[0], ball.mountPoint, (p) => {
      if (p.step === 'copying') console.log(`  copying ${p.index + 1}/${p.total} ${p.name}`);
      else if (p.step !== last) console.log(`  ${p.step}`);
      last = p.step;
    });
    if (res.saved) console.log(`Saved ${res.saved.count} clips that were on the ball as "${res.saved.name}".`);
    if (res.warning) console.log(res.warning);
    console.log(
      `Done: ${res.count} clips from "${res.name}" are on the ball${res.playAll ? ', plus a "play all" video first' : ''}.` +
        ' Run "npm run ball -- eject" before unplugging.',
    );
    return;
  }
  if (cmd === 'add') {
    const [id, ...files] = args.filter((a) => !a.startsWith('--'));
    const fit = args.includes('--fit') ? 'fit' : 'fill';
    for (const f of files) {
      process.stdout.write(`  converting ${f} `);
      await store.addClip(id, f, { fit, onProgress: () => process.stdout.write('.') });
      process.stdout.write(' ok\n');
    }
    return;
  }
  if (cmd === 'eject') {
    const ball = await requireBall();
    const res = await eject(ball.mountPoint);
    console.log(res.ok ? 'Ejected. You can unplug the ball.' : `Eject failed: ${res.error}`);
    return;
  }
  throw new Error(`Unknown command "${cmd}". Try: status, themes, apply <id>, add <id> <files...>, eject`);
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
