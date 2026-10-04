'use strict';

// The tools Fleet offers on the host (src/lib/host-surface.js): a reviewed
// positive list, applied through TOOLSENABLED_TOOL_ALLOWLIST on top of the
// recorded permission level. Desktop tools, sandboxes, credential capture,
// egress checks and integrations that need their own credentials are not
// offered. Agent control is offered only with subagents on (below).

const OPENSHELL_TOOLS = Object.freeze([
  // The shared work record: tasks any agent can pick up where another stopped.
  'task.submit', 'task.claim', 'task.start', 'task.heartbeat', 'task.checkpoint',
  'task.complete', 'task.fail', 'task.cancel', 'task.get', 'task.list',
  'ledger.read', 't_ledger.file', 't_ledger.progress', 't_ledger.complete',
  // Asks for the person, answered from the ledger. Standing rules come only
  // from the person (/tefleet ledger rule), so the rule-filing tool, which
  // always refuses an agent, is not offered.
  'a_ledger.file',
  // Byte-mediated file editing (docs/byte-coordination.md, host section): a
  // write or patch needs this agent's read of the current bytes, byte-disjoint
  // edits by different agents are rebased, and stale edits refuse, so agents
  // sharing one workspace do not clobber each other. Bounded by the sealed
  // workspace record, with credential files refused. host.exec is not
  // offered; agents have their own shells.
  'host.read_file', 'host.write_file', 'host.patch_file', 'host.list_dir',
  // Memory and local search that carry across sessions and agents.
  'memory.get', 'memory.set', 'memory.search',
  'search.index', 'search.query', 'search.status',
  // What is running, what is allowed, and the signed record of what happened.
  'settings.read', 'capability.find', 'system.status', 'system.doctor',
  'audit.status', 'audit.tail', 'audit.verify'
]);

// Offered only when subagents are on: the agent tree (src/lib/openshell-agent-host.js),
// Codex and Claude workers that can start workers of their own, their
// lifecycle and slot controls, and the local message route between them. Each
// session's role still narrows them (the slot controls are an explicit role
// grant, src/lib/role-functions.js). agent.set_account is not offered: each
// CLI uses its own sign-in.
const OPENSHELL_AGENT_TOOLS = Object.freeze([
  'agent.spawn', 'agent.wait', 'agent.stop', 'agent.restart', 'agent.remove', 'agent.resume',
  'agent.set_model', 'agent.set_effort', 'agent.set_provider', 'agent.set_role',
  'agent_comms.send_local', 'agent_comms.local_roster',
]);

module.exports = Object.freeze({ OPENSHELL_TOOLS, OPENSHELL_AGENT_TOOLS });
