/**
 * A deliberately narrow POSIX-shell tokenizer. It does not aim to implement
 * bash; it aims to split a command line into simple commands well enough to
 * classify them, and to *notice* when it does not understand something so the
 * engine can fail closed.
 */

export interface Redirect {
  /** e.g. ">", ">>", "<", "2>", "&>", ">&" */
  op: string;
  target: string;
}

export interface SimpleCommand {
  /** Tokens after quote removal; argv[0] is the command word (may be empty for pure assignments). */
  argv: string[];
  /** Leading VAR=value assignments. */
  assignments: string[];
  /** Wrappers removed to reach `argv` (sudo, env, nohup, bash -c, …). */
  wrappers: string[];
  /** Approximate source text of this segment. */
  raw: string;
  /** Terminated by a single `&`. */
  background: boolean;
  redirects: Redirect[];
  /** True when a privilege-escalation wrapper (sudo/doas/su/pkexec/runas) was unwrapped. */
  privileged: boolean;
  /** True when a detaching wrapper (nohup/setsid/…) was unwrapped. */
  detached: boolean;
  /** Reads its program from a pipe (e.g. `curl … | sh`). */
  pipedFrom: boolean;
  /** Contains a here-document. */
  hereDoc: boolean;
}

export interface ParsedCommand {
  segments: SimpleCommand[];
  /** Command substitutions found (`$(…)`, backticks); they are also parsed into `segments`. */
  substitutions: string[];
  /** False if the parser met a construct it does not model. */
  complete: boolean;
  notes: string[];
}

const SHELL_KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'in',
  'function', 'select', '!', '{', '}', 'time',
]);

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'busybox']);
const PRIVILEGE_WRAPPERS = new Set(['sudo', 'doas', 'su', 'pkexec', 'runas', 'gsudo', 'sudo.exe']);
const DETACH_WRAPPERS = new Set(['nohup', 'setsid', 'disown', 'daemonize', 'start-stop-daemon']);

/** Strip directory and Windows extension from a command word: /usr/bin/rm → rm, node.exe → node */
export function commandName(word: string): string {
  if (!word) return '';
  let w = word.replace(/\\/g, '/');
  const slash = w.lastIndexOf('/');
  if (slash >= 0) w = w.slice(slash + 1);
  w = w.replace(/\.(exe|cmd|bat|com|ps1)$/i, '');
  return w.toLowerCase();
}

interface Token {
  kind: 'word' | 'op';
  text: string;
  /** For words: true if any part of the word was quoted (affects keyword detection). */
  quoted?: boolean;
}

interface LexResult {
  tokens: Token[];
  substitutions: string[];
  complete: boolean;
  notes: string[];
  hereDocs: number;
}

function isSpace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\r';
}

function lex(src: string): LexResult {
  const tokens: Token[] = [];
  const substitutions: string[] = [];
  const notes: string[] = [];
  let complete = true;
  let hereDocs = 0;
  let i = 0;
  let word = '';
  let inWord = false;
  let quoted = false;
  const pendingHereDocs: string[] = [];

  const flush = () => {
    if (inWord) {
      tokens.push({ kind: 'word', text: word, quoted });
    }
    word = '';
    inWord = false;
    quoted = false;
  };
  const op = (text: string) => {
    flush();
    tokens.push({ kind: 'op', text });
  };

  // Reads a $(...) starting at index of '(' ; returns [content, nextIndex]
  const readParenSubst = (start: number): [string, number] => {
    let depth = 0;
    let j = start;
    for (; j < src.length; j++) {
      const c = src[j];
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) return [src.slice(start + 1, j), j + 1];
      } else if (c === "'") {
        const end = src.indexOf("'", j + 1);
        j = end < 0 ? src.length : end;
      } else if (c === '\\') j++;
    }
    complete = false;
    notes.push('unterminated $(');
    return [src.slice(start + 1), src.length];
  };

  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    // Here-document body skipping: after a newline, if we have pending heredoc delimiters, skip lines.
    if (c === '\n' && pendingHereDocs.length) {
      op(';');
      i++;
      while (pendingHereDocs.length) {
        const delim = pendingHereDocs.shift()!;
        for (;;) {
          const nl = src.indexOf('\n', i);
          const line = (nl < 0 ? src.slice(i) : src.slice(i, nl)).replace(/^\t+/, '');
          i = nl < 0 ? src.length : nl + 1;
          if (line === delim || nl < 0) break;
        }
      }
      continue;
    }

    if (c === '\n' || c === ';') {
      op(';');
      i++;
      continue;
    }
    if (isSpace(c)) {
      flush();
      i++;
      continue;
    }
    if (c === '#' && !inWord) {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl;
      continue;
    }
    if (c === '&') {
      if (next === '&') {
        op('&&');
        i += 2;
      } else if (next === '>') {
        // &> or &>>
        flush();
        if (src[i + 2] === '>') {
          tokens.push({ kind: 'op', text: '&>>' });
          i += 3;
        } else {
          tokens.push({ kind: 'op', text: '&>' });
          i += 2;
        }
      } else {
        op('&');
        i++;
      }
      continue;
    }
    if (c === '|') {
      if (next === '|') {
        op('||');
        i += 2;
      } else if (next === '&') {
        op('|&');
        i += 2;
      } else {
        op('|');
        i++;
      }
      continue;
    }
    if (c === '(' || c === ')') {
      if (inWord && c === '(' ) {
        // function definition `name()` or extglob; treat as not understood
        complete = false;
        notes.push('function definition or extglob');
      }
      op(c);
      i++;
      continue;
    }
    if (c === '<' && next === '(') {
      complete = false;
      notes.push('process substitution');
      const [, end] = readParenSubst(i + 1);
      i = end;
      continue;
    }
    if (c === '>' && next === '(') {
      complete = false;
      notes.push('process substitution');
      const [, end] = readParenSubst(i + 1);
      i = end;
      continue;
    }
    if (c === '>' || c === '<') {
      // Redirection. A preceding pure-digit word is the fd.
      let fd = '';
      if (inWord && /^\d+$/.test(word)) {
        fd = word;
        word = '';
        inWord = false;
      } else {
        flush();
      }
      let opText = c;
      i++;
      if (src[i] === c) {
        opText += c;
        i++;
        if (c === '<' && src[i] === '<') {
          opText += '<';
          i++;
        }
      }
      if (src[i] === '&') {
        opText += '&';
        i++;
      }
      if (src[i] === '|') {
        opText += '|';
        i++;
      }
      if (opText === '<<' || opText === '<<-') {
        // here-doc: the next word is the delimiter
        hereDocs++;
        while (isSpace(src[i] ?? '')) i++;
        let delim = '';
        while (i < src.length && !isSpace(src[i]) && src[i] !== '\n' && src[i] !== ';') delim += src[i++];
        delim = delim.replace(/^['"]|['"]$/g, '');
        pendingHereDocs.push(delim);
        tokens.push({ kind: 'op', text: 'HEREDOC' });
        continue;
      }
      tokens.push({ kind: 'op', text: fd + opText });
      continue;
    }

    // Word characters
    inWord = true;
    if (c === "'") {
      quoted = true;
      const end = src.indexOf("'", i + 1);
      if (end < 0) {
        complete = false;
        notes.push('unterminated single quote');
        word += src.slice(i + 1);
        i = src.length;
      } else {
        word += src.slice(i + 1, end);
        i = end + 1;
      }
      continue;
    }
    if (c === '"') {
      quoted = true;
      i++;
      let closed = false;
      while (i < src.length) {
        const d = src[i];
        if (d === '"') {
          closed = true;
          i++;
          break;
        }
        if (d === '\\' && i + 1 < src.length) {
          word += src[i + 1];
          i += 2;
          continue;
        }
        if (d === '$' && src[i + 1] === '(') {
          const [content, end] = readParenSubst(i + 1);
          substitutions.push(content);
          word += `$(${content})`;
          i = end;
          continue;
        }
        if (d === '`') {
          const end = src.indexOf('`', i + 1);
          const content = end < 0 ? src.slice(i + 1) : src.slice(i + 1, end);
          substitutions.push(content);
          word += `$(${content})`;
          i = end < 0 ? src.length : end + 1;
          continue;
        }
        word += d;
        i++;
      }
      if (!closed) {
        complete = false;
        notes.push('unterminated double quote');
      }
      continue;
    }
    if (c === '\\') {
      if (next === '\n') {
        i += 2; // line continuation
        continue;
      }
      word += next ?? '';
      i += 2;
      continue;
    }
    if (c === '$' && next === '(') {
      if (src[i + 2] === '(') {
        // arithmetic $(( ... ))
        const [content, end] = readParenSubst(i + 1);
        word += `$(${content})`;
        i = end;
        continue;
      }
      const [content, end] = readParenSubst(i + 1);
      substitutions.push(content);
      word += `$(${content})`;
      i = end;
      continue;
    }
    if (c === '`') {
      const end = src.indexOf('`', i + 1);
      const content = end < 0 ? src.slice(i + 1) : src.slice(i + 1, end);
      substitutions.push(content);
      word += `$(${content})`;
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    word += c;
    i++;
  }
  flush();
  if (pendingHereDocs.length) {
    // heredoc without a body in this string – content presumably follows; fine.
  }
  return { tokens, substitutions, complete, notes, hereDocs };
}

const REDIRECT_OP = /^(\d*)(>>|>|<<<|<|&>>|&>|>&|<&|>\|)(\d*)$/;

function tokensToSegments(tokens: Token[]): { segments: SimpleCommand[]; notes: string[]; complete: boolean } {
  const segments: SimpleCommand[] = [];
  const notes: string[] = [];
  let complete = true;
  const st: { cur: SimpleCommand | null } = { cur: null };
  let pipedNext = false;
  let hereDocNext = false;

  const start = (): SimpleCommand => {
    st.cur = {
      argv: [],
      assignments: [],
      wrappers: [],
      raw: '',
      background: false,
      redirects: [],
      privileged: false,
      detached: false,
      pipedFrom: pipedNext,
      hereDoc: hereDocNext,
    };
    pipedNext = false;
    hereDocNext = false;
    return st.cur;
  };
  const end = () => {
    const cur = st.cur;
    if (cur && (cur.argv.length || cur.assignments.length || cur.redirects.length)) {
      cur.raw = [...cur.assignments, ...cur.argv].join(' ').trim();
      segments.push(cur);
    }
    st.cur = null;
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === 'op') {
      if (t.text === 'HEREDOC') {
        if (st.cur) st.cur.hereDoc = true;
        continue;
      }
      const m = REDIRECT_OP.exec(t.text);
      if (m) {
        const cur = st.cur ?? start();
        const nextTok = tokens[i + 1];
        // "2>&1" style: fd duplication, no target file
        if (t.text.endsWith('&') && nextTok && nextTok.kind === 'word' && /^\d+$/.test(nextTok.text)) {
          cur.redirects.push({ op: t.text, target: `&${nextTok.text}` });
          i++;
          continue;
        }
        if (t.text.includes('&') && /\d$/.test(t.text) && !t.text.endsWith('&')) {
          cur.redirects.push({ op: t.text, target: '' });
          continue;
        }
        if (nextTok && nextTok.kind === 'word') {
          cur.redirects.push({ op: t.text, target: nextTok.text });
          i++;
        } else {
          complete = false;
          notes.push('redirection without target');
        }
        continue;
      }
      switch (t.text) {
        case ';':
        case '&&':
        case '||':
          end();
          break;
        case '&':
          if (st.cur) st.cur.background = true;
          else if (segments.length) segments[segments.length - 1].background = true;
          end();
          break;
        case '|':
        case '|&':
          end();
          pipedNext = true;
          break;
        case '(':
        case ')':
          end();
          break;
        default:
          complete = false;
          notes.push(`unknown operator ${t.text}`);
      }
      continue;
    }
    // word
    const seg = st.cur ?? start();
    if (seg.argv.length === 0 && !t.quoted && /^[A-Za-z_][A-Za-z0-9_]*(\+?=)/.test(t.text)) {
      seg.assignments.push(t.text);
      continue;
    }
    if (seg.argv.length === 0 && !t.quoted && SHELL_KEYWORDS.has(t.text)) {
      // `if cmd`, `then cmd`, `! cmd`, `time cmd`, `{ cmd; }` — drop the keyword.
      if (t.text === 'time') seg.wrappers.push('time');
      if (t.text === 'for' || t.text === 'case' || t.text === 'select' || t.text === 'function') {
        // The rest of this segment is loop/case header, not a command.
        seg.wrappers.push(t.text);
        while (i + 1 < tokens.length && tokens[i + 1].kind === 'word') i++;
        end();
        continue;
      }
      continue;
    }
    seg.argv.push(t.text);
  }
  end();
  return { segments, notes, complete };
}

const MAX_DEPTH = 6;

/**
 * Parse a shell command line into simple commands, recursively expanding
 * `bash -c`, `eval`, `xargs`, `sudo`, `env` and command substitutions.
 */
export function parseCommand(command: string, depth = 0): ParsedCommand {
  const lexed = lex(command);
  const { segments: rawSegments, notes: segNotes, complete: segComplete } = tokensToSegments(lexed.tokens);
  const notes = [...lexed.notes, ...segNotes];
  let complete = lexed.complete && segComplete;
  const segments: SimpleCommand[] = [];
  const substitutions = [...lexed.substitutions];

  if (depth > MAX_DEPTH) {
    return { segments: rawSegments, substitutions, complete: false, notes: [...notes, 'nesting too deep'] };
  }

  for (const seg of rawSegments) {
    const expanded = unwrap(seg, depth);
    complete = complete && expanded.complete;
    notes.push(...expanded.notes);
    segments.push(...expanded.segments);
  }

  for (const sub of lexed.substitutions) {
    const inner = parseCommand(sub, depth + 1);
    complete = complete && inner.complete;
    notes.push(...inner.notes);
    segments.push(...inner.segments);
    substitutions.push(...inner.substitutions);
  }

  return { segments, substitutions, complete, notes };
}

interface UnwrapResult {
  segments: SimpleCommand[];
  complete: boolean;
  notes: string[];
}

function takeOptionWithValue(argv: string[], idx: number, shortOpts: Set<string>): number {
  // Returns the number of tokens to skip starting at idx for an option that may take a value.
  const a = argv[idx];
  if (a.includes('=')) return 1;
  if (shortOpts.has(a)) return 2;
  return 1;
}

/** Strip wrapper commands that run another command, recursing into `sh -c` strings. */
export function unwrap(seg: SimpleCommand, depth = 0): UnwrapResult {
  const notes: string[] = [];
  let complete = true;
  let argv = [...seg.argv];
  const wrappers = [...seg.wrappers];
  let privileged = seg.privileged;
  let detached = seg.detached;

  for (let guard = 0; guard < 12 && argv.length; guard++) {
    const head = commandName(argv[0]);
    if (PRIVILEGE_WRAPPERS.has(head)) {
      privileged = true;
      wrappers.push(head);
      argv = stripWrapperOptions(argv.slice(1), new Set(['-u', '-g', '-h', '-p', '-r', '-t', '-U', '-C', '--user', '--group', '-c', '-l', '--login']));
      // `su -c "cmd"` → command string
      continue;
    }
    if (DETACH_WRAPPERS.has(head)) {
      detached = true;
      wrappers.push(head);
      argv = stripWrapperOptions(argv.slice(1), new Set());
      continue;
    }
    if (head === 'env') {
      wrappers.push('env');
      let rest = argv.slice(1);
      while (rest.length) {
        const a = rest[0];
        if (a === '-i' || a === '--ignore-environment' || a === '-0' || a === '--null') rest = rest.slice(1);
        else if (a === '-u' || a === '--unset' || a === '-C' || a === '--chdir' || a === '-S' || a === '--split-string') rest = rest.slice(2);
        else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) {
          seg.assignments.push(a);
          rest = rest.slice(1);
        } else break;
      }
      argv = rest;
      if (argv.length === 0) {
        argv = ['env']; // bare `env` dumps the environment
        wrappers.pop();
        break;
      }
      continue;
    }
    if (head === 'command' || head === 'exec' || head === 'builtin' || head === 'nice' || head === 'ionice' || head === 'stdbuf' || head === 'unbuffer' || head === 'chronic' || head === 'caffeinate') {
      wrappers.push(head);
      argv = stripWrapperOptions(argv.slice(1), new Set(['-n', '-c', '-i', '-o', '-e', '-p', '-a', '-t']));
      continue;
    }
    if (head === 'timeout' || head === 'gtimeout') {
      wrappers.push(head);
      let rest = stripWrapperOptions(argv.slice(1), new Set(['-s', '--signal', '-k', '--kill-after']));
      if (rest.length && /^\d+(\.\d+)?[smhd]?$/.test(rest[0])) rest = rest.slice(1);
      argv = rest;
      continue;
    }
    if (head === 'xargs') {
      wrappers.push('xargs');
      let rest = argv.slice(1);
      while (rest.length && rest[0].startsWith('-')) {
        const a = rest[0];
        if (['-I', '-n', '-P', '-L', '-s', '-d', '-E', '-a', '--max-args', '--max-procs', '--delimiter', '--replace', '--arg-file'].includes(a) && !a.includes('=')) rest = rest.slice(2);
        else rest = rest.slice(1);
      }
      argv = rest.length ? rest : ['echo'];
      continue;
    }
    if (head === 'busybox' || head === 'toybox') {
      wrappers.push(head);
      argv = argv.slice(1);
      continue;
    }
    if (head === 'eval') {
      wrappers.push('eval');
      const inner = parseCommand(argv.slice(1).join(' '), depth + 1);
      return finish(inner.segments, inner.complete && complete, [...notes, ...inner.notes]);
    }
    if (SHELLS.has(head) || head === 'pwsh' || head === 'powershell' || head === 'cmd') {
      const rest = argv.slice(1);
      // find -c / -Command / /c
      let cIdx = -1;
      for (let k = 0; k < rest.length; k++) {
        const a = rest[k];
        if (a === '-c' || a === '-lc' || a === '-ic' || a === '-ec' || a === '-xc' || a === '-cl' || /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a) || a.toLowerCase() === '-command' || a.toLowerCase() === '/c' || a.toLowerCase() === '/k' || a === '-e' && head === 'pwsh') {
          cIdx = k;
          break;
        }
        if (!a.startsWith('-') && !a.startsWith('/')) break; // script file
      }
      if (cIdx >= 0 && rest[cIdx + 1] !== undefined) {
        wrappers.push(`${head} -c`);
        const script = rest.slice(cIdx + 1).join(' ');
        if (head === 'pwsh' || head === 'powershell' || head === 'cmd') {
          // We do not parse PowerShell/cmd; keep it as an opaque command for pattern rules.
          const opaque: SimpleCommand = { ...seg, argv: [head, script], wrappers: [...wrappers], privileged, detached, raw: `${head} -c ${script}` };
          return finish([opaque], false, [...notes, `${head} script not parsed`]);
        }
        const inner = parseCommand(script, depth + 1);
        const mapped = inner.segments.map((s) => ({ ...s, wrappers: [...wrappers, ...s.wrappers], privileged: privileged || s.privileged, detached: detached || s.detached }));
        return finish(mapped, inner.complete && complete, [...notes, ...inner.notes]);
      }
      if (seg.pipedFrom && rest.every((a) => a.startsWith('-'))) {
        // `... | sh` executes piped input
        notes.push('shell reads program from pipe');
      }
      break;
    }
    if (head === 'watch' || head === 'entr') {
      wrappers.push(head);
      argv = stripWrapperOptions(argv.slice(1), new Set(['-n', '--interval']));
      continue;
    }
    break;
  }

  const out: SimpleCommand = { ...seg, argv, wrappers, privileged, detached };
  return finish([out], complete, notes);

  function finish(segments: SimpleCommand[], ok: boolean, n: string[]): UnwrapResult {
    for (const s of segments) {
      s.raw = s.raw || [...s.assignments, ...s.argv].join(' ');
      if (seg.background) s.background = true;
    }
    return { segments, complete: ok, notes: n };
  }
}

function stripWrapperOptions(argv: string[], withValue: Set<string>): string[] {
  let rest = argv;
  while (rest.length && rest[0].startsWith('-') && rest[0] !== '--' ) {
    rest = rest.slice(takeOptionWithValue(rest, 0, withValue));
  }
  if (rest[0] === '--') rest = rest.slice(1);
  return rest;
}

/** Split combined short flags: "-rf" → ["r","f"]; returns [] for long options and non-flags. */
export function shortFlags(arg: string): string[] {
  if (!/^-[A-Za-z]+$/.test(arg)) return [];
  return arg.slice(1).split('');
}

export function hasFlag(argv: string[], shorts: string[], longs: string[] = []): boolean {
  for (const a of argv.slice(1)) {
    if (a === '--') break;
    if (longs.some((l) => a === l || a.startsWith(`${l}=`))) return true;
    const f = shortFlags(a);
    if (f.some((x) => shorts.includes(x))) return true;
  }
  return false;
}

/** Non-option arguments (everything not starting with '-' unless after '--'). */
export function positionals(argv: string[]): string[] {
  const out: string[] = [];
  let after = false;
  for (const a of argv.slice(1)) {
    if (after) {
      out.push(a);
      continue;
    }
    if (a === '--') {
      after = true;
      continue;
    }
    if (a.startsWith('-') && a !== '-') continue;
    out.push(a);
  }
  return out;
}

export function segmentText(seg: SimpleCommand): string {
  return seg.argv.join(' ').replace(/\s+/g, ' ').trim();
}
