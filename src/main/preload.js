'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const EVENTS = new Set(['ball:status', 'apply:progress', 'convert:progress']);

// ipcRenderer.invoke wraps errors as "Error invoking remote method 'x': Error: msg"; keep just msg.
async function invoke(channel, ...args) {
  try {
    return await ipcRenderer.invoke(channel, ...args);
  } catch (err) {
    throw new Error(String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
  }
}

contextBridge.exposeInMainWorld('ballApi', {
  info: () => invoke('app:info'),
  listThemes: () => invoke('themes:list'),
  createTheme: (name, emoji) => invoke('themes:create', name, emoji),
  updateTheme: (id, changes) => invoke('themes:update', id, changes),
  removeTheme: (id) => invoke('themes:remove', id),
  removeClip: (id, file) => invoke('themes:removeClip', id, file),
  addFiles: (id, paths, fit) => invoke('themes:addFiles', id, paths, fit),
  pickFiles: () => invoke('dialog:pickFiles'),
  revealTheme: (id) => invoke('themes:reveal', id),
  ballStatus: () => invoke('ball:status'),
  applyTheme: (id) => invoke('ball:apply', id),
  eject: () => invoke('ball:eject'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  on(channel, callback) {
    if (!EVENTS.has(channel)) throw new Error(`Unknown event ${channel}`);
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
