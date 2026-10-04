'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Fleet's settings are the person's. Claude may show them; only the person
// changes them, by typing /tefleet settings, which the prompt hook applies
// without a model turn.
const CHANGE_HINT = 'To change them, type /tefleet settings followed by the change, for example /tefleet settings depth 2.';

const settingsTool = Object.freeze({
  name: 'fleet_settings', title: 'Fleet settings',
  description: 'Show Fleet\'s settings for this project: depth (levels of subagents below this session), width (subagents each agent may have running at once), which agent CLIs (providers) and models subagents may use, the Agent API mode with the tools it gives each agent CLI\'s subagents, and audit (off by default, when Fleet keeps no audit record; on, Fleet signs a record of the reads and writes of Fleet\'s own file tools, ledger changes and task and memory changes it makes, and refuses any of them it cannot record). Changes nothing: only the person changes these settings, by typing /tefleet settings followed by the change.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
});

// The tools each Agent API mode gives a subagent of each agent CLI at the
// Standard level, the only level the plugin runs. Claude subagents always get
// Read, Edit and Write in the project and no shell; the mode decides only
// whether Fleet's tools come with them. Codex has no way to apply Optimized.
const MODE_TOOLS = Object.freeze({
  Only: Object.freeze({
    claude: 'Read, Edit and Write in the project, plus Fleet\'s coordination tools',
    codex: 'Fleet\'s tools only: it changes files through Fleet\'s file tools, which refuse the protected paths; Codex\'s own file editing, shell and other built-in tools are off' }),
  Optimized: Object.freeze({
    claude: 'the same as Only: Read, Edit and Write in the project, plus Fleet\'s coordination tools',
    codex: 'none, because Codex subagents do not start in this mode' }),
  Enabled: Object.freeze({
    claude: 'the same as Only: Read, Edit and Write in the project, plus Fleet\'s coordination tools',
    codex: 'Fleet\'s tools and Codex\'s own tools, including its shell, which runs in Codex\'s sandbox with network access off' }),
  Disabled: Object.freeze({
    claude: 'Read, Edit and Write in the project, without Fleet\'s tools',
    codex: 'Codex\'s own tools, including its shell in Codex\'s sandbox, without Fleet\'s tools' }),
});
const CLI_NAMES = Object.freeze({ claude: 'Claude Code', codex: 'Codex' });

function text(value, isError = false) {
  return { ...(isError ? { isError: true } : {}), content: [{ type: 'text', text: value }] };
}

// Settings as the person reads them. `view` is settings-entry.js's JSON.
function describeSettings(view) {
  const available = Object.entries(view.modelsAvailable || {}).map(([provider, names]) => `${provider}: ${names.join(', ')}`).join('; ');
  const models = view.models === 'all' ? `all${available ? ` (${available})` : ''}`
    : `${view.models.join(', ')} (other providers keep all their models)`;
  const tools = MODE_TOOLS[view.apiMode] || {};
  const used = view.subagents ? (view.providers || []).filter(name => Object.hasOwn(tools, name)) : [];
  return [`Fleet settings for ${view.workspace}:`,
    `- Subagents: ${view.subagents ? `on, using ${view.providers.join(', ')}` : 'off'}`,
    `- Depth: ${view.depth} level${view.depth === 1 ? '' : 's'} of subagents below this session`,
    `- Width: up to ${view.width} subagent${view.width === 1 ? '' : 's'} running at once under each agent`,
    `- Agent API mode: ${view.apiMode}${view.apiMode === 'Only' ? ' (the default)' : ''}`,
    ...used.map(name => `  - ${CLI_NAMES[name] || name} subagents get ${tools[name]}.`),
    `- Models: ${models}`,
    `- Audit: ${view.audit ? 'on' : 'off'}`,
    ...(view.notes || [])];
}

// Shows the settings through settings-entry.js. Any change is refused: the
// person makes it by typing /tefleet settings.
function runSettings(args = {}, { run = spawnSync, env = process.env } = {}) {
  const asked = args && typeof args === 'object' && !Array.isArray(args) ? Object.keys(args) : ['?'];
  if (asked.length) {
    return text('Fleet\'s settings were not changed. Only the person changes them: ask them to type /tefleet settings followed by the change, for example /tefleet settings depth 2. Fleet applies it without going through you.', true);
  }
  const result = run(process.execPath, [path.join(__dirname, 'settings-entry.js'), '--show'],
    { env, encoding: 'utf8', timeout: 90000, maxBuffer: 1024 * 1024 });
  if (result.status !== 0) {
    const detail = String(result.stderr || result.error?.message || 'Settings failed.')
      .replace(/^Fleet settings failed:\s*/, '').replace(/^[A-Z][A-Z0-9_]+:\s*/, '').trim();
    return text(`Fleet settings are unavailable: ${detail}`, true);
  }
  let view;
  try { view = JSON.parse(result.stdout.slice(result.stdout.indexOf('{'))); }
  catch { return text('Fleet settings returned an unexpected result.', true); }
  // Text only: a client given structured data shows that to the model instead.
  return text([...describeSettings(view), CHANGE_HINT].join('\n'));
}

module.exports = { settingsTool, runSettings, describeSettings, MODE_TOOLS, CHANGE_HINT };
