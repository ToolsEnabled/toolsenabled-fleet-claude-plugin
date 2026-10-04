#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { resolveConfig, configureEnvironment } = require('./runtime-config');
async function main() {
  const config = configureEnvironment(resolveConfig());
  require('./node-guard').assertSafeNode();
  await require(path.join(config.engine, 'bin/toolsenabled-host.js')).main([
    'serve', '--plugin', '--actor', 'claude', '--state-root', config.stateRoot,
  ]);
}
if (require.main === module) main().catch(error => {
  process.stderr.write(`Fleet could not start: ${error.message}\n`);
  process.exitCode = 1;
});
module.exports = { main };
