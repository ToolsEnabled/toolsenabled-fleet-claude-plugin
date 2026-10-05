'use strict';

// The installed worker adapters, in one shared presentation order (alphabetical). Transport
// attribution remains open to other bounded provider ids.
const PROVIDER_ORDER = Object.freeze(['claude', 'codex']);
const NATIVE_PROVIDERS = PROVIDER_ORDER;
const PROVIDER_ID = /^[a-z][a-z0-9_-]{0,31}$/;
const RESERVED_ACTORS = new Set(['human', 'coordinator', 'owner', 'person']);
function isProviderId(value) { return typeof value === 'string' && PROVIDER_ID.test(value) && !RESERVED_ACTORS.has(value); }

function workerCatalog() {
  const installed = require('./fleet-worker-tiers');
  const tiers = Object.freeze(Object.fromEntries(Object.entries(installed)
    .filter(([, row]) => NATIVE_PROVIDERS.includes(row.provider))));
  return Object.freeze({ tiers, providers: NATIVE_PROVIDERS });
}

module.exports = Object.freeze({ PROVIDER_ORDER, NATIVE_PROVIDERS, PROVIDER_ID, isProviderId, workerCatalog });
