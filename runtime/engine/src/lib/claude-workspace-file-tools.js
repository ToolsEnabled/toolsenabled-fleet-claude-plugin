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

const { PROTECTED_EDIT_PATTERNS, PROTECTED_READ_PATTERNS } = require('./protected-names');
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
  ...PROTECTED_READ_PATTERNS.map(pattern => `Edit(**/${pattern})`),
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
