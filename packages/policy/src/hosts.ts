/** Extract hostnames from URL-like or user@host-like strings. */
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/(?:[^\s/@:'"]+(?::[^\s/@'"]*)?@)?(\[[0-9a-f:.]+\]|[^\s/:?#'"]+)/gi;

export function hostsFromText(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(URL_RE)) out.add(m[1].toLowerCase());
  return [...out];
}

export function hostFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    return u.hostname.toLowerCase();
  } catch {
    const hosts = hostsFromText(url);
    return hosts[0] ?? null;
  }
}

/** "user@host", "host:path" (scp/rsync) or bare hostnames for ssh-like tools. */
export function hostFromRemoteSpec(spec: string): string | null {
  if (!spec || spec.startsWith('-')) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(spec)) return hostFromUrl(spec);
  const at = spec.lastIndexOf('@');
  let rest = at >= 0 ? spec.slice(at + 1) : spec;
  const colon = rest.indexOf(':');
  if (colon > 0) rest = rest.slice(0, colon);
  if (/^[A-Za-z0-9.-]+$/.test(rest) && (rest.includes('.') || /^[a-z0-9-]+$/i.test(rest))) return rest.toLowerCase();
  return null;
}

export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || host === '0.0.0.0' || host.endsWith('.localhost');
}
