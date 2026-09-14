export interface ParsedTestRun {
  ok: boolean;
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  summary: string;
  failures: string[];
}

const TEST_RUNNER_RE = /\b(npm test|npm run test|yarn test|pnpm test|bun test|jest|vitest|mocha|ava|pytest|py\.test|python3? -m pytest|unittest|cargo test|go test|dotnet test|mvn test|gradle test|gradlew test|rspec|minitest|phpunit|ctest|make test|deno test|swift test|mix test|cypress run|playwright test)\b/;
const ANSI_RE = new RegExp('\\u001b\\[[0-9;]*m', 'g');

export function looksLikeTestCommand(command: string, testCommand?: string | null): boolean {
  if (testCommand && command.trim().startsWith(testCommand.trim())) return true;
  return TEST_RUNNER_RE.test(command);
}

/** Best-effort parse of common test runner summaries. Exit code (if known) is authoritative for ok. */
export function parseTestOutput(command: string, output: string, exitCode: number | null): ParsedTestRun {
  const text = output.replace(ANSI_RE, '');
  let passed: number | null = null;
  let failed: number | null = null;
  let skipped: number | null = null;
  let m: RegExpExecArray | null;
  if ((m = /Tests:\s+(?:(\d+) failed, )?(?:(\d+) skipped, )?(?:(\d+) todo, )?(?:(\d+) passed, )?(\d+) total/.exec(text))) {
    // jest / vitest
    failed = m[1] ? Number(m[1]) : 0;
    skipped = m[2] ? Number(m[2]) : 0;
    passed = m[4] ? Number(m[4]) : 0;
  } else if ((m = /=+ (?:(\d+) failed,? )?(?:(\d+) passed)?(?:,? (\d+) skipped)?(?:,? (\d+) errors?)?[^=\n]* in [\d.]+s/.exec(text))) {
    // pytest
    failed = Number(m[1] ?? 0) + Number(m[4] ?? 0);
    passed = Number(m[2] ?? 0);
    skipped = Number(m[3] ?? 0);
  } else if ((m = /test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored/.exec(text))) {
    // cargo
    passed = Number(m[2]);
    failed = Number(m[3]);
    skipped = Number(m[4]);
  } else if ((m = /(\d+) passing(?:\s*\([^)]*\))?\s*(?:(\d+) pending)?\s*(?:(\d+) failing)?/.exec(text))) {
    // mocha
    passed = Number(m[1]);
    skipped = m[2] ? Number(m[2]) : 0;
    failed = m[3] ? Number(m[3]) : 0;
  } else if ((m = /Ran (\d+) tests?[\s\S]*?\n(OK|FAILED \([^)]*\))/.exec(text))) {
    // unittest
    const total = Number(m[1]);
    const f = /failures=(\d+)/.exec(m[2]);
    const e = /errors=(\d+)/.exec(m[2]);
    failed = (f ? Number(f[1]) : 0) + (e ? Number(e[1]) : 0);
    passed = total - failed;
  } else if ((m = /(\d+) examples?, (\d+) failures?(?:, (\d+) pending)?/.exec(text))) {
    // rspec
    failed = Number(m[2]);
    passed = Number(m[1]) - failed;
    skipped = m[3] ? Number(m[3]) : 0;
  } else if ((m = /(?:Passed|Failed)!\s+-\s+Failed:\s+(\d+),\s+Passed:\s+(\d+),\s+Skipped:\s+(\d+)/.exec(text))) {
    // dotnet
    failed = Number(m[1]);
    passed = Number(m[2]);
    skipped = Number(m[3]);
  } else if ((m = /Tests run: (\d+), Failures: (\d+), Errors: (\d+), Skipped: (\d+)/.exec(text))) {
    // maven surefire
    failed = Number(m[2]) + Number(m[3]);
    skipped = Number(m[4]);
    passed = Number(m[1]) - failed - skipped;
  } else if ((m = /OK \((\d+) tests?, \d+ assertions?\)/.exec(text))) {
    // phpunit
    passed = Number(m[1]);
    failed = 0;
  } else if ((m = /FAILURES!\s+Tests: (\d+), Assertions: \d+,(?: Errors: (\d+),)? Failures: (\d+)/.exec(text))) {
    failed = Number(m[3]) + Number(m[2] ?? 0);
    passed = Number(m[1]) - failed;
  } else if (/go test/.test(command)) {
    const fails = (text.match(/^--- FAIL/gm) ?? []).length;
    const oks = (text.match(/^ok\s/gm) ?? []).length;
    if (fails || oks) {
      failed = fails;
      passed = oks;
    }
  }
  const failures: string[] = [];
  for (const line of text.split('\n')) {
    if (/^\s*(✕|×|✗|FAIL[ :]|FAILED[ :]|--- FAIL|●\s|not ok|E\s{2,}|AssertionError|Error:)/.test(line) && failures.length < 40) failures.push(line.trim().slice(0, 300));
  }
  const ok = exitCode != null ? exitCode === 0 : failed != null ? failed === 0 : !/\b(FAIL|FAILED|failing|failures?:\s*[1-9])\b/.test(text);
  const parts: string[] = [];
  if (passed != null) parts.push(`${passed} passed`);
  if (failed != null) parts.push(`${failed} failed`);
  if (skipped) parts.push(`${skipped} skipped`);
  const summary = parts.length ? parts.join(', ') : ok ? 'passed' : 'failed';
  return { ok, passed, failed, skipped, summary, failures };
}
