import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export class GitError extends Error {
  constructor(message: string, public readonly args: string[], public readonly stderr: string) {
    super(message);
    this.name = 'GitError';
  }
}

export function git(args: string[], cwd: string, opts: { allowFail?: boolean; maxBuffer?: number } = {}): string {
  const o: ExecFileSyncOptions = { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024, windowsHide: true };
  try {
    return String(execFileSync('git', args, o)).replace(/\r?\n$/, '');
  } catch (err) {
    const e = err as { stderr?: Buffer | string; message: string };
    const stderr = e.stderr ? String(e.stderr).trim() : '';
    if (opts.allowFail) return '';
    throw new GitError(`git ${args.join(' ')} failed: ${stderr || e.message}`, args, stderr);
  }
}

export function gitVersion(): string | null {
  try {
    return String(execFileSync('git', ['--version'], { encoding: 'utf8', windowsHide: true })).trim();
  } catch {
    return null;
  }
}

export function isGitRepo(dir: string): boolean {
  try {
    return git(['rev-parse', '--is-inside-work-tree'], dir) === 'true';
  } catch {
    return false;
  }
}

export function repoRoot(dir: string): string | null {
  try {
    return path.resolve(git(['rev-parse', '--show-toplevel'], dir));
  } catch {
    return null;
  }
}

export function headSha(dir: string): string {
  return git(['rev-parse', 'HEAD'], dir);
}

export function currentBranch(dir: string): string {
  return git(['rev-parse', '--abbrev-ref', 'HEAD'], dir);
}

export function hasCommits(dir: string): boolean {
  try {
    git(['rev-parse', '--verify', 'HEAD'], dir);
    return true;
  } catch {
    return false;
  }
}

export function isDirty(dir: string): boolean {
  return git(['status', '--porcelain=v1', '--untracked-files=normal'], dir).trim().length > 0;
}

/**
 * Fingerprint of the user's main working tree: HEAD, index, tracked
 * modifications and the set of untracked files. Compared before and after a
 * run to prove the run never touched it.
 */
export function fingerprintTree(dir: string): string {
  const parts = [
    git(['rev-parse', 'HEAD'], dir, { allowFail: true }),
    git(['rev-parse', '--abbrev-ref', 'HEAD'], dir, { allowFail: true }),
    git(['status', '--porcelain=v1', '--untracked-files=all', '--ignored=no'], dir, { allowFail: true }),
    git(['diff', '--no-color', '--no-ext-diff'], dir, { allowFail: true }),
    git(['diff', '--cached', '--no-color', '--no-ext-diff'], dir, { allowFail: true }),
    git(['stash', 'list'], dir, { allowFail: true }),
  ];
  return createHash('sha256').update(parts.join('\n---\n')).digest('hex');
}

export function createWorktree(repo: string, dir: string, branch: string, baseRef = 'HEAD'): void {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  git(['worktree', 'add', '-b', branch, dir, baseRef], repo);
}

export function removeWorktree(repo: string, dir: string): void {
  git(['worktree', 'remove', '--force', dir], repo, { allowFail: true });
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  git(['worktree', 'prune'], repo, { allowFail: true });
}

export function deleteBranch(repo: string, branch: string): boolean {
  try {
    git(['branch', '-D', branch], repo);
    return true;
  } catch {
    return false;
  }
}

export function branchExists(repo: string, branch: string): boolean {
  try {
    git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repo);
    return true;
  } catch {
    return false;
  }
}

export interface WorktreeInfo {
  path: string;
  head: string;
  branch: string | null;
}

export function listWorktrees(repo: string): WorktreeInfo[] {
  const out = git(['worktree', 'list', '--porcelain'], repo, { allowFail: true });
  const items: WorktreeInfo[] = [];
  let cur: Partial<WorktreeInfo> = {};
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) cur = { path: line.slice(9) };
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace('refs/heads/', '');
    else if (line.trim() === '' && cur.path) {
      items.push({ path: cur.path, head: cur.head ?? '', branch: cur.branch ?? null });
      cur = {};
    }
  }
  if (cur.path) items.push({ path: cur.path, head: cur.head ?? '', branch: cur.branch ?? null });
  return items;
}

/** Add a pattern to .git/info/exclude (works for the main repo; worktrees share it). */
export function ensureExcluded(repo: string, pattern: string): boolean {
  let commonDir: string;
  try {
    commonDir = path.resolve(repo, git(['rev-parse', '--git-common-dir'], repo));
  } catch {
    return false;
  }
  const file = path.join(commonDir, 'info', 'exclude');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (current.split(/\r?\n/).some((l) => l.trim() === pattern)) return false;
  fs.appendFileSync(file, `${current.endsWith('\n') || current === '' ? '' : '\n'}${pattern}\n`);
  return true;
}

export interface ChangedFile {
  status: string;
  path: string;
  committed: boolean;
}

export function changedFiles(worktree: string, baseRef: string, exclude: string[] = []): ChangedFile[] {
  const out = new Map<string, ChangedFile>();
  const committed = git(['diff', '--name-status', '--no-renames', `${baseRef}..HEAD`], worktree, { allowFail: true });
  for (const line of committed.split('\n')) {
    if (!line.trim()) continue;
    const [status, ...rest] = line.split('\t');
    const p = rest.join('\t');
    out.set(p, { status: status.charAt(0), path: p, committed: true });
  }
  const dirty = git(['status', '--porcelain=v1', '--untracked-files=all'], worktree, { allowFail: true });
  for (const line of dirty.split('\n')) {
    if (!line.trim()) continue;
    const xy = line.slice(0, 2);
    const p = line.slice(3).replace(/^"|"$/g, '');
    const status = xy.trim() === '??' ? 'A' : (xy.trim().charAt(0) || 'M');
    out.set(p, { status, path: p, committed: false });
  }
  return [...out.values()].filter((f) => !exclude.includes(f.path)).sort((a, b) => a.path.localeCompare(b.path));
}

export function commitLog(worktree: string, baseRef: string): { sha: string; subject: string }[] {
  const out = git(['log', '--format=%h%x09%s', `${baseRef}..HEAD`], worktree, { allowFail: true });
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [sha, ...s] = l.split('\t');
      return { sha, subject: s.join('\t') };
    });
}

/** Full patch (committed + uncommitted + untracked) relative to the base ref. */
export function exportPatch(worktree: string, baseRef: string, exclude: string[] = []): string {
  // Stage everything so untracked files are part of the diff, then diff the index against the base.
  git(['add', '-A', '--', '.'], worktree, { allowFail: true });
  const pathspec = ['--', '.', ...exclude.map((e) => `:(exclude)${e}`)];
  return git(['diff', '--cached', '--no-color', '--no-ext-diff', '--binary', baseRef, ...pathspec], worktree, { allowFail: true });
}

export function diffStat(worktree: string, baseRef: string, exclude: string[] = []): string {
  git(['add', '-A', '--', '.'], worktree, { allowFail: true });
  const pathspec = ['--', '.', ...exclude.map((e) => `:(exclude)${e}`)];
  return git(['diff', '--cached', '--stat=100', '--no-color', baseRef, ...pathspec], worktree, { allowFail: true });
}

export function fileDiff(worktree: string, baseRef: string, file: string, maxBytes = 200_000): string {
  git(['add', '-A', '--', '.'], worktree, { allowFail: true });
  const out = git(['diff', '--cached', '--no-color', '--no-ext-diff', baseRef, '--', file], worktree, { allowFail: true });
  return out.length > maxBytes ? `${out.slice(0, maxBytes)}\n… (truncated)` : out;
}
