'use strict';

// Claude workers run headless. Keep their native file surface small, with
// permission rules anchored at the CLI's cwd (the sealed workspace). Claude
// Code 2.1.287 evaluates Edit(path) for both Edit and Write and checks the
// resolved target as well as the requested path (Claude permissions reference:
// https://code.claude.com/docs/en/permissions). dontAsk denies everything
// that is not explicitly allowed; --tools removes Bash and other native tools.
const NATIVE_TOOLS = 'Read,Edit,Write';
const path = require('node:path');
// Fleet's host file and search tools reach project files through a second
// channel with its own refusals. A Claude worker uses its native Read, Edit
// and Write under Claude Code's rules instead, so its server offers none of
// these (src/lib/host-worker-session.js hostWorkerEntry).
const MCP_FILE_BYPASSES = Object.freeze(new Set([
  'host.read_file', 'host.write_file', 'host.patch_file', 'host.list_dir',
  'search.index', 'search.query',
]));
function confinedMcpNames(names) { return names.filter(name => !MCP_FILE_BYPASSES.has(name)); }
function outsideWriteDenial(files, workspaceRoot, label = 'Fleet') {
  if (!Array.isArray(files) || typeof workspaceRoot !== 'string' || !path.isAbsolute(workspaceRoot)) return null;
  const root = path.resolve(workspaceRoot);
  for (const row of files.slice(0, 4)) {
    if (!row || !['Edit', 'Write'].includes(row.tool) || typeof row.path !== 'string'
        || row.path.length === 0 || row.path.length > 240 || !path.isAbsolute(row.path)
        || /[\x00-\x1f\x7f]/.test(row.path)) continue;
    const relative = path.relative(root, row.path);
    if (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) continue;
    return `${row.tool} to ${JSON.stringify(row.path)} was denied: ${label} confines writes to the sealed workspace ${JSON.stringify(root)}.`;
  }
  return null;
}
const FILE_ALLOW = Object.freeze(['Read(./**)', 'Edit(./**)']);

// Paths no Claude worker may change, at any depth below the workspace. This
// list is a superset of the write anchors Fleet's own host file tools refuse
// (src/lib/providers/host-control.js WRITE_EXCLUDED_PATH_PATTERNS and the
// shell and login files in EXCLUDED_PATH_PATTERNS) and of Claude Code's own
// protected paths (https://code.claude.com/docs/en/permission-modes, "Protected
// paths"). Every pattern starts with **/ so a nested copy (a vendored repo's
// sub/.github/workflows, sub/package.json) matches as well as the top-level one.
const PROTECTED_EDIT_PATTERNS = Object.freeze([
  // Version control, including a .git file that points at another git folder.
  '.git', '.git/**', '.hg/**', '.svn/**', '.bzr/**', '.pijul/**', '.fossil-settings/**',
  '*.git/hooks/**', '*.git/config', '.gitconfig', '.gitmodules', '.config/git/**',
  // Editors, dev containers and CI.
  '.vscode/**', '.idea/**', '.zed/**', '.cursor/**', '.windsurf/**', '.devcontainer/**', '.devcontainer.json',
  '.github/workflows/**', '.github/actions/**', '.circleci/**', '.gitlab-ci.yml', '.gitlab-ci.yaml',
  // Hooks and task runners.
  '.husky/**', '.githooks/**', 'lefthook*.yml', 'lefthook*.yaml', '.lefthook.yml', '.lefthook.yaml',
  '.pre-commit-config.yml', '.pre-commit-config.yaml',
  'package.json', 'GNUmakefile', 'Makefile', 'makefile', 'Justfile', 'justfile', 'Taskfile', 'Taskfile.yml', 'Taskfile.yaml',
  'Gruntfile.js', 'Gruntfile.cjs', 'Gruntfile.mjs', 'gulpfile.js', 'gulpfile.cjs', 'gulpfile.mjs',
  'tox.ini', 'noxfile.py', 'pyproject.toml', 'Procfile', 'Dockerfile', 'compose.yml', 'compose.yaml',
  // Package managers and toolchains that load project files as code or config.
  '.npmrc', '.yarnrc*', '.yarn/**', '.pnp.cjs', '.pnp.loader.mjs', '.pnpmfile.cjs', 'bunfig.toml', '.bunfig.toml',
  '.cargo/**', '.mvn/**', 'maven-wrapper.properties', 'gradle-wrapper.properties',
  '.bazelrc', '.bazelversion', '.bazeliskrc', 'mise.toml', '.mise.toml', '.ripgreprc', 'pyrightconfig.json',
  // Programs on PATH or loaded at interpreter start.
  'node_modules/.bin/**', '.venv/bin/**', 'venv/bin/**', 'env/bin/**', '.local/bin/**',
  'site-packages/*.pth', 'sitecustomize.py', 'conftest.py',
  // Shell and login files.
  '.envrc', '.bashrc', '.bash_profile', '.bash_login', '.bash_aliases', '.bash_logout', '.profile',
  '.zshrc', '.zshenv', '.zprofile', '.zlogin', '.zlogout', '.kshrc', '.cshrc', '.tcshrc', '.inputrc',
  '.xprofile', '.xinitrc', '.pam_environment',
  // Agent configuration and the instruction files the next agent session reads.
  '.claude/**', '.claude.json', '.codex/**', '.gemini/**', '.mcp.json',
  'CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'AGENTS.override.md', 'GEMINI.md',
  '.cursorrules', '.cursorrules/**', '.windsurfrules', '.windsurfrules/**', '.clinerules', '.clinerules/**',
  '.agents/**', '.github/copilot-instructions.md', '.github/instructions/**',
  // Build and environment files that run code on the next build, install,
  // `cd` (direnv, Nix) or editor start.
  'setup.py', 'usercustomize.py', 'build.rs', 'Cargo.toml', 'build.gradle', 'build.gradle.kts',
  'settings.gradle', 'settings.gradle.kts', 'gradle.properties', 'gradlew', 'gradlew.bat', 'buildSrc/**',
  'mvnw', 'mvnw.cmd', 'pom.xml', 'Pipfile', 'Gemfile', '*.gemspec', 'Rakefile', 'CMakeLists.txt', 'meson.build',
  'composer.json', 'deno.json', 'deno.jsonc', 'Vagrantfile', 'Earthfile', 'flake.nix', 'shell.nix', 'default.nix',
  '.direnv/**', '.vimrc', '.exrc', '.nvimrc', '.nvim.lua', '.lazy.lua',
  // Credential and tool configuration stores, several of which name programs
  // to run (Docker credential helpers, kubeconfig exec plugins).
  '.config/**', '.ssh/**', '.aws/**', '.gnupg/**', '.docker/**', '.kube/**', '.netrc', '.git-credentials',
  '.pgpass', '.my.cnf', '.vault-token', '.pypirc', '.m2/settings.xml',
]);
// Files no Claude worker may read, at any depth below the workspace. This
// list is a superset of what Fleet's own host file tools refuse to read
// (src/lib/providers/host-control.js EXCLUDED_PATH_PATTERNS, the credential
// store and credential-shaped names, and .env files), written as Claude Code
// permission globs. Claude Code matches them case-sensitively, so they name
// the usual spellings.
const CREDENTIAL_DATA_EXTENSIONS = Object.freeze(['json*', 'y*ml', 'toml', 'ini', 'cfg', 'conf', 'db', 'sqlite*',
  'env', 'pem', 'key', 'p12', 'pfx']);
// Stems refused only as the whole name or before a separator, so an ordinary
// tokenizer.json or authors.yml stays readable.
const CREDENTIAL_EXACT_STEMS = Object.freeze(['auth', 'token', 'tokens']);
// Stems refused anywhere in a name with a data or key extension.
const CREDENTIAL_STEMS = Object.freeze(['cookie', 'credential', 'session', 'passw', 'passphrase', 'keystore', 'kdbx', 'wallet',
  ...['access', 'refresh', 'bearer'].flatMap(kind => ['key', 'token'].flatMap(item => [`${kind}[._-]${item}`, `${kind}${item}`])),
  'private[._-]key', 'privatekey', 'service[._-]account', 'serviceaccount']);
const PROTECTED_READ_PATTERNS = Object.freeze([
  // Version control internals, a vendored repository's included.
  '.git/**',
  // Environment files.
  '.env', '.env.*',
  // Credential, key and tool configuration stores.
  'vault/**', '.ssh/**', '.aws/**', '.gnupg/**', '.docker/**', '.kube/**', '.azure/**', '.config/**', '.terraform.d/**',
  '.claude/**', '.claude.json', '.codex/**', '.gemini/**', '.netrc', '.git-credentials', '.pgpass', '.my.cnf',
  '.vault-token', '.Xauthority', 'key4.db', 'Login Data', 'login.keyring', 'kaggle.json', '.m2/settings.xml',
  '.cargo/credentials', '.cargo/credentials.toml', '.gem/credentials', '.npmrc', '.pypirc', 'NuGet.Config',
  'ConsoleHost_history.txt', '*_history', 'profiles/chrome/**',
  // Private SSH keys by their usual names.
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'id_ecdsa_sk', 'id_ed25519_sk',
  // Shell and login files, which commonly export keys.
  '.bashrc', '.bash_profile', '.bash_login', '.profile', '.zshrc', '.zshenv', '.zprofile', '.zlogin', '.kshrc', '.cshrc',
  '.tcshrc', '.inputrc', '.xprofile', '.xinitrc', '.pam_environment', '.envrc',
  // Credential-shaped names.
  '*credential*', '*private[._-]key*', '*privatekey*',
  ...CREDENTIAL_EXACT_STEMS.flatMap(stem => CREDENTIAL_DATA_EXTENSIONS.flatMap(extension =>
    [`${stem}.${extension}`, `.${stem}.${extension}`, `${stem}[._-]*.${extension}`, `.${stem}[._-]*.${extension}`])),
  ...CREDENTIAL_STEMS.flatMap(stem => CREDENTIAL_DATA_EXTENSIONS.map(extension => `*${stem}*.${extension}`)),
]);
const FILE_DENY = Object.freeze([
  'Read(.env)', 'Read(.env.*)', 'Read(.git/**)', 'Read(.claude/**)',
  'Read(.codex/**)', 'Read(.ssh/**)', 'Read(.aws/**)',
  'Read(.pgpass)', 'Read(.my.cnf)', 'Read(.claude.json)',
  'Read(*_history)', 'Read(*credentials*)', 'Read(*private_key*)',
  'Edit(.git/**)', 'Edit(.hg/**)', 'Edit(.svn/**)', 'Edit(.claude/**)',
  'Edit(.codex/**)', 'Edit(.envrc)', 'Edit(.bashrc)', 'Edit(.profile)',
  'Edit(.zshrc)', 'Edit(.vscode/**)', 'Edit(.idea/**)',
  'Edit(.husky/**)', 'Edit(.githooks/**)', 'Edit(.github/workflows/**)',
  'Edit(.github/actions/**)', 'Edit(.circleci/**)',
  'Edit(.mcp.json)', 'Edit(.mise.toml)', 'Edit(.npmrc)',
  'Edit(.gitconfig)', 'Edit(.pre-commit-config.yaml)',
  ...PROTECTED_EDIT_PATTERNS.map(pattern => `Edit(**/${pattern})`),
  ...PROTECTED_READ_PATTERNS.map(pattern => `Read(**/${pattern})`),
]);

// A gitignore pattern that names exactly this absolute path. Claude Code reads
// `//path` as absolute; gitignore's special characters are escaped.
function absolutePattern(folder) {
  return `//${folder.replace(/^\/+/, '').replace(/[\\*?[\]!#\s]/g, character => `\\${character}`)}`;
}

// Project folders that are on PATH. A program there runs by name, and an
// existing executable keeps its mode when its content is replaced, so Claude
// workers may not edit inside them (host-control refuses the same folders).
// The project root itself on PATH is not listed: that rule would forbid every
// edit; host-control alone refuses it.
function pathDirectoryRules(workspaceRoot, pathDirectories) {
  if (typeof workspaceRoot !== 'string' || !path.isAbsolute(workspaceRoot) || !Array.isArray(pathDirectories)) return [];
  const root = path.resolve(workspaceRoot);
  const rules = new Set();
  const inside = folder => {
    const relative = path.relative(root, folder);
    return Boolean(relative) && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  };
  for (const entry of pathDirectories) {
    if (typeof entry !== 'string' || !entry || entry.includes('\0')) continue;
    const lexical = path.resolve(root, entry);
    let real = lexical;
    try { real = require('node:fs').realpathSync(lexical); } catch { /* a folder that does not exist yet */ }
    for (const folder of [lexical, real]) if (inside(folder)) rules.add(`Edit(${absolutePattern(folder)}/**)`);
  }
  return [...rules];
}

function settings(serverName, { serverEnabled = true, workspaceRoot = null, pathDirectories = [] } = {}) {
  const allow = [...(serverEnabled ? [require('./agent-engine/claude-cli-adapter').claudeServerPermissionRule(serverName)] : []), ...FILE_ALLOW];
  return Object.freeze({ permissions: Object.freeze({ allow,
    deny: [...FILE_DENY, ...pathDirectoryRules(workspaceRoot, pathDirectories)] }) });
}

module.exports = Object.freeze({ NATIVE_TOOLS, FILE_ALLOW, FILE_DENY, PROTECTED_EDIT_PATTERNS, PROTECTED_READ_PATTERNS, MCP_FILE_BYPASSES,
  confinedMcpNames, outsideWriteDenial, pathDirectoryRules, settings });
