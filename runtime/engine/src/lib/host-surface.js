'use strict';

const { OPENSHELL_TOOLS, OPENSHELL_AGENT_TOOLS } = require('./openshell-surface');

// Fleet's work record and mediated files, offered on this host.
const HOST_TOOLS = OPENSHELL_TOOLS;
function hostAllowlist({ workers = false } = {}) {
  return workers ? [...HOST_TOOLS, ...OPENSHELL_AGENT_TOOLS] : [...HOST_TOOLS];
}

module.exports = { HOST_TOOLS, hostAllowlist };
