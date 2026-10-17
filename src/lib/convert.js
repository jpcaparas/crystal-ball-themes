'use strict';

// Turn any video, GIF or picture into the exact format the ball's stock player uses
// (matched to the factory demo clips):
//   480x480, H.264 Constrained Baseline level 3.0, yuv420p, 30 fps,
//   MP3 128 kbps, 44.1 kHz stereo, MP4 container.

const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');

const SIZE = 480;
// The screen is a circle: the largest square that fits inside it is ~340 px.
const INSCRIBED = 340;
const IMAGE_SECONDS = 10;
const GIF_MIN_SECONDS = 8;

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff', '.heic', '.heif']);
const GIF_EXT = new Set(['.gif']);

const CANDIDATE_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];

/** Where the packaged app keeps the ffmpeg it ships with (tools/build_ffmpeg.sh), if it has one. */
function bundledToolsDir(resourcesPath = process.resourcesPath) {
  return resourcesPath ? path.join(resourcesPath, 'ffmpeg') : null;
}

/**
 * An explicit FFMPEG_PATH/FFPROBE_PATH wins, then the copy bundled with the app, then Homebrew and
 * PATH (apps launched from Finder get a bare PATH, so the usual Homebrew places are listed too).
 */
function findTool(name, { bundledDir = bundledToolsDir() } = {}) {
  const env = process.env[`${name.toUpperCase()}_PATH`];
  if (env && fs.existsSync(env)) return env;
  const dirs = [bundledDir, ...CANDIDATE_DIRS, ...(process.env.PATH || '').split(path.delimiter)];
  for (const d of dirs) {
    if (!d) continue;
    const p = path.join(d, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function tools() {
  return { ffmpeg: findTool('ffmpeg'), ffprobe: findTool('ffprobe') };
}

function execJson(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024, timeout: 60000 }, (err, stdout) =>
      err ? reject(err) : resolve(JSON.parse(stdout)),
    );
  });
}

function kindOf(file) {
  const ext = path.extname(file).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (GIF_EXT.has(ext)) return 'gif';
  return 'video';
}

async function probe(file, ffprobe = tools().ffprobe) {
  const kind = kindOf(file);
  if (!ffprobe || kind === 'image') return { kind, duration: null, hasAudio: false };
  const info = await execJson(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]);
  const streams = info.streams || [];
  const duration = Number(info.format?.duration) || null;
  return {
    kind,
    duration,
    hasAudio: streams.some((s) => s.codec_type === 'audio'),
    hasVideo: streams.some((s) => s.codec_type === 'video'),
  };
}

/**
 * fill: cover the whole circle (edges of wide videos are cropped).
 * fit:  shrink so the whole picture sits inside the circle, on black.
 */
function frameFilter(fit, size = SIZE) {
  if (fit === 'fit') {
    const inner = Math.round((size * INSCRIBED) / SIZE);
    return (
      `scale=${inner}:${inner}:force_original_aspect_ratio=decrease,` +
      `pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`
    );
  }
  return `scale=${size}:${size}:force_original_aspect_ratio=increase,crop=${size}:${size},setsar=1`;
}

const VIDEO_OUT = [
  '-c:v', 'libx264', '-profile:v', 'baseline', '-level', '3.0', '-pix_fmt', 'yuv420p',
  '-preset', 'medium', '-b:v', '1800k', '-maxrate', '2500k', '-bufsize', '4000k', '-g', '60', '-r', '30',
];
const AUDIO_OUT = ['-c:a', 'libmp3lame', '-b:a', '128k', '-ar', '44100', '-ac', '2'];
const SILENCE = ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo'];

/** Build the ffmpeg argument list. Pure, so it can be unit tested. */
function buildArgs({ input, output, info, fit = 'fill' }) {
  const head = ['-y', '-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1'];
  const tail = [...VIDEO_OUT, ...AUDIO_OUT, '-shortest', '-map_metadata', '-1', output];

  if (info.kind === 'image') {
    // One still frame becomes a slow 10 s zoom so it doesn't look frozen.
    const frames = IMAGE_SECONDS * 30;
    const zoom =
      `zoompan=z='min(zoom+0.0005,1.15)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'` +
      `:d=${frames}:s=${SIZE}x${SIZE}:fps=30`;
    return [
      ...head, '-i', input, ...SILENCE,
      '-map', '0:v:0', '-map', '1:a:0',
      '-vf', `${frameFilter(fit, SIZE * 2)},${zoom},format=yuv420p`,
      '-t', String(IMAGE_SECONDS), ...tail,
    ];
  }

  const loopGif = info.kind === 'gif';
  const seconds = loopGif ? Math.max(GIF_MIN_SECONDS, Math.min(info.duration || GIF_MIN_SECONDS, 30)) : null;
  const inputArgs = loopGif ? ['-ignore_loop', '0', '-t', String(seconds), '-i', input] : ['-i', input];
  const audio = info.hasAudio ? [] : SILENCE;
  return [
    ...head, ...inputArgs, ...audio,
    '-map', '0:v:0', '-map', info.hasAudio ? '0:a:0' : '1:a:0',
    '-vf', `${frameFilter(fit)},fps=30,format=yuv420p`,
    ...(seconds ? ['-t', String(seconds)] : []),
    ...tail,
  ];
}

/** HEIC photos (iPhone) go through macOS `sips` first; ffmpeg builds often can't decode them. */
async function prepareInput(input) {
  const ext = path.extname(input).toLowerCase();
  if (ext !== '.heic' && ext !== '.heif') return { file: input, cleanup: async () => {} };
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'crystal-ball-'));
  const out = path.join(dir, 'photo.jpg');
  await new Promise((resolve, reject) =>
    execFile('/usr/bin/sips', ['-s', 'format', 'jpeg', input, '--out', out], (err) => (err ? reject(err) : resolve())),
  );
  return { file: out, cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
}

function requireFfmpeg() {
  const t = tools();
  if (!t.ffmpeg) throw new Error('ffmpeg is not installed. Install it with: brew install ffmpeg');
  return t;
}

/** Run ffmpeg with `-progress pipe:1`, reporting 0..1 against `total` seconds. */
function runFfmpeg(ffmpeg, args, { total, label, onProgress = () => {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stdout.on('data', (buf) => {
      const m = String(buf).match(/out_time_us=(\d+)/g);
      if (m && total) onProgress(Math.min(1, Number(m.at(-1).split('=')[1]) / 1e6 / total));
    });
    child.stderr.on('data', (buf) => (err += buf));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`Couldn't ${label}: ${err.trim().split('\n').at(-1) || code}`)),
    );
  });
}

/** Convert one file. onProgress receives 0..1. */
async function convert(input, output, { fit = 'fill', onProgress = () => {} } = {}) {
  const { ffmpeg, ffprobe } = requireFfmpeg();
  const prepared = await prepareInput(input);
  try {
    const info = await probe(prepared.file, ffprobe);
    if (info.kind === 'video' && info.hasVideo === false) throw new Error(`${path.basename(input)} has no picture.`);
    const total = info.kind === 'image' ? IMAGE_SECONDS : info.kind === 'gif' ? GIF_MIN_SECONDS : info.duration;
    const args = buildArgs({ input: prepared.file, output, info, fit });
    await runFfmpeg(ffmpeg, args, { total, label: `convert ${path.basename(input)}`, onProgress });
    onProgress(1);
    return info;
  } catch (e) {
    await fsp.rm(output, { force: true });
    throw e;
  } finally {
    await prepared.cleanup();
  }
}

/**
 * Join clips into one file. The ball repeats whichever file it is playing instead of moving on,
 * so a theme's clips joined together is the only way to show them all without pressing buttons.
 * Inputs are re-encoded (not stream-copied) so clips from different sources still join cleanly.
 * `inputs` is [{ path, hasAudio, duration }].
 */
function buildMedleyArgs(inputs, output) {
  const head = ['-y', '-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1'];
  const parts = inputs.map((inp, i) => {
    const video = `[${i}:v:0]${frameFilter('fill')},fps=30,format=yuv420p[v${i}]`;
    const audio = inp.hasAudio
      ? `[${i}:a:0]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`
      : `aevalsrc=0:s=44100:c=stereo:d=${(inp.duration || 1).toFixed(3)}[a${i}]`;
    return `${video};${audio}`;
  });
  const chain = inputs.map((_, i) => `[v${i}][a${i}]`).join('');
  return [
    ...head,
    ...inputs.flatMap((inp) => ['-i', inp.path]),
    '-filter_complex', `${parts.join(';')};${chain}concat=n=${inputs.length}:v=1:a=1[v][a]`,
    '-map', '[v]', '-map', '[a]',
    ...VIDEO_OUT, ...AUDIO_OUT, '-map_metadata', '-1', output,
  ];
}

async function makeMedley(paths, output, { onProgress = () => {} } = {}) {
  const { ffmpeg, ffprobe } = requireFfmpeg();
  const inputs = [];
  for (const p of paths) inputs.push({ path: p, ...(await probe(p, ffprobe)) });
  const total = inputs.reduce((n, i) => n + (i.duration || 0), 0);
  try {
    await runFfmpeg(ffmpeg, buildMedleyArgs(inputs, output), { total, label: 'join the clips', onProgress });
  } catch (e) {
    await fsp.rm(output, { force: true });
    throw e;
  }
  onProgress(1);
  return { duration: total };
}

module.exports = {
  SIZE,
  INSCRIBED,
  IMAGE_SECONDS,
  tools,
  findTool,
  bundledToolsDir,
  kindOf,
  probe,
  frameFilter,
  buildArgs,
  convert,
  buildMedleyArgs,
  makeMedley,
};
