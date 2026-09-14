/**
 * Word lists used by the rules. Keeping them in one place makes the policy
 * auditable in a single screen and easy to extend from pull requests.
 */

export const PRIVILEGE_HEADS = new Set(['sudo', 'doas', 'su', 'pkexec', 'runas', 'gsudo']);

export const SHELL_HEADS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'pwsh', 'powershell', 'cmd']);

/** Commands that damage disks, the OS, or terminate processes. Always denied. */
export const DESTRUCTIVE_HEADS = new Set([
  'dd', 'mkfs', 'mkfs.ext4', 'mkfs.ext3', 'mkfs.xfs', 'mkfs.btrfs', 'mkfs.vfat', 'mkfs.ntfs', 'mke2fs', 'fdisk', 'sfdisk', 'cfdisk', 'gdisk', 'parted',
  'gparted', 'wipefs', 'shred', 'mkswap', 'swapoff', 'format', 'diskpart', 'fsutil', 'bcdedit', 'bootrec', 'reg', 'regedit', 'sdelete', 'cipher',
  'shutdown', 'reboot', 'halt', 'poweroff', 'init', 'telinit', 'kill', 'killall', 'killall5', 'pkill', 'taskkill', 'skill',
  'chroot', 'mount', 'umount', 'losetup', 'cryptsetup', 'lvremove', 'vgremove', 'pvremove', 'zpool', 'zfs', 'diskutil', 'nvram', 'csrutil',
  'iptables', 'ip6tables', 'nft', 'ufw', 'firewall-cmd', 'netsh', 'route', 'sysctl', 'modprobe', 'insmod', 'rmmod', 'useradd', 'userdel', 'usermod',
  'passwd', 'chpasswd', 'visudo', 'dscl', 'net',
]);

/** cmd.exe / PowerShell raw patterns (we do not tokenise those shells). */
export const WINDOWS_DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\b(del|erase)\b[^|;&]*\/[sq]/i,
  /\b(rd|rmdir)\b[^|;&]*\/s/i,
  /\bremove-item\b[^|;&]*-(recurse|force)/i,
  /\b(ri|rm|del|erase|rd|rmdir)\s+-r(ecurse)?\b/i,
  /\bformat(-volume)?\b/i,
  /\bclear-disk\b/i,
  /\b(stop|restart)-computer\b/i,
  /\bstop-process\b/i,
  /\bremove-(itemproperty|partition|psdrive)\b/i,
  /\bset-executionpolicy\b/i,
  /\bset-mppreference\b/i,
  /\binvoke-expression\b|\biex\b/i,
  /\bnew-service\b|\bstart-service\b|\bregister-scheduledtask\b/i,
];

/** Publishing, deploying, releasing, cloud and infrastructure CLIs. Always denied. */
export const PROD_HEADS = new Set([
  'vercel', 'now', 'netlify', 'fly', 'flyctl', 'heroku', 'railway', 'render', 'wrangler', 'firebase', 'gcloud', 'gsutil', 'aws', 'az', 'doctl', 'linode-cli',
  'eb', 'sam', 'cdk', 'serverless', 'sls', 'pulumi', 'ansible', 'ansible-playbook', 'salt', 'salt-call', 'chef', 'knife', 'cap', 'fab', 'goreleaser',
  'twine', 'oc', 'helm', 'argocd', 'flux', 'kustomize', 'copilot-cli', 'amplify', 'supabase', 'planetscale', 'pscale', 'neonctl', 'stripe', 'twilio',
  'sentry-cli', 'datadog-ci', 'newrelic', 'launchdarkly', 'nomad', 'consul', 'vault', 'op', 'bw', 'lpass', 'gopass', 'pass',
]);

/** Database clients. Denied unless every referenced host is loopback. */
export const DB_CLIENT_HEADS = new Set([
  'psql', 'pg_dump', 'pg_dumpall', 'pg_restore', 'pgcli', 'mysql', 'mysqldump', 'mysqladmin', 'mycli', 'mariadb', 'mongo', 'mongosh', 'mongodump',
  'mongorestore', 'redis-cli', 'sqlcmd', 'sqlplus', 'cqlsh', 'clickhouse-client', 'cockroach', 'usql', 'influx', 'snowsql', 'bq', 'duckdb', 'sqlite3',
  'litecli', 'pgbench', 'sysbench',
]);

export const CONNECTION_STRING_RE = /\b(postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?|mssql|sqlserver|oracle|jdbc:[a-z]+|snowflake|clickhouse|cassandra|neo4j|bolt|dynamodb):\/\/[^\s'"]+/gi;

/** Multiplexers, daemon managers and schedulers. Denied when detached processes are denied. */
export const DETACH_HEADS = new Set([
  'screen', 'tmux', 'byobu', 'zellij', 'dtach', 'abduco', 'pm2', 'forever', 'supervisord', 'supervisorctl', 'launchctl', 'at', 'batch', 'crontab', 'schtasks',
  'sc', 'daemon', 'daemonize', 'start-stop-daemon', 'disown', 'bg', 'coproc', 'open', 'xdg-open', 'start', 'explorer', 'code', 'cursor', 'subl', 'idea',
  'caffeinate', 'systemd-run',
]);

/** Tools whose purpose is talking to the network. Hosts are checked against the allow list. */
export const NETWORK_HEADS = new Set([
  'curl', 'wget', 'http', 'https', 'httpie', 'xh', 'aria2c', 'nc', 'ncat', 'netcat', 'socat', 'telnet', 'ssh', 'scp', 'sftp', 'rsync', 'ftp', 'lftp', 'tftp',
  'openssl', 'ping', 'ping6', 'traceroute', 'tracert', 'mtr', 'nmap', 'masscan', 'iwr', 'invoke-webrequest', 'irm', 'invoke-restmethod', 'websocat', 'grpcurl',
]);

/** System package managers modify the machine, not the project. */
export const SYSTEM_PACKAGE_HEADS = new Set([
  'apt', 'apt-get', 'aptitude', 'dpkg', 'yum', 'dnf', 'rpm', 'zypper', 'pacman', 'yay', 'paru', 'apk', 'emerge', 'brew', 'port', 'choco', 'winget', 'scoop',
  'snap', 'flatpak', 'nix', 'nix-env', 'mas', 'softwareupdate',
]);

/** Coding agents. Launching one from inside a guarded run creates an unguarded process. */
export const AGENT_HEADS = new Set(['claude', 'codex', 'cursor-agent', 'agent', 'gemini', 'copilot', 'aider', 'amp', 'opencode', 'grok', 'goose', 'cline', 'devin', 'nightwatch']);

/** Credential managers and commands whose output is a secret. */
export const SECRET_DUMP_HEADS = new Set([
  'printenv', 'security', 'cmdkey', 'vaultcmd', 'secret-tool', 'keyctl', 'gnome-keyring', 'kwallet-query', 'op', 'vault', 'bw', 'lpass', 'gopass', 'pass', 'doppler', 'sops', 'age', 'gpg',
]);

export const SECRET_ENV_RE = /\$\{?([A-Za-z0-9_]*(SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIAL|AUTH)[A-Za-z0-9_]*)\}?/i;

/** Built-in read-only commands (path arguments still have to be inside readable roots). */
export const READ_HEADS = new Set([
  'ls', 'dir', 'vdir', 'cat', 'head', 'tail', 'less', 'more', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'find', 'fd', 'fdfind', 'tree', 'stat', 'file',
  'du', 'df', 'sort', 'uniq', 'cut', 'tr', 'awk', 'gawk', 'mawk', 'nawk', 'sed', 'diff', 'cmp', 'comm', 'paste', 'join', 'jq', 'yq', 'xxd', 'od', 'hexdump', 'strings',
  'md5sum', 'md5', 'sha1sum', 'sha256sum', 'sha512sum', 'shasum', 'cksum', 'b2sum', 'base64', 'basename', 'dirname', 'realpath', 'readlink', 'nl', 'tac', 'rev',
  'fold', 'fmt', 'expand', 'unexpand', 'column', 'expr', 'bc', 'factor', 'numfmt', 'seq', 'yes', 'tput', 'clear', 'date', 'cal', 'uname', 'hostname', 'whoami', 'id',
  'groups', 'uptime', 'nproc', 'arch', 'sw_vers', 'lsb_release', 'which', 'whereis', 'where', 'type', 'pwd', 'echo', 'printf', 'true', 'false', 'test', '[', '[[',
  'sleep', 'ps', 'pgrep', 'lsof', 'netstat', 'ss', 'ifconfig', 'ip', 'dig', 'nslookup', 'host', 'getent', 'locale', 'env', 'ulimit', 'umask', 'times', 'history',
  'wait', 'jobs', 'read', 'shift', 'exit', 'return', 'break', 'continue', ':', 'let', 'local', 'shopt', 'alias', 'unalias', 'hash', 'export', 'unset', 'declare',
  'typeset', 'set', 'tty', 'stty', 'iconv', 'dos2unix', 'unix2dos', 'tail', 'look', 'bat', 'exa', 'eza', 'lsd', 'tokei', 'cloc', 'scc', 'loc', 'wc', 'ldd', 'otool', 'nm',
  'objdump', 'readelf', 'size', 'ar', 'lscpu', 'lsblk', 'free', 'vmstat', 'iostat', 'top', 'htop', 'sysctl', 'defaults', 'getconf', 'printenv', 'pbpaste', 'sw_vers',
]);

/** Built-in commands that write, allowed when every path argument is inside a writable root. */
export const WRITE_HEADS = new Set([
  'touch', 'mkdir', 'rmdir', 'rm', 'unlink', 'mv', 'cp', 'ln', 'install', 'truncate', 'tee', 'chmod', 'chown', 'chgrp', 'chattr', 'setfacl', 'xattr', 'patch',
  'tar', 'unzip', 'zip', 'gzip', 'gunzip', 'bzip2', 'bunzip2', 'xz', 'unxz', 'zstd', 'unzstd', '7z', '7za', 'split', 'csplit', 'mkfifo', 'rename', 'mmv', 'ditto',
  'rsync', 'dd', 'pbcopy',
]);

/** Introspection commands from language toolchains that never execute project code. */
export const TOOLCHAIN_SAFE_PATTERNS: string[] = [
  'node --version', 'node -v', 'npm --version', 'npm -v', 'npm ls*', 'npm list*', 'npm explain *', 'npm why *', 'npm pkg get*', 'npm root*', 'npm prefix*', 'npm bin*',
  'npm config get *', 'npm config list*', 'npm outdated*', 'npm doctor', 'npx --version', 'yarn --version', 'yarn -v', 'yarn list*', 'yarn why *', 'pnpm --version', 'pnpm -v',
  'pnpm ls*', 'pnpm list*', 'pnpm why *', 'bun --version', 'deno --version', 'tsc --version', 'tsc -v',
  'python --version', 'python3 --version', 'python -V', 'python3 -V', 'pip --version', 'pip3 --version', 'pip list*', 'pip3 list*', 'pip show *', 'pip3 show *',
  'pip freeze*', 'pip3 freeze*', 'pip check', 'pip3 check', 'uv --version', 'uv pip list*', 'uv pip freeze*', 'poetry --version', 'poetry show*', 'poetry env info*',
  'pytest --version', 'pytest --collect-only*', 'ruff --version', 'black --version', 'mypy --version',
  'go version', 'go env*', 'go list*', 'go mod graph', 'go mod why *', 'go mod verify', 'gofmt -l *', 'gofmt -d *',
  'cargo --version', 'cargo -V', 'cargo metadata*', 'cargo tree*', 'cargo --list', 'rustc --version', 'rustc -V', 'rustup show*',
  'java -version', 'java --version', 'javac -version', 'mvn -v', 'mvn --version', 'mvn dependency:tree*', 'gradle --version', './gradlew --version',
  'dotnet --version', 'dotnet --info', 'dotnet --list-sdks', 'dotnet --list-runtimes',
  'ruby -v', 'ruby --version', 'gem list*', 'gem --version', 'bundle --version', 'bundle list*', 'bundle show*',
  'php -v', 'php --version', 'composer --version', 'composer show*', 'composer validate*',
  'make -n*', 'make --dry-run*', 'make -q*', 'cmake --version', 'ninja --version', 'bazel version',
  'docker --version', 'docker version', 'docker ps*', 'docker images*', 'docker image ls*', 'docker container ls*', 'docker logs *', 'docker inspect *', 'docker compose ps*',
  'docker compose config*', 'docker compose logs*', 'docker-compose ps*', 'docker-compose config*', 'docker-compose logs*', 'docker network ls*', 'docker volume ls*',
  'kubectl get *', 'kubectl describe *', 'kubectl logs *', 'kubectl explain *', 'kubectl version*', 'kubectl api-resources*', 'kubectl config view*', 'kubectl config current-context',
  'kubectl top *', 'terraform version', 'terraform validate*', 'terraform fmt -check*', 'terraform fmt -diff*', 'terraform show*', 'terraform output*', 'terraform providers*',
  'tofu validate*', 'tofu fmt -check*', 'gh --version', 'gh auth status', 'gh pr view*', 'gh pr list*', 'gh pr status*', 'gh pr diff*', 'gh pr checks*', 'gh issue view*',
  'gh issue list*', 'gh repo view*', 'gh run view*', 'gh run list*', 'gh release list*', 'gh release view*',
  'git --version', 'make --version', 'clang --version', 'gcc --version', 'g++ --version', 'swift --version', 'xcodebuild -version', 'xcrun --version',
];

/** Git subcommands that only read repository state. */
export const GIT_READ_SUBCOMMANDS = new Set([
  'status', 'diff', 'log', 'show', 'blame', 'rev-parse', 'ls-files', 'ls-tree', 'cat-file', 'grep', 'describe', 'shortlog', 'diff-tree', 'diff-index', 'rev-list',
  'name-rev', 'count-objects', 'fsck', 'hash-object', 'range-diff', 'merge-base', 'symbolic-ref', 'for-each-ref', 'check-ignore', 'check-attr', 'whatchanged',
  'var', 'version', 'help', 'show-ref', 'show-branch', 'cherry', 'verify-pack', 'verify-commit', 'verify-tag', 'ls-remote', 'annotate', 'bisect', 'difftool', 'mailinfo',
  'stripspace', 'check-ref-format', 'rerere', 'notes', 'instaweb', 'archive', 'bundle', 'format-patch', 'request-pull', 'mergetool', 'column', 'interpret-trailers',
]);

/** Git subcommands that modify the worktree/branch but stay inside the run. */
export const GIT_WRITE_SUBCOMMANDS = new Set([
  'add', 'commit', 'restore', 'checkout', 'mv', 'rm', 'apply', 'am', 'merge', 'rebase', 'cherry-pick', 'revert', 'tag', 'stash', 'init', 'mktree', 'read-tree',
  'write-tree', 'update-index', 'commit-tree', 'reset', 'switch', 'branch', 'clean', 'gc', 'prune', 'reflog', 'remote', 'config', 'worktree', 'submodule', 'update-ref',
  'filter-branch', 'filter-repo', 'replace', 'sparse-checkout', 'maintenance', 'repack', 'pack-refs', 'symbolic-ref', 'fetch', 'pull', 'clone', 'push', 'send-email', 'svn',
]);

export const GIT_NETWORK_SUBCOMMANDS = new Set(['fetch', 'pull', 'clone', 'ls-remote', 'send-email', 'svn', 'request-pull', 'instaweb']);

/** Paths whose modification would disable or blind the supervisor. Checked on canonical paths. */
export const PROTECTED_PATH_GLOBS: string[] = [
  '**/.claude/settings.json',
  '**/.claude/settings.local.json',
  '**/.claude/hooks/**',
  '**/.claude/**/hooks.json',
  '**/.cursor/hooks.json',
  '**/.cursor/hooks/**',
  '**/.gemini/settings.json',
  '**/.gemini/hooks/**',
  '**/.github/hooks/**',
  '**/.codex/config.toml',
  '**/.codex/hooks/**',
  '**/.opencode/**',
  '**/.copilot/**',
  '**/.aider.conf.yml',
  '~/.claude/settings.json',
  '~/.cursor/hooks.json',
  '~/.gemini/settings.json',
  '~/.codex/config.toml',
  '**/.git/hooks/**',
  '**/.git/config',
];

/** Default secret paths. Users extend via deny.paths. */
export const DEFAULT_SECRET_PATH_GLOBS: string[] = [
  '**/.env',
  '**/.env.*',
  '**/*.env',
  '**/*secret*',
  '**/*secrets*',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/*.jks',
  '**/*.keystore',
  '**/id_rsa*',
  '**/id_ed25519*',
  '**/id_ecdsa*',
  '**/id_dsa*',
  '**/*credentials*',
  '**/.netrc',
  '**/_netrc',
  '**/.npmrc',
  '**/.pypirc',
  '**/.git-credentials',
  '**/.docker/config.json',
  '**/.kube/config',
  '**/.aws/**',
  '**/.ssh/**',
  '**/.gnupg/**',
  '**/.config/gcloud/**',
  '**/.azure/**',
  '**/.terraform.d/credentials*',
  '**/.vault-token',
  '**/.password-store/**',
  '**/Library/Keychains/**',
  '**/keychain*',
  '**/AppData/Local/Microsoft/Credentials/**',
  '**/AppData/Roaming/Microsoft/Credentials/**',
  '**/AppData/Roaming/Microsoft/Protect/**',
  '/etc/shadow',
  '/etc/gshadow',
  '/etc/sudoers*',
  '/proc/**/environ',
  '**/*.tfstate',
  '**/*.tfstate.backup',
  '**/service-account*.json',
  '**/serviceAccountKey*.json',
];

/** Basenames that look like secrets but are safe templates. */
export const SECRET_EXCEPTION_RE = /\.(example|sample|template|dist|schema|d\.ts)$|^\.env\.d\.ts$|\.example\.|\.sample\.|\.template\./i;

/** Non-MCP tools that carry no side effects and need no policy. */
export const HARMLESS_TOOLS = new Set([
  'Task', 'Agent', 'TodoWrite', 'TodoRead', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskOutput', 'TaskStop', 'Skill', 'AskUserQuestion',
  'ExitPlanMode', 'EnterPlanMode', 'LSP', 'BashOutput', 'KillShell', 'KillBash', 'NotebookRead', 'ListMcpResourcesTool', 'ToolSearch', 'SlashCommand',
  'ListAgents', 'Glob', 'Grep', 'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell', 'WebFetch', 'WebSearch', 'SendUserFile', 'ReadNotifications',
  'ExitWorktree', 'EnterWorktree', 'Monitor',
]);

/** Tools that publish, schedule or message outside the run. */
export const EXTERNAL_TOOLS = new Set(['Artifact', 'PushNotification', 'CronCreate', 'CronDelete', 'ScheduleWakeup', 'SendMessage', 'Workflow', 'DesignSync']);

export const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'NotebookRead', 'LSP']);
export const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
