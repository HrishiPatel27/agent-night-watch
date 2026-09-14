import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalizePath, isPathInside, expandHome, findProjectRoot } from './paths.js';

test('isPathInside handles boundaries', () => {
  assert.equal(isPathInside('/a/b', '/a/b/c'), true);
  assert.equal(isPathInside('/a/b', '/a/b'), true);
  assert.equal(isPathInside('/a/b', '/a/bc'), false);
  assert.equal(isPathInside('/a/b', '/a'), false);
});

test('canonicalizePath resolves relative paths and symlinked directories', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-paths-'));
  const real = path.join(base, 'real');
  fs.mkdirSync(real);
  const link = path.join(base, 'link');
  let linked = true;
  try {
    fs.symlinkSync(real, link, 'dir');
  } catch {
    linked = false; // symlinks may be unavailable on Windows without privileges
  }
  const c = canonicalizePath('./new/file.txt', base);
  assert.equal(c.exists, false);
  assert.ok(c.path.endsWith(path.join('new', 'file.txt')));
  if (linked) {
    const viaLink = canonicalizePath('link/deeper/file.txt', base);
    assert.equal(viaLink.viaSymlink, true);
    assert.ok(isPathInside(fs.realpathSync(real), viaLink.path));
  }
  fs.rmSync(base, { recursive: true, force: true });
});

test('expandHome', () => {
  assert.equal(expandHome('~/x', '/home/u'), path.join('/home/u', 'x'));
  assert.equal(expandHome('/abs', '/home/u'), '/abs');
});

test('findProjectRoot prefers .nightwatch over .git', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-root-'));
  fs.mkdirSync(path.join(base, '.git'));
  const sub = path.join(base, 'sub', 'deeper');
  fs.mkdirSync(sub, { recursive: true });
  assert.equal(fs.realpathSync(findProjectRoot(sub)!), fs.realpathSync(base));
  fs.mkdirSync(path.join(base, 'sub', '.nightwatch'));
  fs.writeFileSync(path.join(base, 'sub', '.nightwatch', 'policy.yaml'), 'version: 1\n');
  assert.equal(fs.realpathSync(findProjectRoot(sub)!), fs.realpathSync(path.join(base, 'sub')));
  fs.rmSync(base, { recursive: true, force: true });
});
