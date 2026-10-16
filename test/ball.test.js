'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseIoregBsdNames, parseMount, detectBall, fatSafeName, writeClips, listBallVideos } = require('../src/lib/ball');

// Trimmed from `ioreg -r -n EVDO-M4 -l -w0` and `mount` on the real ball.
const IOREG = `+-o EVDO-M4@01100000  <class IOUSBHostDevice, id 0x10027a1d1>
  | "idVendor" = 13251
  | +-o IOMedia  <class IOMedia>
  |     "BSD Name" = "disk6"
  |     +-o Untitled 1@1  <class IOMedia>
  |         "BSD Name" = "disk6s1"
`;
const MOUNT = `/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)
/dev/disk4 on /Volumes/NO NAME (msdos, local, nodev, nosuid, noowners, noatime, fskit)
/dev/disk6s1 on /Volumes/NO NAME 1 (msdos, local, nodev, nosuid, noowners, noatime, fskit)
`;

test('parses ioreg BSD names under the ball', () => {
  assert.deepEqual(parseIoregBsdNames(IOREG), ['disk6', 'disk6s1']);
});

test('parses mount lines, including volume names with spaces', () => {
  const m = parseMount(MOUNT);
  assert.equal(m.length, 3);
  assert.deepEqual(m[2], { bsd: 'disk6s1', mountPoint: '/Volumes/NO NAME 1', fsType: 'msdos' });
});

test('detectBall picks the volume on the ball, not the monitor driver disk', async () => {
  const ball = await detectBall({ ioreg: IOREG, mount: MOUNT });
  assert.equal(ball.mounted, true);
  assert.equal(ball.matchedBy, 'usb');
  assert.equal(ball.mountPoint, '/Volumes/NO NAME 1');
});

test('detectBall reports nothing when the ball is absent', async () => {
  const ball = await detectBall({ ioreg: '', mount: '/dev/disk3s1s1 on / (apfs, sealed)\n' });
  assert.deepEqual(ball, { usbSeen: false, mounted: false });
});

test('fatSafeName keeps Unicode but drops characters FAT forbids', () => {
  assert.equal(fatSafeName('星空1.mp4'), '星空1.mp4');
  assert.equal(fatSafeName('IMG_7979 (1).MP4'), 'IMG_7979 (1).mp4');
  assert.equal(fatSafeName('what?: a "clip".mp4'), 'what- a -clip-.mp4');
  assert.equal(fatSafeName('...mp4'), 'clip.mp4');
});

test('writeClips replaces only files inside video/ and leaves no AppleDouble files', async () => {
  const vol = fs.mkdtempSync(path.join(os.tmpdir(), 'ball-'));
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'src-'));
  fs.mkdirSync(path.join(vol, 'video', 'keep-dir'), { recursive: true });
  fs.writeFileSync(path.join(vol, 'video', 'old.mp4'), 'old');
  fs.writeFileSync(path.join(vol, 'video', '._old.mp4'), 'junk');
  fs.writeFileSync(path.join(vol, 'readme.txt'), 'untouched');
  fs.writeFileSync(path.join(src, 'b.mp4'), 'bbbb');
  fs.writeFileSync(path.join(src, 'a.mp4'), 'aa');

  const steps = [];
  const written = await writeClips(vol, [{ path: path.join(src, 'b.mp4'), name: '02-b.mp4' }, { path: path.join(src, 'a.mp4'), name: '01-a.mp4' }], (p) => steps.push(p.step));

  assert.deepEqual(written, [{ name: '02-b.mp4', size: 4 }, { name: '01-a.mp4', size: 2 }]);
  assert.deepEqual(fs.readdirSync(path.join(vol, 'video')).sort(), ['01-a.mp4', '02-b.mp4', 'keep-dir']);
  assert.equal(fs.readFileSync(path.join(vol, 'readme.txt'), 'utf8'), 'untouched');
  assert.deepEqual((await listBallVideos(vol)).map((v) => v.name), ['01-a.mp4', '02-b.mp4']);
  assert.ok(steps.includes('clearing') && steps.at(-1) === 'done');
});
