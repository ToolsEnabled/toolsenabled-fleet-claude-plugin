'use strict';

// Two constants kept code reads. src/mcp-server.js and src/lib/settings.js fall
// back to FAIL_CLOSED_TIER when the machine record is absent or cannot be
// trusted; src/lib/host-worker-session.js turns off
// CODEX_API_ONLY_DISABLED_FEATURES for a Codex subagent in the Only agent API
// mode. This module does not choose a sandbox or a permission mode.

// The level a session runs at when the recorded one cannot be honoured.
//
// This is the fail-closed direction and it is deliberately the FIRST tier, not a
// fourth "safe" mode invented here: a level nobody can select is a level nobody
// tests. An absent record means setup has not run, which is precisely when the
// user has not yet consented to anything.
const FAIL_CLOSED_TIER = 'guided';

/* The native Codex features a Codex subagent runs without in the Only agent
   API mode. src/lib/host-worker-session.js passes each as
   `-c features.<name>=false`. */
const CODEX_API_ONLY_DISABLED_FEATURES = Object.freeze([
  'shell_tool', 'unified_exec', 'apps', 'browser_use', 'browser_use_external',
  'browser_use_full_cdp_access', 'computer_use', 'code_mode',
  'multi_agent', 'multi_agent_v2', 'goals', 'hooks', 'plugins', 'remote_plugin',
  'plugin_sharing', 'image_generation', 'view_image', 'in_app_browser',
  'in_app_chat', 'in_app_local_automation', 'in_app_updates',
  'skill_mcp_dependency_install', 'workspace_dependencies', 'tool_suggest',
]);

module.exports = Object.freeze({
  FAIL_CLOSED_TIER,
  CODEX_API_ONLY_DISABLED_FEATURES
});
