#!/usr/bin/env node
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { resolveConfig, configureEnvironment } = require('./runtime-config');

function options(argv) {
  const result = { includeClosed: false, offset: 0, limit: 10 };
  const seen = new Set();
  for (let at = 0; at < argv.length; at++) {
    const flag = argv[at];
    if (seen.has(flag)) throw new Error('Repeated ledger option.');
    seen.add(flag);
    if (flag === '--all') result.includeClosed = true;
    else if (['--offset', '--limit', '--revision'].includes(flag) && /^\d+$/.test(argv[at + 1] || '')) {
      result[flag.slice(2)] = Number(argv[++at]);
    } else throw new Error('Ledger pane is read-only. Use --all, --offset, --limit or --revision.');
  }
  if (!Number.isSafeInteger(result.offset) || !Number.isSafeInteger(result.limit) || result.limit < 1 || result.limit > 100
      || result.revision !== undefined && !Number.isSafeInteger(result.revision)) throw new Error('Invalid ledger page bounds.');
  return result;
}
function ledgerReader(ledgerRoot, store) {
  return args => store.readAll({ ...args, rootPath: (...segments) => path.join(ledgerRoot, ...segments) });
}
function main(argv = process.argv.slice(2)) {
  const query = options(argv);
  const config = configureEnvironment(resolveConfig());
  require('./node-guard').assertSafeNode();
  const runtime = require(path.join(config.engine, 'src/lib/host-runtime'));
  const record = runtime.readHostConfig(config.stateRoot, { setupKind: 'plugin' });
  if (record.setupKind !== 'plugin') throw new Error('Run /fleet setup first.');
  // Fleet's MCP keeps its records in capability/.
  // Do not call configureHost: a read must not initialize directories/state.
  process.env.TOOLSENABLED_STATE_ROOT = path.join(config.stateRoot, 'capability');
  const ledgerRoot = process.env.TOOLSENABLED_STATE_ROOT;
  // A complete setup already created this directory. Imported runtime helpers
  // must never initialize it on a partial setup during a read.
  if (!fs.existsSync(ledgerRoot)) throw new Error('Run /fleet setup first.');
  const page = require(path.join(config.engine, 'src/lib/openshell-ledger-page'));
  if (typeof page.machineView !== 'function') throw new Error('This Fleet runtime lacks the ledger reader. Update the plugin.');
  // readAll's explicit rootPath avoids runtime-state-root's mkdir/adoption
  // side effects on an absent ledger. The setup binding above owns this root.
  const store = require(path.join(config.engine, 'src/lib/owner-request-store'));
  const read = ledgerReader(ledgerRoot, store);
  process.stdout.write(JSON.stringify(page.machineView(query, { read })) + '\n');
}
if (require.main === module) {
  try { main(); } catch (error) {
    process.stderr.write(`${error.code || 'LEDGER_UNAVAILABLE'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}
module.exports = { main, options, resolveConfig, ledgerReader };
