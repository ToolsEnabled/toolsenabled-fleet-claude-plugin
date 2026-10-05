'use strict';

// Native worker choices for the Fleet tree. The catalog is data so discovering
// a worker never initializes a detached dispatcher or any provider session.
const declared = require('./fleet-worker-tiers.json');
const { PROVIDER_ORDER } = require('./openshell-worker-providers');
const tiers = {};
for (const [name, row] of Object.entries(declared).sort(([, a], [, b]) =>
  PROVIDER_ORDER.indexOf(a.provider) - PROVIDER_ORDER.indexOf(b.provider))) {
  if (!PROVIDER_ORDER.includes(row.provider)
      || typeof row.model !== 'string' || typeof row.cliModel !== 'string'
      || !['cheap', 'standard', 'premium'].includes(row.tier)) {
    throw new TypeError(`Invalid Fleet worker tier: ${name}`);
  }
  tiers[name] = Object.freeze({
    ...row,
    ...(row.efforts === undefined ? {} : { efforts: Object.freeze([...row.efforts]) })
  });
}

module.exports = Object.freeze(tiers);
