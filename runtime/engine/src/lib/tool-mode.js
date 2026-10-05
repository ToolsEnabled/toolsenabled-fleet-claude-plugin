'use strict';

// Compatibility labels stay distinct in storage. Execution uses one tool set.
const { AGENT_API_SETTING_ID, TOOL_MODE_SETTING_ID, TOOL_MODES, normalizeAgentApiMode } = require('./agent-api-mode');
const SETTING_ID = TOOL_MODE_SETTING_ID;
const LEGACY_SETTING_ID = AGENT_API_SETTING_ID;
const MODE = Object.freeze({ ONLY: TOOL_MODES.Only, OPTIMIZED: TOOL_MODES.Optimized, BOTH: TOOL_MODES.Enabled, NATIVE: TOOL_MODES.Disabled });
const MODES = Object.freeze(Object.values(MODE));
const DEFAULT_MODE = MODE.ONLY;
function modeFromSettings(settings) {
  const values = settings && settings.values || {};
  const canonical = normalizeAgentApiMode(values[AGENT_API_SETTING_ID]);
  if (!canonical || settings?.rejected?.some(item => item.id === '*' || item.id === AGENT_API_SETTING_ID)) {
    throw Object.assign(new Error('The agent API mode could not be read.'), { code: 'AGENT_API_MODE_UNAVAILABLE' });
  }
  return TOOL_MODES[canonical];
}
function toolMode(options = {}) {
  const settings = (options.loadSettings || require('./settings').loadSettings)(options);
  return modeFromSettings(settings);
}
function toolsEnabledAvailable(options = {}) { toolMode(options); return true; }
function executionToolMode(context = {}) {
  // Trusted in-process bindings outrank ambient launch state. When both bound
  // representations are supplied they must agree; a tool request cannot choose.
  const hasBound = Object.hasOwn(context, 'toolMode') || Object.hasOwn(context, 'agentApiMode');
  const bound = hasBound ? context.toolMode : process.env.TOOLSENABLED_AGENT_TOOL_MODE;
  const canonical = hasBound && Object.hasOwn(context, 'agentApiMode') ? normalizeAgentApiMode(context.agentApiMode) : undefined;
  if (hasBound || bound !== undefined) {
    if ((Object.hasOwn(context, 'agentApiMode') && !canonical)
        || (bound !== undefined && !MODES.includes(bound))
        || (canonical && bound !== undefined && TOOL_MODES[canonical] !== bound)
        || (!canonical && bound === undefined)) {
      throw Object.assign(new Error('The bound session tool mode is invalid or conflicting.'), { code: 'AGENT_TOOL_MODE_INVALID' });
    }
    return MODE.ONLY;
  }
  toolMode();
  return MODE.ONLY;
}
function assertToolsEnabled(context = {}) { executionToolMode(context); }
module.exports = Object.freeze({ SETTING_ID, LEGACY_SETTING_ID, MODE, MODES, DEFAULT_MODE, modeFromSettings, toolMode, toolsEnabledAvailable, executionToolMode, assertToolsEnabled });
