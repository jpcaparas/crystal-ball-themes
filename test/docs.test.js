'use strict';

// Every relative link in the Markdown docs points at a file that exists, and every #anchor at a
// heading that exists, so the docs keep working for whoever picks the project up next.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SKIP = new Set(['node_modules', 'dist', 'assets', '.git']);

function markdownFiles(dir = ROOT) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (SKIP.has(e.name)) return [];
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return markdownFiles(p);
    return e.name.endsWith('.md') ? [p] : [];
  });
}

/** GitHub's heading anchors: lower case, punctuation dropped, spaces to hyphens. */
const slug = (heading) =>
  heading
    .toLowerCase()
    .replace(/[`*_]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s/g, '-');

function anchors(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '');
  return new Set([...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1])));
}

test('relative links and anchors in the docs resolve', () => {
  const broken = [];
  for (const file of markdownFiles()) {
    const text = fs.readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '');
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^[a-z]+:/i.test(target)) continue; // https:, mailto:
      const [rel, anchor] = target.split('#');
      const dest = rel ? path.resolve(path.dirname(file), decodeURIComponent(rel)) : file;
      const where = `${path.relative(ROOT, file)} → ${target}`;
      if (!fs.existsSync(dest)) broken.push(`${where} (no such file)`);
      else if (anchor && dest.endsWith('.md') && !anchors(dest).has(anchor)) broken.push(`${where} (no such heading)`);
    }
  }
  assert.deepEqual(broken, []);
});
