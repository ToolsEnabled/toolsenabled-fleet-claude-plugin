'use strict';

// One ordered catalog of the agent CLIs Fleet may start as subagents, in one
// presentation order (alphabetical). A CLI is listed here only after it has
// passed Fleet's real hand tests. The ACP transport details of the CLIs that
// speak the Agent Client Protocol live in agent-engine/acp-profiles.js.
const rows = [
  { id: 'claude', displayName: 'Claude Code', resumeName: 'Claude', kind: 'native',
    classes: { cheap: 'claude-fable', standard: 'claude-sonnet', premium: 'claude-opus' },
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'codex', displayName: 'Codex', resumeName: 'Codex', kind: 'native',
    classes: { cheap: 'luna', standard: 'terra', premium: 'sol' },
    efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
  { id: 'opencode', displayName: 'OpenCode', kind: 'acp', profile: 'opencode',
    npmPackage: 'opencode-ai',
    classes: { standard: 'opencode-auto' }, efforts: [] }
];

const SUBAGENT_CLIS = Object.freeze(rows.map((row, order) => Object.freeze({
  ...row, order, classes: Object.freeze(row.classes), efforts: Object.freeze(row.efforts)
})));
const PROVIDER_ORDER = Object.freeze(SUBAGENT_CLIS.map(row => row.id));
const BY_ID = Object.freeze(Object.fromEntries(SUBAGENT_CLIS.map(row => [row.id, row])));
function subagentCli(id) { return Object.hasOwn(BY_ID, id) ? BY_ID[id] : null; }

module.exports = Object.freeze({ SUBAGENT_CLIS, PROVIDER_ORDER, ORG_PROVIDER_ORDER: PROVIDER_ORDER, BY_ID, subagentCli });
