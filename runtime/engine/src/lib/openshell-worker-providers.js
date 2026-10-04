'use strict';

// The native client adapters subagents run on: the claude and codex CLIs.
const NATIVE_PROVIDERS = Object.freeze(['codex', 'claude']);

function workerCatalog() {
  const installed = require('./fleet-worker-tiers');
  const tiers = Object.freeze(Object.fromEntries(Object.entries(installed)
    .filter(([, row]) => NATIVE_PROVIDERS.includes(row.provider))));
  return Object.freeze({ tiers, providers: NATIVE_PROVIDERS });
}

module.exports = Object.freeze({ NATIVE_PROVIDERS, workerCatalog });
