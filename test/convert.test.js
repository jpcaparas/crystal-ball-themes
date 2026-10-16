'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { buildArgs, frameFilter, kindOf, convert, tools } = require('../src/lib/convert');

const after = (args, flag) => args[args.indexOf(flag) + 1];

test('kindOf sorts inputs', () => {
  assert.equal(kindOf('a.MOV'), 'video');
  assert.equal(kindOf('b.gif'), 'gif');
  assert.equal(kindOf('c.HEIC'), 'image');
});

test('video keeps its own sound and matches the ball format', () => {
  const args = buildArgs({ input: 'in.mov', output: 'out.mp4', info: { kind: 'video', hasAudio: true, duration: 12 } });
  assert.equal(after(args, '-profile:v'), 'baseline');
  assert.equal(after(args, '-level'), '3.0');
  assert.equal(after(args, '-c:a'), 'libmp3lame');
  assert.equal(after(args, '-ar'), '44100');
  assert.ok(args.includes('0:a:0'));
  assert.ok(!args.includes('anullsrc=r=44100:cl=stereo'));
  assert.match(after(args, '-vf'), /crop=480:480/);
  assert.equal(args.at(-1), 'out.mp4');
});

test('silent video gets a silent MP3 track like the factory clips', () => {
  const args = buildArgs({ input: 'in.mp4', output: 'o.mp4', info: { kind: 'video', hasAudio: false, duration: 5 } });
  assert.ok(args.includes('anullsrc=r=44100:cl=stereo'));
  assert.ok(args.includes('1:a:0'));
});

test('fit mode keeps the whole picture inside the circle', () => {
  assert.match(frameFilter('fit'), /scale=340:340.*pad=480:480/);
  assert.match(frameFilter('fit', 960), /scale=680:680.*pad=960:960/);
});

test('pictures become a 10 second zoom, GIFs loop to at least 8 seconds', () => {
  const img = buildArgs({ input: 'p.jpg', output: 'o.mp4', info: { kind: 'image' } });
  assert.match(after(img, '-vf'), /zoompan=.*d=300:s=480x480/);
  assert.equal(after(img, '-t'), '10');
  const gif = buildArgs({ input: 'g.gif', output: 'o.mp4', info: { kind: 'gif', duration: 2, hasAudio: false } });
  assert.equal(after(gif, '-ignore_loop'), '0');
  assert.equal(after(gif, '-t'), '8');
});

test('real conversion produces the ball format', { skip: !tools().ffmpeg && 'ffmpeg not installed' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-'));
  const src = path.join(dir, 'wide.mp4');
  execFileSync(tools().ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=2', '-pix_fmt', 'yuv420p', src]);
  const out = path.join(dir, 'out.mp4');
  let last = 0;
  await convert(src, out, { onProgress: (p) => (last = p) });
  const info = JSON.parse(
    execFileSync(tools().ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', out], { encoding: 'utf8' }),
  );
  const v = info.streams.find((s) => s.codec_type === 'video');
  const a = info.streams.find((s) => s.codec_type === 'audio');
  assert.equal(v.width, 480);
  assert.equal(v.height, 480);
  assert.equal(v.profile, 'Constrained Baseline');
  assert.equal(v.r_frame_rate, '30/1');
  assert.equal(a.codec_name, 'mp3');
  assert.equal(Number(a.sample_rate), 44100);
  assert.equal(last, 1);
});
