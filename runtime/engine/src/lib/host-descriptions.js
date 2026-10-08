'use strict';

// The note Fleet's MCP server gives an agent when a session starts
// (src/mcp-server.js sessionInstructions). The tool descriptions themselves are
// the registry's own (src/lib/tool-registry.js); this note covers what no
// single tool says.
const SUBAGENT_WARNING = 'Subagents are experimental. They run as your user, confined to the project folder, with no shell or web tools of their own and approvals never. An action needing a new permission is declined.';

function briefToolSummary({ tier, allowedNames } = {}) {
  const offered = name => allowedNames.includes(name);
  const subagents = offered('agent.spawn')
    ? tier === 'standard'
      ? `Subagents: on. ${SUBAGENT_WARNING}`
      : `Subagents: on, at the ${tier} permission level. ${SUBAGENT_WARNING}`
    : 'Subagents: off. The person turns them on with /tefleet setup once an agent CLI is installed and signed in.';
  return { enabled: true, text: [
    'ToolsEnabled Fleet: subagents, a ledger the person reads, a shared task queue and memory, for when the person asks for them.',
    'Tool descriptions name Fleet tools by id, such as agent.wait; your client may show the dot as an underscore.',
    'Fleet runs with your own permissions and network. It is not a sandbox, and it does not store the agent CLIs\' sign-ins.',
    subagents,
    'When the work calls for it: the ledger (ledger.read, t_ledger.*, a_ledger.file) holds tasks and questions the person sees with /tefleet ledger, task.* holds work any agent can claim, and memory.* holds notes every agent Fleet starts can read. Memory and the ledger stay with Fleet when it moves to another project.',
    ...(offered('host.read_file')
      ? ['Use host.read_file before host.write_file or host.patch_file for coordinated edits. Shell and native file edits do not participate in this coordination.']
      : []),
    'Only the person adds standing rules. If the person asks you to record one, tell them to type /tefleet ledger rule followed by the rule; Fleet files it under their name without going through you.',
    'Settings are the person\'s: read them with settings.read; the person changes them with /tefleet settings.',
    'If a tool is absent, say so. The person sets up Fleet with /tefleet setup in the current project.'
  ].join('\n') };
}

module.exports = { SUBAGENT_WARNING, briefToolSummary };
