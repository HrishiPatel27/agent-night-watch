import fs from 'node:fs';
import path from 'node:path';
import { FINDINGS_FILE, redactText, type Finding, type FindingSeverity } from '@nightwatch-agent/shared';

const SEVERITIES: FindingSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];

/** Read findings the agent appended to NIGHTWATCH_FINDINGS.jsonl in the worktree. Malformed lines are skipped. */
export function readAgentFindings(worktree: string): { findings: Finding[]; skipped: number } {
  const file = path.join(worktree, FINDINGS_FILE);
  if (!fs.existsSync(file)) return { findings: [], skipped: 0 };
  const findings: Finding[] = [];
  let skipped = 0;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    try {
      const raw = JSON.parse(line) as Record<string, unknown>;
      const title = str(raw.title);
      if (!title) throw new Error('missing title');
      const sev = String(raw.severity ?? 'medium').toLowerCase() as FindingSeverity;
      const conf = Number(raw.confidence);
      findings.push({
        id: `agent-${i + 1}`,
        title: redactText(title).slice(0, 200),
        severity: SEVERITIES.includes(sev) ? sev : 'medium',
        confidence: Number.isFinite(conf) ? Math.min(1, Math.max(0, conf > 1 ? conf / 100 : conf)) : 0.5,
        summary: redactText(str(raw.summary) ?? str(raw.description) ?? '').slice(0, 2000),
        evidence: raw.evidence ? redactText(String(raw.evidence)).slice(0, 4000) : undefined,
        files: Array.isArray(raw.files) ? raw.files.filter((f): f is string => typeof f === 'string').slice(0, 20) : undefined,
        proposed_fix: raw.proposed_fix ? redactText(String(raw.proposed_fix)).slice(0, 4000) : undefined,
        source: 'agent',
      });
    } catch {
      skipped++;
    }
  });
  return { findings, skipped };
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

export const FINDINGS_INSTRUCTIONS = `Record every finding worth a human's attention by appending one JSON object per line to the file ${FINDINGS_FILE} in the working directory, with this shape:
{"title": "short title", "severity": "critical|high|medium|low|info", "confidence": 0.0-1.0, "summary": "what and why it matters", "evidence": "how you verified it (command, output, file:line)", "files": ["path/one.ts"], "proposed_fix": "concrete change or patch description"}
Prefer fewer, well-evidenced findings over many speculative ones.`;
