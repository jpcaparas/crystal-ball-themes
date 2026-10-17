# AGENTS.md

Instructions for any coding agent working in this repository. Humans: the same information, in a
friendlier order, is in [CONTRIBUTING.md](CONTRIBUTING.md).

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
| [docs/hardware.md](docs/hardware.md) | Everything known about the device, and the firmware research |

## Environment

- macOS only (ball detection uses `ioreg`, `mount`, `diskutil`).
- Node.js 22.19 or newer (`.nvmrc` says 22). If `node --version` is older, switch Node before
  running anything.
- ffmpeg and ffprobe with libx264 and libmp3lame; uv for the Python tools.
- Run `npm run doctor` first. It checks all of the above and prints the fix for anything missing.
- The rendered theme MP4s are not in git. If `assets/themes/*/` has no `.mp4` files, run
  `npm run themes` (uses committed sources, needs no API key, takes several minutes).

## Verify your work

Run these from fastest to slowest. All must pass before you call a change done.

| Command | Checks | Time |
| --- | --- | --- |
| `npm run doctor` | The machine has what the project needs | Seconds |
| `npm test` | `src/lib` logic, including real ffmpeg conversions, in temp folders | Seconds |
| `npm run test:tools` | Each theme tool renders a clip in the ball's exact format (draft mode, no API) | ~4 minutes |
| `npx electron . --screenshot=dist/x.png --wait=4000` | The window renders; open the PNG and look at it | Seconds |

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
6. **Themes with 2+ clips go on the ball with their joined play-all video first**
   (`00-<slug>-all.mp4`, `src/lib/medley.js`), because the ball repeats the current file. Keep it.
7. **Delete user content with the Bin** (`shell.trashItem`), never permanently.
8. **Don't write the ball's firmware** unless the user explicitly asks. A bad write bricks the toy.
   Reading is fine; see `docs/hardware.md`.
9. **Secrets:** the Gemini key comes from `GEMINI_API_KEY`, a file named by `GEMINI_API_KEY_FILE`,
   or the git-ignored `.env`. Never print, log, commit or screenshot it, and never search the machine
   for keys. If a key is needed and missing, ask the user.

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
| Talking-head themes | `tools/spirit_theme.py`, `tools/scripts/spirit-in-the-ball.json`, `tools/scripts/midnight-seance.json` |
| Gemini API client | `tools/gemini_media.py` |
| Choosing a voice (samples + apparent age) | `tools/audition_voices.py`; custom voices: `tools/design_voice.py` |
| Setup checks | `tools/doctor.mjs` |
| Tools smoke test | `tools/smoke_test.py` |

## Architecture constraints

- `src/lib/*` is plain CommonJS with **no Electron imports**, so the CLI and tests share it. Keep it so.
- The renderer is sandboxed, with `contextIsolation` on, `nodeIntegration` off, and a strict CSP.
  All file, USB and ffmpeg work happens in the main process. Don't loosen this.
- Theme ids are `builtin/<slug>` (read-only, `assets/themes/`) or `user/<slug>` (data folder). Route
  every id through `ThemeStore.resolve`.
- No runtime npm dependencies. Electron and `@electron/packager` are dev dependencies.
- Python is only used in `tools/`, run with `uv run --with pillow --with numpy`.

## Theme content

- Built-in theme sources (Gemini pictures and voices) are committed in `assets/sources/<id>/`, so
  rendering is offline and free. Generating new ones costs money and needs a key: only do it when
  asked, and try `--draft --out <tmp dir>` first.
- Rendered MP4s under `assets/themes/` are git-ignored.
- Content plays to children at a front door: spooky-funny, never gory. No copyrighted characters;
  use original or public-domain ones and don't copy a particular film's look.
- Keep important picture content inside the central circle; the screen is round.

## Style

- UI copy: short, warm, readable by a child, NZ English ("Bin", "colour").
- Add or update a `node:test` test with every `src/lib` change; tests use temp dirs only.
- Update the docs listed above when behaviour changes.
- Commits: imperative subject; a body that explains why.

## Definition of done

- [ ] `npm test` passes; `npm run test:tools` passes if `tools/` changed
- [ ] You looked at a screenshot if the UI changed
- [ ] Docs updated if behaviour changed
- [ ] No secrets, personal videos or photos added to the repo
