#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { resolveConfig, configureEnvironment } = require('./runtime-config');
async function main(argv = process.argv.slice(2)) {
  if (argv.some(arg => !['--watch', '--json-lines', '--session'].includes(arg))) throw new Error('Use --watch --json-lines [--session].');
  const config = configureEnvironment(resolveConfig());
  require('./node-guard').assertSafeNode();
  if (argv.includes('--session')) {
    require(path.join(config.engine, 'src/lib/host-runtime')).readHostConfig(config.stateRoot, { setupKind: 'plugin' });
    return require('./session-binding').streamSession(config, { watch: argv.includes('--watch') });
  }
  await require(path.join(config.engine, 'bin/toolsenabled-host.js')).main([
    'tree', '--plugin', '--state-root', config.stateRoot, ...argv,
  ]);
}
if (require.main === module) main().catch(error => {
  process.stderr.write(`Fleet tree unavailable: ${error.message}\n`);
  process.exitCode = 1;
});
module.exports = { main, resolveConfig };
