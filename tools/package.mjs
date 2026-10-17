#!/usr/bin/env node
// Builds dist/Crystal Ball Themes-darwin-<arch>/Crystal Ball Themes.app for this Mac's architecture.
//
// Only an allowlist of files goes into the app, so nothing else in the folder (a .env with an API key,
// generated sources, the family's own media, notes) can ever end up inside a built app. Electron
// "fuses" are then flipped so the app can't be reused as a general-purpose Node.js runtime.
//
// Usage: npm run package

import { packager } from '@electron/packager';
import { flipFuses, FuseVersion, FuseV1Options } from '@electron/fuses';
import path from 'node:path';
import { ROOT } from './media_plan.mjs';

const SHIP = [
  /^$/, // the project folder itself
  /^\/package\.json$/,
  /^\/LICENSE$/,
  /^\/src(\/(lib|main|renderer)(\/[\w.-]+\.(js|html|css))?)?$/,
  /^\/assets(\/themes(\/[a-z0-9-]+(\/(theme\.json|[\w.-]+\.mp4))?)?)?$/,
  /^\/node_modules(\/(?!\.)|$)/, // runtime dependencies only (devDependencies are pruned; no .bin links)
];

export const shipped = (name) => SHIP.some((re) => re.test(name));

// Electron fuses baked into the app binary (re-signed afterwards so Apple silicon still runs it).
export const FUSES = {
  [FuseV1Options.RunAsNode]: false, // ELECTRON_RUN_AS_NODE can't turn the app into `node`
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false, // NODE_OPTIONS is ignored
  [FuseV1Options.EnableNodeCliInspectArguments]: false, // --inspect can't attach a debugger
  [FuseV1Options.EnableCookieEncryption]: true,
};

export async function build({ arch = process.arch, out = path.join(ROOT, 'dist') } = {}) {
  const [appPath] = await packager({
    dir: ROOT,
    name: 'Crystal Ball Themes',
    platform: 'darwin',
    arch,
    out,
    overwrite: true,
    icon: path.join(ROOT, 'assets', 'icon', 'icon.icns'),
    appBundleId: 'com.jpcaparas.crystal-ball-themes',
    appCategoryType: 'public.app-category.utilities',
    asar: false, // ffmpeg reads the bundled clips straight from disk
    ignore: (name) => !shipped(name),
  });
  const app = path.join(appPath, 'Crystal Ball Themes.app');
  await flipFuses(app, { version: FuseVersion.V1, resetAdHocDarwinSignature: true, ...FUSES });
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await build();
  console.log(`Built ${path.relative(ROOT, app)}`);
}
