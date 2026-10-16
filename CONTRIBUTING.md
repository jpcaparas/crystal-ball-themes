# Changing, forking and extending

Thanks for picking this up. This guide gets you from a bare Mac to a running, changed, packaged app.
You don't need to have seen the project before. If you're using a coding agent, point it at
[AGENTS.md](AGENTS.md); it covers the same ground in a form agents follow well.

**On this page:** [Set up a Mac from scratch](#set-up-a-mac-from-scratch) ·
[Make it your own (fork checklist)](#make-it-your-own-fork-checklist) · [Everyday workflow](#everyday-workflow) ·
[Where to change what](#where-to-change-what) · [Rules that protect the family's videos](#rules-that-protect-the-familys-videos) ·
[Style](#style) · [Before you share a change](#before-you-share-a-change) · [Sharing the app](#sharing-the-app)

## Set up a Mac from scratch

1. **Install Homebrew** from [brew.sh](https://brew.sh) (copy the one-line command from its front page).
2. **Install the tools:**
   ```bash
   brew install node@22 ffmpeg uv git
   ```
   Already use nvm? `nvm install 22` works instead of `node@22`; the repo's `.nvmrc` selects it.
3. **Get the code:**
   ```bash
   git clone <repository URL> crystal-ball-themes
   ```
   ```bash
   cd crystal-ball-themes
   ```
4. **Install and set up:**
   ```bash
   npm install
   ```
   ```bash
   npm run setup
   ```
   `setup` renders the built-in theme videos from saved art and voices (no API key), then runs
   `npm run doctor`. Every line should show ✓; anything marked ✗ comes with the command that fixes it.
5. **Run it:**
   ```bash
   npm start
   ```

You don't need the crystal ball to work on the app. Without it, everything works except putting
themes on the ball.

## Make it your own (fork checklist)

If you're publishing your own version, change these so it doesn't clash with the original:

| What | Where |
| --- | --- |
| App name (also names the data folder in `~/Library/Application Support/`) | `productName` in `package.json`, `APP_NAME` in `src/lib/paths.js`, and the name in the `package` script |
| Bundle id | `--app-bundle-id` in the `package` script |
| Author | `author` in `package.json`; the copyright line in `LICENSE` |
| Icon | `tools/make_icon.py`, then `npm run icon` |
| USB device name, if your ball is different | `USB_PRODUCT` in `src/lib/ball.js` (find yours with `ioreg -p IOUSB -w0`) |

## Everyday workflow

```mermaid
flowchart LR
    change["Change code"] --> test["npm test"]
    test --> look["npm start<br/>or a screenshot"]
    look --> tools{"Touched tools/?"}
    tools -- "Yes" --> smoke["npm run test:tools"]
    tools -- "No" --> pkg["npm run package"]
    smoke --> pkg
```

| Check | Command | How long |
| --- | --- | --- |
| Logic tests (uses temporary folders, never your real themes) | `npm test` | Seconds |
| Theme tools still produce ball-ready video | `npm run test:tools` | About a minute |
| Machine has everything | `npm run doctor` | Seconds |
| See the app | `npm start` | |
| Screenshot without clicking | `npx electron . --screenshot=dist/x.png --wait=4000` | Seconds |
| Screenshot a theme's sheet | add `--open=builtin/halloween` | |
| Screenshot the desktop preview | add `--preview=builtin/halloween` | |
| Use throwaway data | prefix with `CRYSTAL_BALL_DATA_DIR=$(mktemp -d)` | |
| Build the app | `npm run package` | About a minute |

Working with the real ball from Terminal: `npm run ball -- status`, `npm run ball -- apply <theme id>`,
`npm run ball -- eject`.

## Where to change what

| I want to… | Change |
| --- | --- |
| Add a built-in theme | See [docs/themes.md](docs/themes.md) |
| Change how the window looks | `src/renderer/styles.css`, `src/renderer/app.js` |
| Change the desktop preview | `src/renderer/preview.*`, `openPreview` in `src/main/main.js` |
| Add something the window can ask for | Logic in `src/lib/`, a handler in `registerIpc` (`src/main/main.js`), and an entry in `src/main/preload.js` |
| Change the video format | `src/lib/convert.js` and `tools/make_halloween.py` (`encode`); read [docs/hardware.md](docs/hardware.md) first |
| Change how the ball is found | `detectBall` in `src/lib/ball.js` |
| Change what happens on "Show on the ball" | `applyTheme` in `src/lib/apply.js` |
| Add a Terminal command | `src/cli.js` |
| Add a setup check | `tools/doctor.mjs` |

[docs/architecture.md](docs/architecture.md) explains how these pieces fit together.

## Rules that protect the family's videos

These keep the app safe for the people using it. Please don't break them.

1. **Never lose what's on the ball.** All writing to the ball goes through `applyTheme`, which saves
   anything new first.
2. **Only touch files inside the ball's `video` folder.** Never rename or delete the folder.
3. **Copy to the ball with `plainCopy`**, not Finder, `cp` or `fs.copyFile` (they create hidden `._`
   files the ball tries to play).
4. **Don't run `diskutil info` on the ball.** It hangs. Use `ioreg` and `mount` as `detectBall` does.
5. **Keep the exact video format** described in [docs/themes.md](docs/themes.md#the-rules-every-clip-follows).
6. **Deleting goes to the Bin**, never permanently.
7. **Don't write the ball's firmware.** One mistake can break the toy for good.
8. **Keep API keys out of git**, logs and screenshots. `.env` is git-ignored for this reason.

## Style

- **Code:** plain CommonJS JavaScript; no runtime npm dependencies (Electron and the packager are
  dev-only). `src/lib` must not import Electron. Python is only for the tools in `tools/`.
- **Tests:** `node:test`, in `test/`. Add or update a test with every change to `src/lib`. Tests use
  temporary folders, never the real data folder or a real ball.
- **Words in the app:** short, warm, and readable by a child. NZ English ("Bin", "colour").
- **Content:** kind, spooky-funny, and free of copyrighted characters (see
  [docs/themes.md](docs/themes.md#content-guidelines)).
- **Commits:** a short subject in the imperative ("Add a winter theme"), and a body that says why.

## Before you share a change

- [ ] `npm test` passes
- [ ] `npm run test:tools` passes, if you changed anything in `tools/`
- [ ] You looked at the change in the app (or a screenshot)
- [ ] Docs updated if behaviour changed (README, `docs/`, `AGENTS.md`)
- [ ] No keys, personal videos or family photos in the commit

## Sharing the app

`npm run package` builds an unsigned app. It opens fine on the Mac that built it. On another Mac,
macOS will warn that it's from an unidentified developer; the other person can right-click the app,
choose **Open**, and confirm. To avoid that, sign and notarise it with an Apple Developer account
(see Electron's [code signing guide](https://www.electronjs.org/docs/latest/tutorial/code-signing)).

The app needs ffmpeg on that Mac only for adding clips and making play-all videos. Showing built-in
themes works without it.
