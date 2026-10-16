'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { bundledThemesDir } = require('../lib/paths');
const { detectBall, eject } = require('../lib/ball');
const { ThemeStore } = require('../lib/themes');
const { applyTheme, whatsOnBall } = require('../lib/apply');
const { tools } = require('../lib/convert');

const POLL_MS = 2000;
const args = process.argv.slice(1);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const screenshotPath = flag('screenshot');
const openTheme = flag('open');

let win = null;
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

function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...a) => fn(...a));
}

function registerIpc() {
  handle('app:info', () => ({ ffmpeg: Boolean(tools().ffmpeg), dataDir: store.dataDir, version: app.getVersion() }));
  handle('themes:list', async () => (await store.list()).map(forRenderer));
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
    const list = (files || []).filter((f) => typeof f === 'string' && fs.existsSync(f));
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
        { name: 'Videos and pictures', extensions: ['mp4', 'mov', 'm4v', 'mkv', 'avi', 'webm', 'gif', 'jpg', 'jpeg', 'png', 'webp', 'heic'] },
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
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // Dropping a file on the window must never navigate away from the app.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), openTheme ? { hash: `theme=${openTheme}` } : {});
  win.once('ready-to-show', () => win.show());

  if (screenshotPath) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const image = await win.webContents.capturePage();
        fs.mkdirSync(path.dirname(path.resolve(screenshotPath)), { recursive: true });
        fs.writeFileSync(path.resolve(screenshotPath), image.toPNG());
        app.quit();
      }, Number(flag('wait')) || 3500);
    });
  }
}

app.whenReady().then(async () => {
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
