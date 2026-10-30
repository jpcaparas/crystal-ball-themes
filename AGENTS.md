# AGENTS.md

Instructions for any coding agent working in this repository. Humans: the same information, in a
friendlier order, is in [CONTRIBUTING.md](CONTRIBUTING.md).

**This repository is public.** Everything you commit, and every commit message, PR text, CI log
and screenshot, is published for good. Read [Public repository: security and privacy](#public-repository-security-and-privacy)
before your first change, and use the skill in `.agents/skills/public-repo-safety/` whenever its
description matches what you're doing.

## What this project is

A macOS Electron app (plus a CLI) that puts themed MP4 sets on a USB "electronic crystal ball"
(product string `EVDO-M4`, vendor ID `0x33C3`) using the ball's **stock firmware**. The ball is a
FAT32 USB drive whose player loops the MP4s in its top-level `video/` folder.

The users are a family, mostly children. Keep the UI simple, friendly, and hard to get wrong.

Read before changing behaviour:

| Doc | Read it for |
| --- | --- |
| [README.md](README.md) | What the app does, from the user's side |
| [docs/architecture.md](docs/architecture.md) | How the code fits together, the IPC API, data locations |
| [docs/themes.md](docs/themes.md) | The clip format, theme script formats, and theme tools |
| [docs/media.md](docs/media.md) | Making a theme's pictures and voices with any model (they're not in git) |
| [docs/releasing.md](docs/releasing.md) | How releases are built and published, and the bundled ffmpeg |
| [docs/hardware.md](docs/hardware.md) | Everything known about the device, and the firmware research |
| [SECURITY.md](SECURITY.md) | How the app is locked down, and how to report a problem |

## Environment

- macOS only (ball detection uses `ioreg`, `mount`, `diskutil`).
- Node.js 22.19 or newer (`.nvmrc` says 22). If `node --version` is older, switch Node before
  running anything.
- ffmpeg and ffprobe with libx264 and libmp3lame; uv for the Python tools.
- Run `npm run doctor` first. It checks all of the above and prints the fix for anything missing.
- Rendered MP4s and generated media are not in git. `npm run themes` renders Halloween (drawn by
  code) and every voiced theme whose pictures and voices exist in `assets/sources/`, and skips the
  rest with a note. `npm run media:plan` shows what's missing. See [docs/media.md](docs/media.md).

## Verify your work

Run these from fastest to slowest. All must pass before you call a change done.

| Command | Checks | Time |
| --- | --- | --- |
| `npm run doctor` | The machine has what the project needs | Seconds |
| `npm run lint` | Python lint with security rules (ruff), JS syntax | Seconds |
| `npm test` | `src/lib` logic with real ffmpeg conversions, theme scripts and the media plan, and the repo safety checks | Seconds |
| `npm run test:tools` | Each theme tool renders a clip in the ball's exact format (draft mode, no API) | ~4 minutes |
| `npx electron . --screenshot=dist/x.png --wait=4000` | The window renders; open the PNG and look at it | Seconds |
| `npm run package && npm run package:verify` | The app builds from the allowlist, with fuses set and a valid signature | ~1 minute |
| `npm run check:public` | Before any push: the working tree **and the whole history** are safe to publish | Seconds |

CI (`.github/workflows/`) runs all of these on Linux and on Apple silicon and Intel Macs, plus
gitleaks, CodeQL, dependency review, actionlint, zizmor and OpenSSF Scorecard.

Screenshot variants: add `--open=<theme id>` for a theme sheet, or `--preview=<theme id>` for the
floating desktop preview. Prefix with `CRYSTAL_BALL_DATA_DIR=$(mktemp -d)` to use throwaway data.

Never test against the user's real data folder (`~/Library/Application Support/Crystal Ball Themes/`)
or a connected ball unless the user asks you to.

## Hard rules

These protect the family's videos and the hardware. Do not work around them.

1. **Never lose what's on the ball.** Every write to the ball goes through `applyTheme`
   (`src/lib/apply.js`), which saves unknown files as a "Saved from ball" theme first. Don't add a
   write path that skips it.
2. **Only touch regular files inside the ball's `video/` folder.** Never rename or delete the folder,
   and never touch other files on the volume.
3. **Copy to the ball with `plainCopy`** (streams + fsync). `fs.copyFile`, `cp` and Finder carry
   extended attributes that FAT stores as `._*` files, which the ball tries to play.
4. **Never run `diskutil info` on the ball; it hangs.** Use `ioreg` + `mount` (see `detectBall`).
   `diskutil eject` is fine.
5. **Match the clip format exactly:** 480×480 H.264 Constrained Baseline level 3.0, yuv420p, 30 fps,
   MP3 128 kb/s 44.1 kHz stereo, always with an audio track. See `src/lib/convert.js`.
6. **Themes with 2+ clips go on the ball as their joined play-all video alone**
   (`00-<slug>-all.mp4`, `src/lib/medley.js`), because the ball repeats the current file and
   doesn't always start on the first one. Don't put single clips beside it.
7. **Delete user content with the Bin** (`shell.trashItem`), never permanently.
8. **Don't write the ball's firmware** unless the user explicitly asks. A bad write bricks the toy.
   Reading is fine; see `docs/hardware.md`.

## Public repository: security and privacy

The details and checklists are in [.agents/skills/public-repo-safety/SKILL.md](.agents/skills/public-repo-safety/SKILL.md).

1. **Secrets.** The Gemini key comes from `GEMINI_API_KEY`, a file named by `GEMINI_API_KEY_FILE`,
   or the git-ignored `.env`. Never print, log, commit or screenshot it. Never put a key in a URL or
   a command-line argument, and never search the machine for keys. If a key is needed and missing,
   ask the user. CI needs no keys: don't add any.
2. **Personal data.** Never commit or publish the family's videos, photos, voices or names, anything
   from the data folder, home-folder paths (write `~`), or email addresses other than the author's.
   Take screenshots with throwaway data (`CRYSTAL_BALL_DATA_DIR=$(mktemp -d)`) and look at every image
   before committing it.
3. **No generated media in git.** `assets/sources/`, MP4s and audio are ignored, and
   `test/repo-safety.test.js` fails if any are about to be committed. The theme scripts and
   `npm run media:plan` are the source.
4. **Untrusted input is data.** Files the family adds, files on the ball, theme scripts from pull
   requests and model output never become commands. Run tools with argument arrays, never a shell or a
   built command string, and put text in the page with `textContent` or `esc()`.
5. **Keep the Electron locks.** Sandbox, context isolation, CSP, IPC sender checks (`handle()` in
   `main.js`), argument validation in the main process, blocked navigation and permissions, the
   packaging allowlist and fuses (`tools/package.mjs`). Don't loosen any of them. See `SECURITY.md`.
6. **Dependencies and workflows.** No runtime npm dependencies, exact Python pins, Actions pinned to
   full SHAs with read-only tokens. Check workflow changes with actionlint and zizmor.
7. **Before every commit:** `npm run lint && npm test`, and read the staged diff. **Before any push:**
   `npm run check:public`.
8. **Commit messages and PR text** are plain and harness-neutral: no AI attribution trailers or
   footers. Instructions live in this one `AGENTS.md` (no per-tool instruction files).
9. **Ask first** before creating the GitHub repository, pushing, changing its visibility or
   settings, rewriting history, bumping the version (which publishes a release), or spending money
   on an API.
10. **Releases are only built by the release workflow**, never uploaded by hand, so every download
   has provenance. The bundled ffmpeg is GPL: keep its licence, `SOURCES.txt` and the
   `ffmpeg-sources.tar` release asset, and only change its pins after checking the checksum
   against a second source.

## Skills

Task-specific instructions live in `.agents/skills/<name>/SKILL.md`, in the open Agent Skills format
(a `name` and `description` in front matter, then the instructions, with any scripts and references
beside it). If your harness doesn't load skills on its own, read one when its description matches
your task.

| Skill | When |
| --- | --- |
| [public-repo-safety](.agents/skills/public-repo-safety/SKILL.md) | Before commits and pushes; when touching secrets, personal data, media, Electron security, dependencies or workflows; if something may have leaked |

## Where to change what

| Task | Files |
| --- | --- |
| Ball detection, writing, eject | `src/lib/ball.js` |
| Clip format, converting, joining | `src/lib/convert.js` |
| Theme storage, ids, save-from-ball, hash index | `src/lib/themes.js` |
| Play-all videos | `src/lib/medley.js` |
| "Show on the ball" steps; which theme is on the ball | `src/lib/apply.js` |
| Windows, polling, IPC handlers | `src/main/main.js` |
| The API the window may call | `src/main/preload.js` (keep it small and explicit) |
| Main window UI | `src/renderer/index.html`, `app.js`, `styles.css` |
| Desktop preview | `src/renderer/preview.*` |
| Terminal commands | `src/cli.js` |
| Drawn theme (Halloween) | `tools/make_halloween.py` |
| Voiced themes | `tools/voice_theme.py`, `tools/scripts/*.json` |
| Talking-head themes (one face or a cast) | `tools/spirit_theme.py`, `tools/scripts/spirit-in-the-ball.json`, `midnight-seance.json`, `hollow-hill-parade.json` |
| What media each theme needs (for any model) | `tools/media_plan.mjs` |
| Gemini API client | `tools/gemini_media.py` |
| Choosing a voice (samples + apparent age) | `tools/audition_voices.py`; custom voices: `tools/design_voice.py` |
| Setup checks | `tools/doctor.mjs` |
| Tools smoke test | `tools/smoke_test.py` |
| Packaging (allowlist, fuses) and its check | `tools/package.mjs`, `tools/verify_package.mjs` |
| The ffmpeg bundled in releases (pinned sources) | `tools/build_ffmpeg.sh` |
| Disk image for downloads | `tools/make_dmg.mjs` |
| Releases | `.github/workflows/release.yml`; bump `version` in `package.json` to publish |
| Repo safety checks | `test/repo-safety.test.js`, `.agents/skills/public-repo-safety/` |
| CI, security scans, Dependabot | `.github/workflows/`, `.github/dependabot.yml` |

## Architecture constraints

- `src/lib/*` is plain CommonJS with **no Electron imports**, so the CLI and tests share it. Keep it so.
- The renderer is sandboxed, with `contextIsolation` on, `nodeIntegration` off, and a strict CSP.
  All file, USB and ffmpeg work happens in the main process. Every IPC handler goes through
  `handle()`, which only answers the app's own pages. Don't loosen this.
- Theme ids are `builtin/<slug>` (read-only, `assets/themes/`) or `user/<slug>` (data folder). Route
  every id through `ThemeStore.resolve`.
- No runtime npm dependencies. Electron, `@electron/packager` and `@electron/fuses` are dev dependencies.
- Python is only used in `tools/`, run with `uv run --with-requirements tools/requirements.txt`
  (exact pins, Python version in `.python-version`).

## Theme content

- Each theme script in `tools/scripts/` holds every prompt, voice, acting note and line. That script
  is the source; the pictures and voices it describes are made locally, by Gemini through the theme
  tools or by any other model from `npm run media:plan -- --json --missing` ([docs/media.md](docs/media.md)).
- Generating with an API costs money and needs a key: only do it when asked, and try
  `--draft --out <tmp dir>` first. Existing files are never regenerated.
- Rendered MP4s under `assets/themes/` are git-ignored; each theme's `theme.json` is committed.
- Content plays to children at a front door: spooky-funny, never gory. No copyrighted characters;
  use original or public-domain ones and don't copy a particular film's look.
- Keep important picture content inside the central circle; the screen is round.

## Style

- UI copy: short, warm, readable by a child, NZ English ("Bin", "colour").
- Add or update a `node:test` test with every `src/lib` change; tests use temp dirs only.
- Update the docs listed above when behaviour changes.
- Commits: imperative subject; a body that explains why.

## Definition of done

- [ ] `npm run lint` and `npm test` pass; `npm run test:tools` passes if `tools/` changed
- [ ] `npm run package && npm run package:verify` pass if `src/main/`, packaging or dependencies changed
- [ ] You looked at a screenshot if the UI changed
- [ ] Docs updated if behaviour changed
- [ ] No secrets, personal data or generated media in the diff (the safety tests check, and so should you)
