'use strict';

// One saved mode governs new agent sessions. Only restricts native actions,
// Enabled offers both tool sets, and Disabled withholds the ToolsEnabled API.

const { AGENT_API_SETTING_ID, AGENT_API_MODES, normalizeAgentApiMode } = require('./agent-api-mode');

// Required lazily, for the reason src/lib/agent-tool-summary.js gives: a caller
// asking only whether a switch is on has no business loading the settings graph
// at module load time.
function settingsModule() { return require('./settings'); }
function settingsRegistryModule() { return require('./settings-registry'); }

// Optimized is a separate, deliberate selection, not Enabled-all. MCP
// configuration and provider permissions remain independent: --tools controls
// native availability, not permission grants.
//
// Optimized is Claude-only. Claude
// takes an exact native allowlist (--tools). The installed Codex 0.155.1 has no
// native allowlist: its enabled_tools/disabled_tools filter MCP servers, and its
// feature switches cannot keep a small read-only set without also dropping or
// admitting the shell and apply_patch. Every non-Claude start therefore refuses with
// AGENT_OPTIMIZED_TOOLS_UNSUPPORTED instead of silently widening or narrowing,
// and every row below says so in plain words.
const OPTIMIZED_ONLY_CLAUDE = 'Optimized works with Claude only.';
const PROVIDER_NAMES = Object.freeze({ codex: 'Codex' });
const OPTIMIZED_CLAUDE_TOOLS = Object.freeze(['Glob', 'Grep', 'Skill', 'TodoWrite', 'ToolSearch']);
const NO_NATIVE_TOOLS = Object.freeze([]);
function optimizedToolSupport({ provider = null, client = null, roleFunctionsOnly = false } = {}) {
  const selectedProvider = typeof provider === 'string' && provider.length ? provider : null;
  let status = 'unknown';
  let reason = selectedProvider === null
    ? `${OPTIMIZED_ONLY_CLAUDE} Each new session checks its provider when it starts.`
    : `${OPTIMIZED_ONLY_CLAUDE} Sessions on this provider do not start while it is selected.`;
  let nativeTools = NO_NATIVE_TOOLS;
  if (selectedProvider === 'claude' && (client === null || client === 'claude')) {
    status = 'supported';
    reason = roleFunctionsOnly
      ? 'This role permits Fleet tools only; native tools remain unavailable.'
      : 'Claude sessions add file search, skills, planning and tool search, within the existing role and permission limits.';
    nativeTools = roleFunctionsOnly ? NO_NATIVE_TOOLS : OPTIMIZED_CLAUDE_TOOLS;
  } else if (Object.hasOwn(PROVIDER_NAMES, selectedProvider)) {
    status = 'unsupported';
    reason = `${OPTIMIZED_ONLY_CLAUDE} ${PROVIDER_NAMES[selectedProvider]} sessions do not start while it is selected.`;
  } else if (selectedProvider === 'claude') {
    status = 'unsupported';
    reason = `${OPTIMIZED_ONLY_CLAUDE} This older Claude route cannot apply the selection, so the session does not start.`;
  }
  return Object.freeze({ provider: selectedProvider, status, reason, nativeTools });
}

function optimizedApiSupport() {
  return Object.freeze({
    scope: 'installation',
    appliesTo: 'new-sessions',
    providers: Object.freeze(['claude', 'codex']
      .map(provider => optimizedToolSupport({ provider })))
  });
}

/** Resolve one mode, accepting the former boolean values without rewriting them. */
function agentApiMode({ valuesPath, env } = {}) {
  const registry = settingsRegistryModule().loadRegistry();
  if (!registry.byId.has(AGENT_API_SETTING_ID)) return 'Enabled';
  const resolved = settingsModule().loadSettings({ registry, valuesPath, env });
  const mode = normalizeAgentApiMode(resolved.values[AGENT_API_SETTING_ID]);
  if (!mode || resolved.rejected?.some(item => item.id === '*' || item.id === AGENT_API_SETTING_ID)) {
    const error = new Error('The agent API mode could not be read. The session was not started.');
    error.code = 'AGENT_API_MODE_UNAVAILABLE';
    throw error;
  }
  return mode;
}

// Compatibility name for callers asking whether native tools are restricted.
function agentApiEnabled(options = {}) {
  return agentApiMode(options) === 'Only';
}

/** Native-tool arguments; the session plan separately controls API availability. */
function agentApiArgs({ enabled = null, mode = null, valuesPath, env } = {}) {
  const selected = mode !== null ? normalizeAgentApiMode(mode)
    : enabled !== null ? normalizeAgentApiMode(enabled) : agentApiMode({ valuesPath, env });
  if (!selected) throw new Error('Unknown agent API mode.');
  if (selected === 'Only') return ['--tools', '', '--setting-sources', '', '--disable-slash-commands'];
  if (selected === 'Optimized') return ['--tools', optimizedToolSupport({ provider: 'claude' }).nativeTools.join(',')];
  return [];
}

module.exports = Object.freeze({
  AGENT_API_SETTING_ID,
  AGENT_API_MODES,
  normalizeAgentApiMode,
  agentApiMode,
  optimizedToolSupport,
  optimizedApiSupport,
  agentApiEnabled,
  agentApiArgs
});
