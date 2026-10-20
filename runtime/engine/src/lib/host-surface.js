'use strict';

const { OPENSHELL_TOOLS, OPENSHELL_AGENT_TOOLS } = require('./openshell-surface');

// Fleet's work record and mediated files, offered on this host.
const reviewed = new Set(require('./claude-plugin-policy.json').allowedTools);
const HOST_TOOLS = Object.freeze(OPENSHELL_TOOLS.filter(name => reviewed.has(name)));
function hostAllowlist({ workers = false } = {}) {
  return (workers ? [...HOST_TOOLS, ...OPENSHELL_AGENT_TOOLS] : [...HOST_TOOLS]).filter(name => reviewed.has(name));
}

module.exports = { HOST_TOOLS, hostAllowlist };
