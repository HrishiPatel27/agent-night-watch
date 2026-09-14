import { formatDuration, formatUsd, plural, REASON_TEXT, VERSION, isReasonCode } from '@nightwatch-agent/shared';
import type { ReportModel } from './model.js';

export interface HtmlOptions {
  /** Live dashboard: auto-refresh and a stop button (token authorises /api/stop). */
  live?: { token: string };
}

const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const CSS = `
:root{--bg:#0f1117;--panel:#171a23;--line:#262b38;--text:#e6e8ef;--muted:#9aa3b5;--green:#37b26c;--yellow:#e0a43a;--red:#e05252;--blue:#5b8def;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme:light){:root{--bg:#f6f7fb;--panel:#fff;--line:#dfe3ec;--text:#1a1d26;--muted:#5d6577}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:1080px;margin:0 auto;padding:24px 20px 60px}h1{font-size:22px;margin:0 0 6px}h2{font-size:17px;margin:32px 0 10px;border-bottom:1px solid var(--line);padding-bottom:6px}
.head{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between}.badge{display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600;letter-spacing:.02em}
.green{background:rgba(55,178,108,.15);color:var(--green)}.yellow{background:rgba(224,164,58,.18);color:var(--yellow)}.red{background:rgba(224,82,82,.18);color:var(--red)}.blue{background:rgba(91,141,239,.18);color:var(--blue)}.grey{background:rgba(154,163,181,.18);color:var(--muted)}
.muted{color:var(--muted)}.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:10px 0}
.first{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}.first .panel{margin:0}.first h3{margin:0 0 6px;font-size:14px}
table{width:100%;border-collapse:collapse;font-size:13.5px}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:600}
code,pre{font-family:var(--mono);font-size:12.5px}pre{background:rgba(127,127,127,.08);padding:10px;border-radius:8px;overflow:auto;max-height:420px;white-space:pre-wrap;word-break:break-word}
details>summary{cursor:pointer;color:var(--blue)}.kv{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px}.sev{font-weight:700;text-transform:uppercase;font-size:11px}
.sev.critical,.sev.high{color:var(--red)}.sev.medium{color:var(--yellow)}.sev.low,.sev.info{color:var(--muted)}button{background:var(--red);color:#fff;border:0;border-radius:8px;padding:8px 14px;font-weight:600;cursor:pointer}
.diff .add{color:var(--green)}.diff .del{color:var(--red)}.diff .hunk{color:var(--blue)}footer{margin-top:40px;color:var(--muted);font-size:12.5px;border-top:1px solid var(--line);padding-top:12px}
`;

export function renderHtml(m: ReportModel, o: HtmlOptions = {}): string {
  const s = m.session;
  const live = o.live && m.live;
  const healthClass = m.health;
  const status = `${s.status}${s.stop_reason ? ` — ${s.stop_reason}` : ''}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nightwatch report · ${esc(s.id)}</title>${live ? '<meta http-equiv="refresh" content="10">' : ''}<style>${CSS}</style></head>
<body><main>
<div class="head"><div><h1>Nightwatch ${live ? 'live dashboard' : 'morning report'} <span class="badge ${healthClass}">${esc(m.health)}</span></h1>
<div class="muted">Run <code>${esc(s.id)}</code> · ${esc(s.agent)} · ${esc(s.mode)} mode · policy ${esc(m.policy.name)} v${esc(m.policy.version)} · started ${esc(s.started_at)}</div></div>
${live ? `<form onsubmit="event.preventDefault();fetch('/api/stop',{method:'POST',headers:{'X-Nightwatch-Token':'${esc(o.live!.token)}'}}).then(()=>location.reload())"><button type="submit">Stop run</button></form>` : ''}</div>

<div class="panel"><strong>${esc(m.headline)}</strong><div class="muted">Status: ${esc(status)}${m.healthReasons.length ? ` · ${esc(m.healthReasons.join(' · '))}` : ''}</div></div>

<h2>What to look at first</h2>
<div class="first">${m.lookFirst.map((i) => `<div class="panel"><h3>${esc(i.title)}</h3><div class="muted">${esc(i.detail)}</div></div>`).join('')}</div>

<h2>Findings <span class="muted">(${m.findings.length}, ranked by severity × confidence${m.skippedFindings ? `, ${m.skippedFindings} malformed skipped` : ''})</span></h2>
${m.findings.length ? m.findings.map(renderFinding).join('') : '<div class="panel muted">No findings were recorded.</div>'}

<h2>Test results <span class="muted">(${plural(m.tests.runs.length, 'run')}, ${m.tests.failing.length} failing)</span></h2>
${m.tests.runs.length ? `<table><tr><th>When</th><th>Command</th><th>Result</th><th>Summary</th></tr>${m.tests.runs.map((t) => `<tr><td class="muted">${esc(t.created_at.slice(11, 19))}</td><td><code>${esc(t.command)}</code></td><td><span class="badge ${t.ok ? 'green' : 'red'}">${t.ok ? 'pass' : 'fail'}</span></td><td>${esc(t.summary)}${failuresList(t.failures_json)}</td></tr>`).join('')}</table>` : '<div class="panel muted">No test runs were detected. Set <code>test_command</code> in the policy so runs are parsed.</div>'}

<h2>Blocked and deferred actions <span class="muted">(${m.counts.denied} denied, ${m.counts.deferred} deferred of ${m.counts.actions})</span></h2>
${m.blocked.length ? m.blocked.map((g) => `<div class="panel"><strong>${esc(g.code)}</strong> <span class="muted">× ${g.count} — ${esc(isReasonCode(g.code) ? REASON_TEXT[g.code] : '')}</span>
<table>${g.examples.map((e) => `<tr><td class="muted">#${e.seq}</td><td><code>${esc(e.tool)}</code></td><td><code>${esc(e.input_summary)}</code></td><td class="muted">${esc(e.reason_text)}</td></tr>`).join('')}</table></div>`).join('') : '<div class="panel muted">Nothing was blocked.</div>'}

<h2>Changed files <span class="muted">(${m.changes.files.length} files, ${plural(m.changes.commits.length, 'commit')})</span></h2>
${m.changes.worktreeExists ? '' : '<div class="panel muted">The run worktree no longer exists; file changes are unavailable (the patch may still be on disk).</div>'}
${m.changes.commits.length ? `<div class="panel"><strong>Commits on the run branch</strong><table>${m.changes.commits.map((c) => `<tr><td><code>${esc(c.sha)}</code></td><td>${esc(c.subject)}</td></tr>`).join('')}</table></div>` : ''}
${m.changes.diffStat ? `<pre>${esc(m.changes.diffStat)}</pre>` : ''}
${m.changes.patchFile ? `<div class="muted">Full patch: <code>${esc(m.changes.patchFile)}</code> — apply with <code>git apply</code> after review.</div>` : ''}
${m.changes.previews.map((p) => `<details><summary>${esc(p.path)}</summary><pre class="diff">${colorDiff(p.diff)}</pre></details>`).join('')}

<h2>Time, actions and usage</h2>
<div class="panel kv">
<span class="muted">Duration</span><span>${esc(formatDuration(m.usage.durationMs))} (limit ${esc(String(limitOf(s.limits_json, 'wall_time_minutes')))} min)</span>
<span class="muted">Actions</span><span>${m.counts.actions} attempted · ${m.counts.allowed} allowed · ${m.counts.denied} denied · ${m.counts.deferred} deferred (limit ${esc(String(limitOf(s.limits_json, 'actions')))})</span>
<span class="muted">Estimated usage</span><span>${esc(formatUsd(m.usage.costUsd))}${m.usage.model ? ` · ${esc(m.usage.model)}` : ''}${m.usage.turns != null ? ` · ${m.usage.turns} turns` : ''}</span>
<span class="muted">Tokens</span><span>${m.usage.tokens.input.toLocaleString()} in · ${m.usage.tokens.output.toLocaleString()} out · ${m.usage.tokens.cacheRead.toLocaleString()} cache read · ${m.usage.tokens.cacheWrite.toLocaleString()} cache write</span>
<span class="muted">Main tree</span><span>${m.mainTreeUnchanged == null ? '<span class="badge grey">not checked yet</span>' : m.mainTreeUnchanged ? '<span class="badge green">unchanged</span>' : '<span class="badge red">CHANGED — review git status</span>'}</span>
<span class="muted">Worktree</span><span><code>${esc(s.worktree)}</code>${s.branch ? ` · branch <code>${esc(s.branch)}</code>` : ''}</span>
</div>

${m.summaryText ? `<h2>Agent summary</h2><pre>${esc(m.summaryText)}</pre>` : ''}
${m.errors.length ? `<h2>Errors</h2><pre>${esc(m.errors.join('\n'))}</pre>` : ''}

<h2>Timeline <span class="muted">(last ${m.timeline.length} events)</span></h2>
<details${live ? ' open' : ''}><summary>Show events</summary><table><tr><th>#</th><th>Time</th><th>Event</th><th>Tool</th><th>Input</th><th>Decision</th><th>Result</th></tr>
${m.timeline.map((e) => `<tr><td class="muted">${e.seq}</td><td class="muted">${esc(e.created_at.slice(11, 19))}</td><td>${esc(e.event)}</td><td><code>${esc(e.tool ?? '')}</code></td><td><code>${esc(e.input_summary ?? '')}</code></td><td>${decisionBadge(e.decision, e.reason_code)}</td><td class="muted">${esc(e.result_summary ? e.result_summary.slice(0, 140) : '')}${e.duration_ms != null ? ` (${formatDuration(e.duration_ms)})` : ''}</td></tr>`).join('')}</table></details>

<h2>Coverage and policy</h2>
<div class="panel"><strong>Guarded surfaces:</strong> ${esc(m.coverage.covered.join(', ') || 'unknown')}<br><strong>Not covered:</strong> ${esc(m.coverage.uncovered.join('; ') || 'unknown')}</div>
<details><summary>Policy used for this run (${esc(m.policy.name)} v${esc(m.policy.version)})</summary><pre>${esc(m.policy.yaml)}</pre></details>

<footer>Nightwatch ${esc(VERSION)} · generated ${esc(m.generatedAt)}. This run was <em>guarded</em>, not sandboxed: hooks deny supported tool calls before they run, but they are not OS-level isolation and the log is not proof that nothing harmful happened. Prefer disposable credentials and test environments.</footer>
</main></body></html>`;
}

function renderFinding(f: ReportModel['findings'][number]): string {
  return `<div class="panel"><div><span class="sev ${esc(f.severity)}">${esc(f.severity)}</span> <span class="muted">confidence ${(f.confidence * 100).toFixed(0)}% · ${esc(f.source)}</span></div>
<strong>${esc(f.title)}</strong><div>${esc(f.summary)}</div>
${f.files?.length ? `<div class="muted">Files: ${f.files.map((x) => `<code>${esc(x)}</code>`).join(', ')}</div>` : ''}
${f.evidence ? `<details><summary>Evidence</summary><pre>${esc(f.evidence)}</pre></details>` : ''}
${f.proposed_fix ? `<details><summary>Proposed fix</summary><pre>${esc(f.proposed_fix)}</pre></details>` : ''}</div>`;
}

function failuresList(json: string): string {
  try {
    const arr = JSON.parse(json) as string[];
    if (!arr.length) return '';
    return `<details><summary>${plural(arr.length, 'failure line')}</summary><pre>${esc(arr.join('\n'))}</pre></details>`;
  } catch {
    return '';
  }
}

function decisionBadge(d: string | null, code: string | null): string {
  if (!d) return '';
  const cls = d === 'allow' ? 'green' : d === 'deny' ? 'red' : 'yellow';
  return `<span class="badge ${cls}">${esc(d)}</span>${code && d !== 'allow' ? ` <span class="muted">${esc(code)}</span>` : ''}`;
}

function colorDiff(diff: string): string {
  return diff
    .split('\n')
    .map((l) => {
      const e = esc(l);
      if (l.startsWith('+++') || l.startsWith('---')) return `<span class="muted">${e}</span>`;
      if (l.startsWith('@@')) return `<span class="hunk">${e}</span>`;
      if (l.startsWith('+')) return `<span class="add">${e}</span>`;
      if (l.startsWith('-')) return `<span class="del">${e}</span>`;
      return e;
    })
    .join('\n');
}

function limitOf(json: string, key: string): unknown {
  try {
    return (JSON.parse(json) as Record<string, unknown>)[key] ?? '?';
  } catch {
    return '?';
  }
}
