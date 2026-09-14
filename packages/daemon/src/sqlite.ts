/**
 * Thin wrapper around the built-in `node:sqlite` module (Node 22.13+). It is
 * loaded lazily so the experimental-feature warning printed by some Node 22
 * releases can be filtered — hooks must keep stderr clean.
 */
import { createRequire } from 'node:module';

export interface StatementSync {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface DatabaseSyncLike {
  exec(sql: string): void;
  prepare(sql: string): StatementSync;
  close(): void;
}

type DatabaseSyncCtor = new (path: string, options?: Record<string, unknown>) => DatabaseSyncLike;

let ctor: DatabaseSyncCtor | null = null;

export function openDatabase(file: string, options: { readOnly?: boolean } = {}): DatabaseSyncLike {
  if (!ctor) {
    const originalEmit = process.emitWarning;
    // Suppress "SQLite is an experimental feature" on Node 22.x; it is stable in Node 24.
    process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
      const text = typeof warning === 'string' ? warning : (warning as Error)?.message ?? '';
      if (/SQLite is an experimental feature/i.test(text)) return;
      return (originalEmit as (...args: unknown[]) => void).call(process, warning, ...rest);
    }) as typeof process.emitWarning;
    try {
      const require = createRequire(import.meta.url);
      const mod = require('node:sqlite') as { DatabaseSync: DatabaseSyncCtor };
      ctor = mod.DatabaseSync;
    } finally {
      process.emitWarning = originalEmit;
    }
  }
  const db = new ctor(file, options.readOnly ? { readOnly: true } : {});
  db.exec('PRAGMA busy_timeout = 5000');
  if (!options.readOnly) {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
  }
  return db;
}
