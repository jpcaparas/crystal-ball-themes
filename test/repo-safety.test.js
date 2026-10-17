'use strict';

// This repository is public. These checks run with `npm test` and in CI over every file git would
// publish (tracked files plus new files that aren't ignored), and fail before a secret, personal
// data or a generated media file gets committed. See SECURITY.md and .agents/skills/public-repo-safety/.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

let files = null;
try {
  if (git('rev-parse', '--show-toplevel').trim() === fs.realpathSync(ROOT)) {
    files = git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter((f) => f && fs.existsSync(path.join(ROOT, f)));
  }
} catch {
  // not a git checkout (e.g. a downloaded zip): nothing is about to be published from here
}
const skip = files ? false : 'not a git checkout';

// The only binary files allowed in git: README screenshots and the app icon.
const ALLOWED_BINARIES = new Set(['docs/screenshot.png', 'docs/preview.png', 'assets/icon/icon.png', 'assets/icon/icon.icns']);
const BINARY_EXT = /\.(png|jpe?g|webp|gif|heic|icns|ico|bmp|tiff?|mp4|m4v|mov|webm|mkv|avi|flac|wav|mp3|m4a|ogg|aiff?|zip|gz|dmg|pkg|bin|img|iso)$/i;
const MAX_BYTES = 1_000_000;
const AUTHOR_EMAILS = new Set(['jp@jpcaparas.com']);

const SECRET_FILES = [
  /(^|\/)\.env(\.(?!example$)[^/]*)?$/, // .env, .env.local... (only .env.example is allowed)
  /\.(pem|key|p12|pfx|keystore|jks|mobileprovision|provisionprofile)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /(^|\/)(credentials|service[-_]?account[^/]*|client_secret[^/]*)\.json$/i,
  /(^|\/)\.npmrc$/,
];
const SECRET_TEXT = [
  ['a Google/Gemini API key', /AIza[0-9A-Za-z_-]{35}/],
  ['an OpenAI/Anthropic-style key', /\bsk-(ant-|proj-)?[A-Za-z0-9_-]{20,}/],
  ['a GitHub token', /\b(gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{40,})/],
  ['a Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['an AWS access key', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['an API key value', /\b[A-Z][A-Z0-9_]*(API_KEY|TOKEN|SECRET)\s*[=:]\s*['"]?[A-Za-z0-9_\-./+]{16,}/],
];
const PERSONAL_TEXT = [
  ['a home folder path (use ~ instead)', /(\/Users\/(?!Shared\/)[^/\s'"`)]+\/|\/home\/[a-z][^/\s'"`)]*\/|[A-Z]:\\Users\\)/],
];
// Instruction files for one particular agent harness; this repo keeps a single AGENTS.md for all of them.
const HARNESS_FILES = /^(CLAUDE\.md|GEMINI\.md|\.claude\/|\.cursor\/|\.cursorrules|\.windsurf\/|\.codex\/|\.github\/copilot-instructions\.md)/;

const textFiles = () =>
  (files || []).filter((f) => !BINARY_EXT.test(f)).map((f) => ({ f, text: fs.readFileSync(path.join(ROOT, f), 'utf8') })).filter(({ text }) => !text.includes('\0'));

test('no generated media is committed (it is made locally; see docs/media.md)', { skip }, () => {
  const media = files.filter((f) => f.startsWith('assets/sources/') || (BINARY_EXT.test(f) && !ALLOWED_BINARIES.has(f)));
  assert.deepEqual(media, [], 'generated pictures, voices and videos stay out of git');
});

test('no file is large enough to be a blob', { skip }, () => {
  const big = files.filter((f) => fs.statSync(path.join(ROOT, f)).size > MAX_BYTES);
  assert.deepEqual(big, [], `files over ${MAX_BYTES / 1e6} MB`);
});

test('no secret files are committed', { skip }, () => {
  assert.deepEqual(files.filter((f) => SECRET_FILES.some((re) => re.test(f))), []);
});

test('no secrets, keys or tokens appear in any text file', { skip }, () => {
  const hits = [];
  for (const { f, text } of textFiles()) {
    for (const [what, re] of SECRET_TEXT) if (re.test(text)) hits.push(`${f}: looks like ${what}`);
  }
  assert.deepEqual(hits, []);
});

test('no personal data: home folder paths or unknown email addresses', { skip }, () => {
  const hits = [];
  for (const { f, text } of textFiles()) {
    for (const [what, re] of PERSONAL_TEXT) if (re.test(text)) hits.push(`${f}: ${what}`);
    for (const email of text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g) || []) {
      if (!AUTHOR_EMAILS.has(email) && !/@(example\.(com|org)|users\.noreply\.github\.com)$/.test(email)) hits.push(`${f}: email ${email}`);
    }
  }
  assert.deepEqual(hits, []);
});

test('instructions stay harness-neutral (one AGENTS.md, no per-tool files)', { skip }, () => {
  assert.deepEqual(files.filter((f) => HARNESS_FILES.test(f)), []);
  assert.ok(files.includes('AGENTS.md'));
});

test('git ignores keys, generated media, renders and build output', { skip }, () => {
  for (const p of ['.env', '.env.local', 'assets/sources/x/art/head.jpg', 'assets/themes/x/01-a.mp4', 'dist/a', 'node_modules/a']) {
    assert.doesNotThrow(() => git('check-ignore', '-q', '--no-index', p), `${p} should be git-ignored`);
  }
  assert.throws(() => git('check-ignore', '-q', '--no-index', '.env.example'), '.env.example must not be ignored');
});
