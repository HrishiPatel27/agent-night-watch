import { formatDuration, formatUsd, plural } from '@nightwatch-agent/shared';
import { summaryLine, type ReportModel } from './model.js';

export function renderMarkdown(m: ReportModel): string {
  const s = m.session;
  const lines: string[] = [];
  lines.push(`# Nightwatch report · ${s.id}`, '', `**${m.headline}**`, '', `Health: **${m.health}**${m.healthReasons.length ? ` (${m.healthReasons.join(', ')})` : ''} · status: ${s.status}${s.stop_reason ? ` — ${s.stop_reason}` : ''}`, '');
  lines.push('## What to look at first', '');
  for (const i of m.lookFirst) lines.push(`- **${i.title}** — ${i.detail}`);
  lines.push('', `## Findings (${m.findings.length})`, '');
  if (!m.findings.length) lines.push('_None recorded._');
  for (const f of m.findings) {
    lines.push(`### [${f.severity.toUpperCase()} · ${(f.confidence * 100).toFixed(0)}%] ${f.title}`, '', f.summary);
    if (f.files?.length) lines.push('', `Files: ${f.files.map((x) => `\`${x}\``).join(', ')}`);
    if (f.evidence) lines.push('', '<details><summary>Evidence</summary>', '', '```', f.evidence, '```', '', '</details>');
    if (f.proposed_fix) lines.push('', '**Proposed fix**', '', f.proposed_fix);
    lines.push('');
  }
  lines.push(`## Tests (${plural(m.tests.runs.length, 'run')}, ${m.tests.failing.length} failing)`, '');
  for (const t of m.tests.runs) lines.push(`- ${t.ok ? '✅' : '❌'} \`${t.command}\` — ${t.summary}`);
  if (!m.tests.runs.length) lines.push('_No test runs detected._');
  lines.push('', `## Blocked and deferred actions (${m.counts.denied} denied, ${m.counts.deferred} deferred of ${m.counts.actions})`, '');
  for (const g of m.blocked) {
    lines.push(`- **${g.code}** × ${g.count}`);
    for (const e of g.examples.slice(0, 4)) lines.push(`  - \`${e.tool}\`: \`${e.input_summary ?? ''}\` — ${e.reason_text ?? ''}`);
  }
  if (!m.blocked.length) lines.push('_Nothing was blocked._');
  lines.push('', `## Changed files (${m.changes.files.length})`, '');
  for (const c of m.changes.commits) lines.push(`- commit \`${c.sha}\` ${c.subject}`);
  if (m.changes.diffStat) lines.push('', '```', m.changes.diffStat, '```');
  if (m.changes.patchFile) lines.push('', `Patch: \`${m.changes.patchFile}\``);
  lines.push('', '## Time, actions and usage', '');
  lines.push(`- Duration: ${formatDuration(m.usage.durationMs)}`, `- Actions: ${m.counts.actions} (${m.counts.allowed} allowed, ${m.counts.denied} denied, ${m.counts.deferred} deferred)`, `- Estimated usage: ${formatUsd(m.usage.costUsd)}${m.usage.model ? ` (${m.usage.model})` : ''}`, `- Tokens: ${m.usage.tokens.input} in / ${m.usage.tokens.output} out / ${m.usage.tokens.cacheRead} cache read`, `- Main tree unchanged: ${m.mainTreeUnchanged == null ? 'not checked' : m.mainTreeUnchanged ? 'yes' : 'NO — review git status'}`);
  if (m.summaryText) lines.push('', '## Agent summary', '', m.summaryText);
  lines.push('', '## Coverage', '', `Guarded: ${m.coverage.covered.join(', ') || 'unknown'}`, '', `Not covered: ${m.coverage.uncovered.join('; ') || 'unknown'}`, '');
  lines.push('_Guarded, not sandboxed. The log is evidence, not proof of absence of harm._');
  return lines.join('\n');
}

/** Compact terminal rendering used by `nightwatch report`. */
export function renderTerminal(m: ReportModel): string {
  const s = m.session;
  const out: string[] = [];
  out.push(`${s.id}  [${m.health.toUpperCase()}]  ${summaryLine(m)}`);
  out.push(`  ${m.headline}`);
  out.push(`  status: ${s.status}${s.stop_reason ? ` — ${s.stop_reason}` : ''}`);
  out.push('', '  Look at this first:');
  for (const i of m.lookFirst) out.push(`   • ${i.title}: ${i.detail}`);
  if (m.findings.length) {
    out.push('', '  Findings:');
    for (const f of m.findings.slice(0, 10)) out.push(`   [${f.severity.padEnd(8)} ${(f.confidence * 100).toFixed(0).padStart(3)}%] ${f.title}`);
  }
  if (m.blocked.length) {
    out.push('', '  Blocked:');
    for (const g of m.blocked) out.push(`   ${g.code.padEnd(20)} × ${g.count}   e.g. ${g.examples[0]?.tool}: ${(g.examples[0]?.input_summary ?? '').slice(0, 70)}`);
  }
  if (m.changes.files.length) out.push('', `  Changed: ${m.changes.files.length} files, ${m.changes.commits.length} commits${m.changes.patchFile ? ` (patch: ${m.changes.patchFile})` : ''}`);
  return out.join('\n');
}

export { summaryLine };
