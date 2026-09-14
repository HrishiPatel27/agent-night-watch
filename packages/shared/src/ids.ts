import { randomBytes } from 'node:crypto';

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

/** Sortable, human readable run id: 2026-09-10-2310-a1b2c3 */
export function newSessionId(date: Date = new Date()): string {
  const d = date;
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `${stamp}-${randomBytes(3).toString('hex')}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}
