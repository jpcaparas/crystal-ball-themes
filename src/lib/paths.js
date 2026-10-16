'use strict';

const os = require('node:os');
const path = require('node:path');

const APP_NAME = 'Crystal Ball Themes';

/** Where user themes, saved ball contents and caches live. Electron's userData resolves to the same place. */
function dataDir() {
  return process.env.CRYSTAL_BALL_DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', APP_NAME);
}

/** Read-only themes shipped with the app (rendered by tools/make_halloween.py). */
function bundledThemesDir() {
  return process.env.CRYSTAL_BALL_BUNDLED_DIR || path.join(__dirname, '..', '..', 'assets', 'themes');
}

module.exports = { APP_NAME, dataDir, bundledThemesDir };
