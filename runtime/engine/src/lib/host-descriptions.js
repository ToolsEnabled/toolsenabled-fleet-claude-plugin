'use strict';

// The note Fleet's MCP server gives Claude when a session starts
// (src/mcp-server.js sessionInstructions). The tool descriptions themselves are
// the registry's own (src/lib/tool-registry.js); this note covers what no
// single tool says.
function briefToolSummary({ tier, allowedNames } = {}) {
  const offered = name => allowedNames.includes(name);
  const subagents = offered('agent.spawn')
    ? tier === 'standard'
      ? 'Subagents: on. Claude uses workspace-only Read, Edit and Write with no prompts; Codex project-local configuration is disabled; Codex uses workspace-write, no extra writable roots, network off and approvals never. A subagent action that needs a new permission is declined, because a subagent running in the background cannot ask the person.'
      : `Subagents: on, at the ${tier} permission level; a subagent action that needs a new permission is declined.`
    : 'Subagents: off. The person turns them on with /tefleet setup once an agent CLI is installed and signed in.';
  return { enabled: true, text: [
    'ToolsEnabled Fleet for this project: subagents, a ledger the person reads, a shared task queue and project memory.',
    'Tool descriptions name Fleet tools by id, such as agent.wait; your client may show the dot as an underscore.',
    'Fleet runs with your own permissions and network. It is not a sandbox, and it does not store the agent CLIs\' sign-ins.',
    subagents,
    'Use the ledger (ledger.read, t_ledger.*, a_ledger.file) for tasks and questions the person sees with /tefleet ledger, task.* for work any agent can claim, and memory.* for notes every agent in the project can read.',
    ...(offered('host.read_file')
      ? ['Use host.read_file before host.write_file or host.patch_file for coordinated edits. Shell and native file edits do not participate in this coordination.']
      : []),
    'Only the person adds standing rules. If the person asks you to record one, tell them to type /tefleet ledger rule followed by the rule; Fleet files it under their name without going through you.',
    'Settings are the person\'s: read them with settings.read; the person changes them with /tefleet settings.',
    'If a tool is absent, say so. The person sets up Fleet with /tefleet setup in the current project.'
  ].join('\n') };
}

module.exports = { briefToolSummary };
