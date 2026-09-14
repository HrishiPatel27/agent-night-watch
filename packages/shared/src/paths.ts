import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const NIGHTWATCH_DIR = '.nightwatch';
export const POLICY_FILE = 'policy.yaml';
export const CONFIG_FILE = 'config.yaml';
export const DB_FILE = 'nightwatch.db';
export const RUNS_DIR = 'runs';
export const FINDINGS_FILE = 'NIGHTWATCH_FINDINGS.jsonl';

export interface NightwatchPaths {
  projectRoot: string;
  dir: string;
  db: string;
  policy: string;
  config: string;
  runs: string;
  logs: string;
}

export function nightwatchPaths(projectRoot: string): NightwatchPaths {
  const dir = path.join(projectRoot, NIGHTWATCH_DIR);
  return {
    projectRoot,
    dir,
    db: path.join(dir, DB_FILE),
    policy: path.join(dir, POLICY_FILE),
    config: path.join(dir, CONFIG_FILE),
    runs: path.join(dir, RUNS_DIR),
    logs: path.join(dir, 'logs'),
  };
}

export function runPaths(projectRoot: string, sessionId: string) {
  const base = path.join(nightwatchPaths(projectRoot).runs, sessionId);
  return {
    base,
    worktree: path.join(base, 'worktree'),
    settings: path.join(base, 'claude-settings.json'),
    log: path.join(base, 'run.log'),
    stream: path.join(base, 'claude-stream.jsonl'),
    patch: path.join(base, 'changes.patch'),
    report: path.join(base, 'report.html'),
    reportJson: path.join(base, 'report.json'),
    token: path.join(base, 'dashboard.token'),
  };
}

/**
 * Walk upwards from `start` looking for a Nightwatch project root: first a
 * directory containing `.nightwatch/`, otherwise the nearest git repository
 * root (a `.git` directory or file).
 */
export function findProjectRoot(start: string): string | null {
  let current = path.resolve(start);
  let gitRoot: string | null = null;
  for (;;) {
    if (fs.existsSync(path.join(current, NIGHTWATCH_DIR, DB_FILE)) || fs.existsSync(path.join(current, NIGHTWATCH_DIR, POLICY_FILE))) {
      return current;
    }
    if (!gitRoot && fs.existsSync(path.join(current, '.git'))) gitRoot = current;
    const parent = path.dirname(current);
    if (parent === current) return gitRoot;
    current = parent;
  }
}

export function expandHome(p: string, homeDir: string = os.homedir()): string {
  if (p === '~') return homeDir;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(homeDir, p.slice(2));
  return p;
}

export function isCaseInsensitivePlatform(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' || platform === 'darwin';
}

/** Normalise a path for comparison: absolute, forward slashes, case folded where the OS ignores case. */
export function normalizeForCompare(p: string, platform: NodeJS.Platform = process.platform): string {
  let out = path.resolve(p).replace(/\\/g, '/');
  if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  if (isCaseInsensitivePlatform(platform)) out = out.toLowerCase();
  return out;
}

export function isPathInside(parent: string, child: string, platform: NodeJS.Platform = process.platform): boolean {
  const p = normalizeForCompare(parent, platform);
  const c = normalizeForCompare(child, platform);
  return c === p || c.startsWith(p.endsWith('/') ? p : `${p}/`);
}

export class PathResolutionError extends Error {
  constructor(message: string, public readonly input: string) {
    super(message);
    this.name = 'PathResolutionError';
  }
}

export interface CanonicalPath {
  /** Absolute path with symlinks in every existing ancestor resolved. */
  path: string;
  /** Whether the full path currently exists. */
  exists: boolean;
  /** Whether a symlink was traversed while resolving. */
  viaSymlink: boolean;
}

/**
 * Resolve a path the way the OS will when the tool call executes: relative to
 * `cwd`, `~` expanded, and symlinks in every existing component followed.
 * Non-existent trailing components are appended verbatim, so a write to a new
 * file inside a symlinked directory still resolves to the real target.
 */
export function canonicalizePath(input: string, cwd: string, homeDir: string = os.homedir()): CanonicalPath {
  if (typeof input !== 'string' || input.length === 0) {
    throw new PathResolutionError('empty path', String(input));
  }
  if (input.includes('\0')) throw new PathResolutionError('path contains NUL byte', input);
  const expanded = expandHome(input, homeDir);
  const absolute = path.resolve(cwd, expanded);
  let existing = absolute;
  const rest: string[] = [];
  let viaSymlink = false;
  // Find the deepest existing ancestor.
  for (;;) {
    try {
      const lst = fs.lstatSync(existing);
      if (lst.isSymbolicLink()) viaSymlink = true;
      break;
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) {
        return { path: absolute, exists: false, viaSymlink: false };
      }
      rest.unshift(path.basename(existing));
      existing = parent;
    }
  }
  let real: string;
  try {
    real = fs.realpathSync.native ? fs.realpathSync.native(existing) : fs.realpathSync(existing);
  } catch (err) {
    throw new PathResolutionError(`cannot resolve ${input}: ${(err as Error).message}`, input);
  }
  if (normalizeForCompare(real) !== normalizeForCompare(existing)) viaSymlink = true;
  const full = rest.length ? path.join(real, ...rest) : real;
  return { path: full, exists: rest.length === 0, viaSymlink };
}

export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

export function tmpDirs(): string[] {
  const out = new Set<string>([os.tmpdir()]);
  if (process.platform !== 'win32') {
    out.add('/tmp');
    out.add('/private/tmp');
    out.add('/var/folders');
  }
  return [...out];
}
