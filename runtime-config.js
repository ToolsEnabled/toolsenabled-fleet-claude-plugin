'use strict';
const os = require('node:os');
const path = require('node:path');
const engine = path.join(__dirname, 'runtime', 'engine');

function absolute(value, name) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value
      || value === path.parse(value).root || /[\x00-\x1f\x7f]/.test(value) || value.includes('${')) {
    throw new Error(`Absolute path required for ${name}; use a full path without ~ or placeholders.`);
  }
  return value;
}
// This plugin runs Fleet on the person's own computer only.
function assertRuntimeMode(env) {
  if (env.OPENSHELL_SANDBOX === '1') {
    throw new Error('Fleet runs on your own computer, not inside an OpenShell sandbox.');
  }
  return 'host';
}
function resolveConfig(env = process.env, home = os.homedir()) {
  absolute(home, 'account home');
  const mode = assertRuntimeMode(env);
  const stateRoot = absolute(env.TOOLSENABLED_FLEET_STATE_ROOT || path.join(home, '.toolsenabled-fleet-plugin'), 'state_root');
  return Object.freeze({ mode, stateRoot, engine });
}
// The environment of a process Fleet starts for itself: the person's own, without
// any provider sign-in variable, whoever the provider is.
function childEnvironment(env = process.env) {
  return require(path.join(engine, 'src/lib/supervision/launch-environment')).safeLaunchEnvironment(env, { context: 'Fleet helper' });
}
function configureEnvironment(config, env = process.env) {
  // Empty optional forwarded variables mean absent, never a relative path.
  for (const name of require('./startup-env.json')) if (env[name] === '') delete env[name];
  for (const name of ['HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS',
    'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'GIT_SSL_CAINFO']) {
    if (env[name]) absolute(env[name], name);
  }
  env.TOOLSENABLED_STATE_ROOT = config.stateRoot;
  // Keep Fleet's service records separate from any other installation.
  env.LOCALAPPDATA = config.stateRoot;
  return config;
}
module.exports = { engine, absolute, resolveConfig, configureEnvironment, childEnvironment, assertRuntimeMode };
