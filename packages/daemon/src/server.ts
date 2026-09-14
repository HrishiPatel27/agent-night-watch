import http from 'node:http';
import fs from 'node:fs';
import { evaluate } from '@nightwatch-agent/policy';
import { randomToken, type PolicyContext, type ToolCallRequest } from '@nightwatch-agent/shared';
import type { NightwatchStore } from './store.js';

export interface ServerOptions {
  store: NightwatchStore;
  sessionId: string;
  port: number;
  tokenFile: string;
  /** Renders the live HTML report for the session; the token lets the page call /api/stop. */
  render: (sessionId: string, token: string) => string;
  /** Builds the JSON report model. */
  model: (sessionId: string) => unknown;
  /** Policy context factory for /api/evaluate (the generic integration endpoint). */
  policyContext?: () => PolicyContext;
  onStop?: (reason: string) => void;
}

export interface RunningServer {
  url: string;
  token: string;
  close(): Promise<void>;
}

/** Loopback-only dashboard and JSON API. Mutating endpoints require the per-run token. */
export function startServer(o: ServerOptions): Promise<RunningServer> {
  const token = randomToken();
  fs.writeFileSync(o.tokenFile, token, { mode: 0o600 });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const send = (status: number, body: string, type = 'application/json; charset=utf-8') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
      res.end(body);
    };
    const json = (status: number, v: unknown) => send(status, JSON.stringify(v));
    const authed = () => req.headers['x-nightwatch-token'] === token;
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/report')) {
        return send(200, o.render(o.sessionId, token), 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && url.pathname === '/healthz') return json(200, { ok: true, session: o.sessionId });
      if (req.method === 'GET' && url.pathname === '/api/status') {
        const s = o.store.getSession(o.sessionId);
        return json(200, { session: s, actions: o.store.countActions(o.sessionId), decisions: o.store.countByDecision(o.sessionId), consecutiveDenials: o.store.consecutiveDenials(o.sessionId) });
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        const after = Number(url.searchParams.get('after') ?? 0);
        return json(200, o.store.listEvents(o.sessionId, { afterSeq: after, limit: Number(url.searchParams.get('limit') ?? 500) }));
      }
      if (req.method === 'GET' && url.pathname === '/api/report.json') return json(200, o.model(o.sessionId));
      if (req.method === 'GET' && url.pathname === '/api/sessions') return json(200, o.store.listSessions(50));
      if (req.method === 'POST' && url.pathname === '/api/stop') {
        if (!authed()) return json(403, { error: 'missing or invalid X-Nightwatch-Token' });
        o.store.requestStop(o.sessionId, 'stopped from dashboard');
        o.onStop?.('stopped from dashboard');
        return json(200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/evaluate') {
        if (!authed()) return json(403, { error: 'missing or invalid X-Nightwatch-Token' });
        if (!o.policyContext) return json(501, { error: 'evaluation not available' });
        let body = '';
        req.on('data', (c) => {
          body += c;
          if (body.length > 1_000_000) req.destroy();
        });
        req.on('end', () => {
          try {
            const r = JSON.parse(body) as ToolCallRequest;
            const d = evaluate({ tool: String(r.tool), input: r.input ?? {}, cwd: r.cwd ?? process.cwd() }, o.policyContext!());
            json(200, d);
          } catch (err) {
            json(400, { error: (err as Error).message });
          }
        });
        return;
      }
      json(404, { error: 'not found' });
    } catch (err) {
      json(500, { error: (err as Error).message });
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${o.port}`,
        token,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
