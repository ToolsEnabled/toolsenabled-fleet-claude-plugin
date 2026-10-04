'use strict';

// Where the person reads and changes Fleet's ledger. The plugin is the only
// way Fleet runs, so the answer is always its own command.
function ledgerPlace() {
  return 'by typing /tefleet ledger in Claude Code';
}

module.exports = { ledgerPlace };
