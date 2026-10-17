'use strict';

const { app, BrowserWindow, ipcMain, dialog, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { bundledThemesDir } = require('../lib/paths');
const { detectBall, eject } = require('../lib/ball');
const { ThemeStore } = require('../lib/themes');
const { applyTheme, whatsOnBall } = require('../lib/apply');
const { tools } = require('../lib/convert');

const POLL_MS = 2000;
const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const MEDIA_EXT = ['mp4', 'mov', 'm4v', 'mkv', 'avi', 'webm', 'gif', 'jpg', 'jpeg', 'png', 'webp', 'heic'];
const args = process.argv.slice(1);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
// Screenshot flags write files, so they only work when running from source (npm start / npm run screenshot).
const dev = !app.isPackaged;
const screenshotPath = dev ? flag('screenshot') : undefined;
const previewArg = dev ? flag('preview') : undefined;
const openTheme = flag('open');

app.enableSandbox(); // every renderer is sandboxed, even one created by mistake later

let win = null;
let preview = null;
let store = null;
let ball = { mounted: false, usbSeen: false };
let onBall = null;
let busy = false;
let polling = false;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function forRenderer(t) {
  return {
    id: t.id,
    name: t.name,
    emoji: t.emoji,
    note: t.note,
    builtin: t.builtin,
    bytes: t.bytes,
    clips: t.clips.map((c) => ({ file: c.file, title: c.title, size: c.size, url: pathToFileURL(c.path).href })),
  };
}

const status = () => ({ ...ball, onBall, busy });

async function refreshBall({ force = false } = {}) {
  if (polling || (busy && !force)) return;
  polling = true;
  try {
    const next = await detectBall().catch(() => ({ mounted: false, usbSeen: false }));
    const changed = force || next.mounted !== ball.mounted || next.mountPoint !== ball.mountPoint || next.usbSeen !== ball.usbSeen;
    ball = next;
    if (!changed) return;
    onBall = null;
    send('ball:status', status());
    if (ball.mounted) {
      onBall = await whatsOnBall(store, ball.mountPoint).catch(() => null);
      send('ball:status', status());
    }
  } finally {
    polling = false;
  }
}

/** True only for the app's own pages (src/renderer/*.html), never anything else that got loaded. */
function fromApp(event) {
  try {
    return path.dirname(fileURLToPath(event.senderFrame?.url || '')) === RENDERER_DIR;
  } catch {
    return false;
  }
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...a) => {
    if (!fromApp(event)) throw new Error('Blocked: that request did not come from the app.');
    return fn(...a);
  });
}

function registerIpc() {
  handle('app:info', () => ({ ffmpeg: Boolean(tools().ffmpeg), dataDir: store.dataDir, version: app.getVersion() }));
  handle('themes:list', async () => (await store.list()).map(forRenderer));
  handle('themes:get', async (id) => forRenderer(await store.load(id)));
  handle('preview:open', (id) => {
    openPreview(id);
    return true;
  });
  handle('themes:create', async (name, emoji) => forRenderer(await store.create(name, emoji)));
  handle('themes:update', async (id, changes) => forRenderer(await store.update(id, changes)));
  handle('themes:remove', async (id) => {
    await store.remove(id);
    return true;
  });
  handle('themes:removeClip', async (id, file) => forRenderer(await store.removeClip(id, file)));
  handle('themes:reveal', async (id) => shell.openPath(store.resolve(id).dir));

  handle('themes:addFiles', async (id, files, fit) => {
    const errors = [];
    let theme = await store.load(id);
    const list = (Array.isArray(files) ? files : []).filter(
      (f) => typeof f === 'string' && path.isAbsolute(f) && MEDIA_EXT.includes(path.extname(f).slice(1).toLowerCase()) && fs.statSync(f, { throwIfNoEntry: false })?.isFile(),
    );
    for (const [index, file] of list.entries()) {
      const name = path.basename(file);
      send('convert:progress', { index, total: list.length, name, progress: 0 });
      try {
        theme = await store.addClip(id, file, {
          fit: fit === 'fit' ? 'fit' : 'fill',
          onProgress: (progress) => send('convert:progress', { index, total: list.length, name, progress }),
        });
      } catch (err) {
        errors.push(`${name}: ${err.message}`);
      }
    }
    send('convert:progress', { done: true });
    return { theme: forRenderer(theme), errors };
  });

  handle('dialog:pickFiles', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Add videos or pictures',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Videos and pictures', extensions: MEDIA_EXT },
      ],
    });
    return res.canceled ? [] : res.filePaths;
  });

  handle('ball:status', () => status());

  handle('ball:apply', async (id) => {
    if (!ball.mounted) throw new Error('Plug in the ball first.');
    busy = true;
    send('ball:status', status());
    try {
      return await applyTheme(store, id, ball.mountPoint, (p) => send('apply:progress', p));
    } finally {
      busy = false;
      await refreshBall({ force: true });
    }
  });

  handle('ball:eject', async () => {
    if (!ball.mounted) return { ok: true };
    busy = true;
    try {
      return await eject(ball.mountPoint);
    } finally {
      busy = false;
      await refreshBall({ force: true });
    }
  });
}

const secureWebPreferences = () => ({
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
});

// No page may navigate (dropping a file on a window must never leave the app), open windows, or embed
// a <webview>. Applies to every web contents, including any added later.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (e) => e.preventDefault());
  contents.on('will-redirect', (e) => e.preventDefault());
  contents.on('will-attach-webview', (e) => e.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

/** A floating, see-through crystal ball on the desktop that plays a theme like the real one. */
function openPreview(themeId) {
  store.resolve(themeId); // reject anything that isn't a theme id
  if (preview && !preview.isDestroyed()) {
    preview.webContents.send('preview:show', themeId);
    preview.show();
    return preview;
  }
  preview = new BrowserWindow({
    width: 380,
    height: 440,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    hasShadow: false,
    title: 'Crystal Ball Preview',
    backgroundColor: '#00000000',
    webPreferences: secureWebPreferences(),
  });
  preview.loadFile(path.join(__dirname, '..', 'renderer', 'preview.html'), { hash: `theme=${themeId}` });
  preview.on('closed', () => {
    preview = null;
  });
  return preview;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1080,
    height: 780,
    minWidth: 820,
    minHeight: 620,
    title: 'Crystal Ball Themes',
    backgroundColor: '#14091f',
    titleBarStyle: 'hiddenInset',
    show: false,
    webPreferences: secureWebPreferences(),
  });
  win.on('closed', () => preview?.close());
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), openTheme ? { hash: `theme=${openTheme}` } : {});
  win.once('ready-to-show', () => win.show());

  if (screenshotPath) {
    win.webContents.once('did-finish-load', () => {
      const target = previewArg ? openPreview(previewArg) : win;
      setTimeout(async () => {
        const image = await target.webContents.capturePage();
        fs.mkdirSync(path.dirname(path.resolve(screenshotPath)), { recursive: true });
        fs.writeFileSync(path.resolve(screenshotPath), image.toPNG());
        app.quit();
      }, Number(flag('wait')) || 3500);
    });
  }
}

app.whenReady().then(async () => {
  // The app needs no camera, microphone, notifications, location...; refuse every permission request.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  store = await new ThemeStore({
    dataDir: process.env.CRYSTAL_BALL_DATA_DIR || app.getPath('userData'),
    bundledDir: bundledThemesDir(),
    trash: (p) => shell.trashItem(p),
  }).init();
  registerIpc();
  createWindow();
  await refreshBall({ force: true });
  setInterval(() => refreshBall().catch(() => {}), POLL_MS);
});

app.on('window-all-closed', () => app.quit());
