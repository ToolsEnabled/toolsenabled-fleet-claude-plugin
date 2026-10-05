'use strict';

// Saved modes remain readable for compatibility. Every execution uses the
// same confined tool set.

const { AGENT_API_SETTING_ID, AGENT_API_MODES, normalizeAgentApiMode } = require('./agent-api-mode');

// Required lazily, for the reason src/lib/agent-tool-summary.js gives: a caller
// asking only whether a switch is on has no business loading the settings graph
// at module load time.
function settingsModule() { return require('./settings'); }
function settingsRegistryModule() { return require('./settings-registry'); }

// Saved selections share one tool policy for every provider.
const NO_NATIVE_TOOLS = Object.freeze([]);
function optimizedToolSupport({ provider = null } = {}) {
  const selectedProvider = typeof provider === 'string' && provider.length ? provider : null;
  return Object.freeze({ provider: selectedProvider, status: 'supported',
    reason: 'Every saved mode gives new sessions the same tools.', nativeTools: NO_NATIVE_TOOLS });
}

function optimizedApiSupport() {
  return Object.freeze({
    scope: 'installation',
    appliesTo: 'new-sessions',
    providers: Object.freeze(require('./openshell-worker-providers').PROVIDER_ORDER
      .map(provider => optimizedToolSupport({ provider })))
  });
}

/** The mode every session runs with. All four saved choices gave the same tools, so what is saved is not read:
 *  it cannot change a session, and a damaged value cannot stop one. */
function agentApiMode() { return 'Only'; }

// Compatibility name for callers asking whether native tools are restricted.
function agentApiEnabled(options = {}) { agentApiMode(options); return true; }

/** Native-tool arguments; the session plan separately controls API availability. */
function agentApiArgs({ enabled = null, mode = null, valuesPath, env } = {}) {
  const selected = mode !== null ? normalizeAgentApiMode(mode)
    : enabled !== null ? normalizeAgentApiMode(enabled) : agentApiMode({ valuesPath, env });
  if (!selected) throw new Error('Unknown agent API mode.');
  return ['--tools', '', '--setting-sources', '', '--disable-slash-commands'];
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
