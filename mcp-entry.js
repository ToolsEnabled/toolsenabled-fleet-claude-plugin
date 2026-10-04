#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { resolveConfig, configureEnvironment } = require('./runtime-config');
const { waitForSetup, runRebind, elsewhereGuidance } = require('./setup-server');
const { projectFolder, inside } = require('./project-folder');

function setupNeeded(error) {
  return ['HOST_SETUP_REQUIRED', 'HOST_PLUGIN_REBIND_REQUIRED'].includes(error.code)
    || /Fleet setup is required|Fleet plugin changed or is not configured/.test(error.message);
}

// After a plugin update the runtime moves. The person already chose this
// project, so Fleet binds the new runtime to it instead of asking again.
function rebind(config, host) {
  let previous;
  try { previous = host.readHostConfig(config.stateRoot, { setupKind: 'plugin', allowPluginRebind: true }); }
  catch { return false; }
  if (previous.setupKind !== 'plugin') return false;
  return runRebind();
}

async function main() {
  const config = configureEnvironment(resolveConfig());
  require('./node-guard').assertSafeNode();
  const host = require(path.join(config.engine, 'src/lib/host-runtime'));
  const saved = () => host.readHostConfig(config.stateRoot, { setupKind: 'plugin' });
  const bridge = require('./session-bridge');
  const here = projectFolder();
  let current = null;
  try {
    current = saved();
  } catch (error) {
    if (!setupNeeded(error)) throw error;
    if (error.code === 'HOST_PLUGIN_REBIND_REQUIRED' && rebind(config, host)) {
      try { current = saved(); } catch { current = null; }
    }
  }
  if (current && inside(here, current.workspace)) return bridge.serveSession(config);
  // Serve the setup tools. In another project Fleet's tools would act on the
  // set-up project, so they are not offered here until Fleet moves. Once setup
  // covers this project, switch to the full server in this same session and
  // tell Claude Code its tool list changed.
  const handoff = await waitForSetup(process.stdin, process.stdout, {
    isReady: () => { try { return inside(here, saved().workspace); } catch { return false; } },
    ...(current ? { notice: elsewhereGuidance(current.workspace) } : {}),
  });
  if (!handoff) return;
  return bridge.serveSession(config, { preInitialized: handoff.initParams, initialBuffer: handoff.remainder });
}
if (require.main === module) main().catch(error => {
  process.stderr.write(`Fleet could not start: ${error.message}\n`);
  process.exitCode = 1;
});
module.exports = { main, resolveConfig };
