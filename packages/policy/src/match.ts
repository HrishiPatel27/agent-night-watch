import picomatch from 'picomatch';
import { expandHome, isCaseInsensitivePlatform, normalizeForCompare, toPosix } from '@nightwatch-agent/shared';

/**
 * Command patterns are simple wildcards, not globs: `*` matches anything
 * (including spaces and slashes), `?` one character. A pattern without a
 * trailing wildcard also matches when the command *starts with* the pattern
 * followed by a space, so "git diff" covers "git diff --stat".
 */
export function matchCommandPattern(pattern: string, command: string): boolean {
  const p = pattern.trim().replace(/\s+/g, ' ');
  const c = command.trim().replace(/\s+/g, ' ');
  if (!p) return false;
  const re = new RegExp(`^${p.split('*').map((part) => part.split('?').map(escapeRegExp).join('.')).join('.*')}$`, 's');
  if (re.test(c)) return true;
  if (!p.endsWith('*') && c.startsWith(`${p} `)) return true;
  return false;
}

export function matchesAnyCommand(patterns: string[], command: string): string | null {
  for (const p of patterns) if (matchCommandPattern(p, command)) return p;
  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Domain allow list semantics: "example.com" matches exactly that host,
 * "*.example.com" matches any subdomain (not the apex), "*" matches all.
 * IP literals and "localhost" are matched exactly.
 */
export function matchDomain(patterns: string[], host: string): string | null {
  const h = host.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  for (const raw of patterns) {
    const p = raw.toLowerCase().trim();
    if (!p) continue;
    if (p === '*') return raw;
    if (p.startsWith('*.')) {
      const suffix = p.slice(1); // ".example.com"
      if (h.endsWith(suffix) && h.length > suffix.length) return raw;
      continue;
    }
    if (p === h) return raw;
  }
  return null;
}

export interface PathMatcher {
  (absPath: string): string | null;
}

/**
 * Compile path globs. Patterns may use ${RUN_WORKTREE}, ${PROJECT_ROOT}, ~ and
 * forward or back slashes. Matching is done on canonical, posix-style paths;
 * case-insensitively on Windows and macOS.
 */
export function compilePathGlobs(
  patterns: string[],
  vars: { RUN_WORKTREE: string; PROJECT_ROOT: string; HOME: string },
  platform: NodeJS.Platform = process.platform,
): PathMatcher {
  const nocase = isCaseInsensitivePlatform(platform);
  const compiled: { pattern: string; test: (p: string) => boolean; basenameOnly: boolean }[] = [];
  for (const raw of patterns) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    let p = raw.trim();
    p = p.replace(/\$\{RUN_WORKTREE\}/g, vars.RUN_WORKTREE).replace(/\$\{PROJECT_ROOT\}/g, vars.PROJECT_ROOT).replace(/\$\{HOME\}/g, vars.HOME);
    p = expandHome(p, vars.HOME);
    p = toPosix(p);
    if (nocase) p = p.toLowerCase();
    // Windows drive letters: picomatch treats ':' fine; keep as is.
    const basenameOnly = !p.includes('/');
    const test = picomatch(p, { dot: true, nocase, windows: false });
    compiled.push({ pattern: raw, test, basenameOnly });
  }
  return (absPath: string) => {
    const norm = normalizeForCompare(absPath, platform);
    // Absolute POSIX-style patterns ("/etc/shadow") must also match "C:/etc/shadow" on Windows.
    const noDrive = norm.replace(/^[a-z]:/i, '');
    const base = norm.slice(norm.lastIndexOf('/') + 1);
    for (const c of compiled) {
      if (c.basenameOnly ? c.test(base) : c.test(norm) || (noDrive !== norm && c.test(noDrive))) return c.pattern;
    }
    return null;
  };
}

/** Expand ${VARS} and ~ in a list of directory roots, returning absolute paths. */
export function expandRoots(patterns: string[], vars: { RUN_WORKTREE: string; PROJECT_ROOT: string; HOME: string }): string[] {
  const out: string[] = [];
  for (const raw of patterns) {
    if (typeof raw !== 'string') continue;
    let p = raw.replace(/\$\{RUN_WORKTREE\}/g, vars.RUN_WORKTREE).replace(/\$\{PROJECT_ROOT\}/g, vars.PROJECT_ROOT).replace(/\$\{HOME\}/g, vars.HOME);
    p = expandHome(p, vars.HOME);
    // Strip trailing glob parts: "/x/**" → "/x"
    p = p.replace(/[\\/]\*\*?([\\/].*)?$/, '');
    if (p.includes('*')) continue; // still a glob, not a root
    out.push(p);
  }
  return out;
}
