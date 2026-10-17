# Security

Crystal Ball Themes is a small, offline desktop app for a toy. It still deserves care: it runs on a
family's Mac, copies files onto a USB device, and its theme tools can hold an API key.

## Reporting a problem

Please **don't open a public issue** for a security problem. Report it privately with GitHub's
private vulnerability reporting:
**[Report a vulnerability](https://github.com/jpcaparas/crystal-ball-themes/security/advisories/new)**
(or the repository's **Security** tab → **Report a vulnerability**).

Include what you found, how to reproduce it, and what it affects. Then, with coordinated disclosure:

1. You'll get a reply within **7 days** confirming the report.
2. We'll agree on how serious it is and when a fix is expected, usually within **30 days**.
3. The fix lands on `main`, and a security advisory is published, crediting you if you'd like.
4. Please keep the details private until then, or for **90 days** after your report, whichever
   comes first.

Only the latest code on the `main` branch is supported.

## What the app does and doesn't do

| It does | It never does |
| --- | --- |
| Read and write MP4 files in the `video/` folder of the ball's USB storage | Write the ball's firmware or any other part of the device |
| Save any videos it doesn't recognise before replacing them | Delete the family's videos outright (removed themes and clips go to the Bin) |
| Run `ffmpeg`, `ioreg`, `mount` and `diskutil eject` locally | Talk to the internet. The desktop app makes no network requests at all |
| Keep the family's own themes in `~/Library/Application Support/Crystal Ball Themes/` | Put the family's videos or themes in this repository |

Only the theme tools in `tools/` use the network, and only when you run them yourself with a Gemini
API key to make new pictures and voices (see [docs/media.md](docs/media.md)).

## How the app is locked down

- **Renderers are sandboxed**: context isolation, no Node.js, a strict Content Security Policy (no
  remote scripts, styles, fonts or connections), and a small, fixed `window.ballApi` bridge.
- **IPC only answers the app's own pages.** Every request is checked against the page that sent it,
  and file paths from the page are checked before use (absolute, an existing file, a known media type).
- **No navigation, pop-ups or webviews**, in any window, ever. All permission requests (camera,
  microphone, notifications...) are refused.
- **The packaged app holds only an allowlist** of files: the source, the theme files and clips, and
  the licence. Nothing else in your folder (`.env`, notes, generated media) can end up inside it.
- **Electron fuses are set** so the app can't be reused as a Node.js runtime (`ELECTRON_RUN_AS_NODE`,
  `NODE_OPTIONS` and `--inspect` are all disabled).
- **Screenshot flags only work from source** (`npm start`), never in the packaged app.

## Keys and personal data

- API keys live in `.env` (git-ignored; copy `.env.example`) or the `GEMINI_API_KEY` environment
  variable. Never commit, paste, log or screenshot one. The key is sent only in a request header to
  Google's API, never in a URL.
- If a key is ever exposed, **revoke it first** in Google AI Studio, then make a new one. Deleting
  the commit is not enough: forks and caches keep it.
- `npm test` fails if a key, token, private key, home-folder path, unknown email address or
  generated media file is about to be committed (`test/repo-safety.test.js`), and CI scans the
  full history with gitleaks.

## Supply chain

- npm packages are locked in `package-lock.json` and installed with `npm ci`. CI also runs
  `npm audit` and checks registry signatures.
- Python packages are pinned exactly in `tools/requirements.txt`.
- Every GitHub Action is pinned to a full commit SHA. Workflows get read-only tokens by default and
  are checked by actionlint, zizmor and CodeQL.
- Dependabot proposes updates weekly, after a cooldown, so brand-new releases have time to settle.
