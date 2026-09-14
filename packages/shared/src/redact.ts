import { createHash } from 'node:crypto';

/**
 * Redaction happens before anything is persisted. It is deliberately
 * aggressive: a false positive costs a little forensic detail, a false negative
 * stores a secret on disk.
 */
const BUILTIN_PATTERNS: RegExp[] = [
  // Well-known token shapes
  /\b(sk|rk|pk)[-_](live|test|ant|proj)?[-_]?[A-Za-z0-9_-]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bASIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\bya29\.[0-9A-Za-z_-]{20,}\b/g,
  /\bnpm_[A-Za-z0-9]{30,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bhf_[A-Za-z0-9]{30,}\b/g,
  // JWTs
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  // Authorization headers
  /(authorization\s*[:=]\s*)(bearer|basic|token)\s+[^\s'"]+/gi,
  // Private key blocks
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // URL credentials: scheme://user:pass@host
  /([a-z][a-z0-9+.-]*:\/\/[^\s/:@'"]+:)([^\s/@'"]+)(@)/gi,
  // KEY=VALUE and "key": "value" where the key looks secret-ish
  /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY|AUTH)[A-Z0-9_]*)(\s*[=:]\s*)(["']?)([^\s"'&;]{4,})\3/gi,
  // CLI flags carrying secrets
  /(--?(?:password|passwd|token|api[-_]?key|secret|auth)(?:=|\s+))(["']?)([^\s"']{3,})\2/gi,
];

const REPLACEMENT = '[REDACTED]';

export interface RedactOptions {
  extraPatterns?: (string | RegExp)[];
}

export function compilePatterns(extra: (string | RegExp)[] | undefined): RegExp[] {
  const out = [...BUILTIN_PATTERNS];
  for (const p of extra ?? []) {
    if (p instanceof RegExp) {
      out.push(new RegExp(p.source, p.flags.includes('g') ? p.flags : p.flags + 'g'));
    } else if (typeof p === 'string' && p.length > 0) {
      try {
        out.push(new RegExp(p, 'gi'));
      } catch {
        // Ignore invalid user patterns; the policy loader reports them separately.
      }
    }
  }
  return out;
}

export function redactText(text: string, options: RedactOptions = {}): string {
  if (!text) return text;
  let out = text;
  for (const re of compilePatterns(options.extraPatterns)) {
    re.lastIndex = 0;
    out = out.replace(re, (match: string, ...groups: unknown[]) => {
      // Preserve the "key=" prefix for readability when we captured one.
      const first = groups[0];
      if (typeof first === 'string' && match.startsWith(first) && first.length < match.length) {
        // Special-case URL credentials: keep scheme://user: and @host.
        const third = groups[2];
        if (third === '@') return `${first}${REPLACEMENT}@`;
        const second = groups[1];
        if (typeof second === 'string' && /^\s*[=:]\s*$/.test(second)) {
          return `${first}${second}${REPLACEMENT}`;
        }
        return `${first}${REPLACEMENT}`;
      }
      return REPLACEMENT;
    });
  }
  return out;
}

/** Redact every string inside a JSON-ish value, recursively. */
export function redactValue<T>(value: T, options: RedactOptions = {}): T {
  if (typeof value === 'string') return redactText(value, options) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, options)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = /(secret|token|password|passwd|api_?key|private_?key|authorization)/i.test(k)
        ? REPLACEMENT
        : redactValue(v, options);
    }
    return out as unknown as T;
  }
  return value;
}

/** Short, stable digest of a tool input for forensics without storing raw data. */
export function digest(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export function truncate(text: string, max = 300): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

/** One-line, redacted description of a tool call for logs and reports. */
export function summarizeToolInput(tool: string, input: Record<string, unknown> | undefined, options: RedactOptions = {}): string {
  const inp = input ?? {};
  const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v));
  const filePath = str(inp.file_path ?? inp.path ?? inp.notebook_path);
  let summary: string;
  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      summary = str(inp.command);
      break;
    case 'Read':
    case 'NotebookRead':
      summary = filePath;
      break;
    case 'Write': {
      const content = str(inp.content ?? inp.file_text);
      summary = `${filePath} (${Buffer.byteLength(content)} bytes)`;
      break;
    }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      summary = filePath;
      break;
    case 'Glob':
      summary = `${str(inp.pattern)}${inp.path ? ` in ${str(inp.path)}` : ''}`;
      break;
    case 'Grep':
      summary = `/${str(inp.pattern)}/${inp.path ? ` in ${str(inp.path)}` : ''}`;
      break;
    case 'WebFetch':
      summary = str(inp.url);
      break;
    case 'WebSearch':
      summary = str(inp.query);
      break;
    case 'Task':
    case 'Agent':
      summary = str(inp.description ?? inp.prompt ?? inp.task);
      break;
    default:
      summary = Object.keys(inp).length ? `keys: ${Object.keys(inp).sort().join(', ')}` : '';
  }
  return truncate(redactText(summary, options), 400);
}
