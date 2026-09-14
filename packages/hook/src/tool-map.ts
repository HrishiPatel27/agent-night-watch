type J = Record<string, unknown>;

const TOOL_ALIASES: Record<string, string> = {
  bash: 'Bash', shell: 'Bash', run_shell_command: 'Bash', run_terminal_command: 'Bash', run_terminal_cmd: 'Bash', execute_command: 'Bash', terminal: 'Bash', shell_command: 'Bash', execute: 'Bash', exec: 'Bash', run_command: 'Bash', command: 'Bash',
  powershell: 'PowerShell',
  read: 'Read', read_file: 'Read', view: 'Read', cat: 'Read', view_file: 'Read', read_many_files: 'Read', list_directory: 'Read', ls: 'Read', list_files: 'Read', list_dir: 'Read', list: 'Read', notebookread: 'NotebookRead', notebook_read: 'NotebookRead',
  write: 'Write', write_file: 'Write', create: 'Write', create_file: 'Write', save_file: 'Write', write_to_file: 'Write',
  edit: 'Edit', replace: 'Edit', edit_file: 'Edit', str_replace_editor: 'Edit', str_replace_based_edit_tool: 'Edit', apply_patch: 'Edit', multiedit: 'MultiEdit', multi_edit: 'MultiEdit', patch: 'Edit', notebookedit: 'NotebookEdit', notebook_edit: 'NotebookEdit', replace_in_file: 'Edit', insert_edit_into_file: 'Edit',
  glob: 'Glob', find_files: 'Glob', file_search: 'Glob', search_files: 'Glob', glob_search: 'Glob',
  grep: 'Grep', search: 'Grep', search_file_content: 'Grep', grep_search: 'Grep', codebase_search: 'Grep', ripgrep: 'Grep', search_code: 'Grep',
  webfetch: 'WebFetch', web_fetch: 'WebFetch', fetch: 'WebFetch', fetch_url: 'WebFetch', http_request: 'WebFetch', read_url: 'WebFetch', browse: 'WebFetch',
  websearch: 'WebSearch', web_search: 'WebSearch', google_web_search: 'WebSearch', search_web: 'WebSearch',
  task: 'Task', agent: 'Task', subagent: 'Task', spawn_agent: 'Task',
  todowrite: 'TodoWrite', todo_write: 'TodoWrite', todoread: 'TodoRead', todo_read: 'TodoRead', update_todos: 'TodoWrite',
  ask_user: 'AskUserQuestion', askuserquestion: 'AskUserQuestion', ask_user_question: 'AskUserQuestion',
  skill: 'Skill', lsp: 'LSP', monitor: 'Monitor',
};

const COMMAND_KEYS = ['command', 'cmd', 'commandLine', 'command_line', 'script', 'shell_command'];
const PATH_KEYS = ['file_path', 'path', 'filePath', 'filename', 'file', 'target_file', 'absolute_path', 'notebook_path', 'relative_path', 'target', 'uri'];
const CONTENT_KEYS = ['content', 'file_text', 'text', 'contents', 'new_content', 'code'];
const URL_KEYS = ['url', 'uri', 'href', 'link'];
const PATTERN_KEYS = ['pattern', 'query', 'glob', 'regex', 'search'];

function first(input: J, keys: string[]): unknown {
  for (const k of keys) if (input[k] != null && input[k] !== '') return input[k];
  return undefined;
}

/** Map any agent's tool name and argument shape onto the canonical Nightwatch tools. */
export function canonicalTool(rawName: string, rawInput: unknown): { tool: string; input: J } {
  const input: J = rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput) ? { ...(rawInput as J) } : {};
  let name = rawName ?? '';
  // MCP naming variants: mcp__server__tool (Claude/Codex/Copilot), mcp_server_tool (Gemini), MCP:tool (Cursor), server_tool (OpenCode)
  if (/^mcp__/i.test(name)) return { tool: name, input };
  if (/^mcp_[^_]/i.test(name)) {
    const parts = name.slice(4).split('_');
    return { tool: `mcp__${parts[0]}__${parts.slice(1).join('_')}`, input };
  }
  if (/^mcp:/i.test(name)) return { tool: `mcp__cursor__${name.slice(4)}`, input };
  const key = name.replace(/[-\s]/g, '_').toLowerCase();
  const canonical = TOOL_ALIASES[key] ?? (TOOL_ALIASES[name.toLowerCase()] ?? name);
  if (canonical === 'Bash' || canonical === 'PowerShell') {
    const cmd = first(input, COMMAND_KEYS);
    if (typeof cmd === 'string') input.command = cmd;
    else if (Array.isArray(cmd)) input.command = cmd.map((c) => shellQuote(String(c))).join(' ');
    if (input.background === true || input.run_in_background === true || input.is_background === true) input.run_in_background = true;
  } else if (canonical === 'Read' || canonical === 'Write' || canonical === 'Edit' || canonical === 'MultiEdit' || canonical === 'NotebookEdit' || canonical === 'NotebookRead') {
    let p = first(input, PATH_KEYS);
    if (p == null && Array.isArray(input.paths) && input.paths.length) p = input.paths[0];
    if (p == null && Array.isArray(input.edits) && input.edits.length) p = first(input.edits[0] as J, PATH_KEYS);
    if (p == null && typeof input.patch === 'string') {
      const m = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/m.exec(input.patch);
      if (m) p = m[1].trim();
    }
    if (typeof p === 'string') input.file_path = p;
    const content = first(input, CONTENT_KEYS);
    if (typeof content === 'string') input.content = content;
  } else if (canonical === 'Glob' || canonical === 'Grep') {
    const pat = first(input, PATTERN_KEYS);
    if (typeof pat === 'string') input.pattern = pat;
    const p = first(input, ['path', 'dir', 'directory', 'cwd', 'target_directory']);
    if (typeof p === 'string') input.path = p;
  } else if (canonical === 'WebFetch') {
    const u = first(input, URL_KEYS);
    if (typeof u === 'string') input.url = u;
    else if (typeof input.prompt === 'string') {
      const m = /https?:\/\/[^\s'"<>]+/.exec(input.prompt);
      if (m) input.url = m[0];
    }
  }
  return { tool: canonical, input };
}

export function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
