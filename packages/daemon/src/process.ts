import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function isAlive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Terminate a process and everything it spawned. */
export async function killTree(child: ChildProcess | number, graceMs = 8000): Promise<void> {
  const pid = typeof child === 'number' ? child : child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      /* already gone */
    }
    return;
  }
  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig); // process group (child was spawned detached)
    } catch {
      try {
        process.kill(pid, sig);
      } catch {
        /* gone */
      }
    }
  };
  signal('SIGTERM');
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  signal('SIGKILL');
}

/** Find an executable on PATH (with PATHEXT on Windows). Optionally skip directories (used by shims). */
export function findExecutable(name: string, options: { skipDirs?: string[]; env?: NodeJS.ProcessEnv } = {}): string | null {
  const env = options.env ?? process.env;
  if (path.isAbsolute(name)) return fs.existsSync(name) ? name : null;
  const pathVar = env.PATH ?? env.Path ?? '';
  const dirs = pathVar.split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').map((e) => e.toLowerCase()) : [''];
  const skip = (options.skipDirs ?? []).map((d) => path.resolve(d).toLowerCase());
  for (const dir of dirs) {
    if (skip.includes(path.resolve(dir).toLowerCase())) continue;
    for (const ext of process.platform === 'win32' ? ['', ...exts] : exts) {
      const candidate = path.join(dir, name + ext);
      try {
        const st = fs.statSync(candidate);
        if (st.isFile()) {
          if (process.platform !== 'win32') {
            fs.accessSync(candidate, fs.constants.X_OK);
          } else if (ext === '' && !exts.some((e) => candidate.toLowerCase().endsWith(e))) {
            continue;
          }
          return candidate;
        }
      } catch {
        /* next */
      }
    }
  }
  return null;
}

/** Re-launch this CLI detached so the run survives the terminal closing. */
export function spawnDetachedSelf(args: string[], logFile: string, env: NodeJS.ProcessEnv = process.env): number {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const out = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1], ...args], {
    detached: true,
    stdio: ['ignore', out, out],
    env,
    windowsHide: true,
  });
  child.unref();
  fs.closeSync(out);
  return child.pid ?? 0;
}

export function openInBrowser(target: string): void {
  try {
    if (process.platform === 'darwin') spawn('open', [target], { stdio: 'ignore', detached: true }).unref();
    else if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', target.replace(/&/g, '^&')], { stdio: 'ignore', detached: true, windowsHide: true }).unref();
    else spawn('xdg-open', [target], { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* best effort */
  }
}
