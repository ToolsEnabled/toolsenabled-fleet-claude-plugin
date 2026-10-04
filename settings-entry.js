#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveConfig, configureEnvironment } = require('./runtime-config');
// Fleet's settings. Depth, width, the Agent API mode and audit are the engine's
// own settings; providers and models are saved by setup, so changing them runs
// setup again for the same project (which re-checks each agent CLI). Changes
// come only from the person: the prompt hook runs --apply for
// /tefleet settings, and Claude's fleet_settings tool only runs --show.
const SETTINGS = Object.freeze({
  depth: Object.freeze({ id: 'fleet.tree_depth', min: 1, max: 16 }),
  width: Object.freeze({ id: 'fleet.tree_width', min: 1, max: 64 }),
  apiMode: Object.freeze({ id: 'agent.agent_api', options: Object.freeze(['Only', 'Optimized', 'Enabled', 'Disabled']) }),
  audit: Object.freeze({ id: 'audit.enabled', toggle: true }),
});
function run(args, what, { cwd, env = process.env } = {}) {
  const result = spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.error?.message || `${what} failed.`).replace(/^Fleet setup failed:\s*/, '').trim());
  }
  return result.stdout;
}
function host(config, args) {
  return run([path.join(config.engine, 'bin/toolsenabled-host.js'), ...args, '--plugin', '--state-root', config.stateRoot], 'Fleet settings');
}
function current(config) {
  const saved = require(path.join(config.engine, 'src/lib/host-runtime')).readHostConfig(config.stateRoot, { setupKind: 'plugin' });
  const tiers = require(path.join(config.engine, 'src/lib/fleet-worker-tiers'));
  const providers = saved.workers ? saved.providers || [...new Set(Object.values(tiers).map(row => row.provider))] : [];
  const view = { workspace: saved.workspace, subagents: saved.workers, providers, models: saved.models || 'all',
    modelsAvailable: Object.fromEntries(providers.map(provider => [provider,
      Object.keys(tiers).filter(name => tiers[name].provider === provider)])) };
  for (const [name, row] of Object.entries(SETTINGS)) {
    const record = (JSON.parse(host(config, ['settings', 'get', row.id, '--json'])).records || []).find(item => item.id === row.id);
    let value = record ? record.valueText : null;
    try { value = JSON.parse(value); } catch { /* plain text */ }
    view[name] = row.toggle ? value === true : row.options ? String(value) : Number(value);
  }
  return view;
}
function apply(config, changes) {
  const notes = [];
  for (const name of ['depth', 'width']) {
    const value = changes[name];
    if (value !== undefined && !(Number.isInteger(value) && value >= SETTINGS[name].min && value <= SETTINGS[name].max)) {
      throw new Error(`${name} must be a whole number from ${SETTINGS[name].min} through ${SETTINGS[name].max}.`);
    }
  }
  if (changes.apiMode !== undefined && !SETTINGS.apiMode.options.includes(changes.apiMode)) {
    throw new Error(`apiMode must be one of ${SETTINGS.apiMode.options.join(', ')}.`);
  }
  if (changes.audit !== undefined && typeof changes.audit !== 'boolean') throw new Error('audit must be true (on) or false (off).');
  const list = value => (value === undefined ? undefined : value === 'all' || (Array.isArray(value) && value.length === 1 && value[0] === 'all')
    ? 'all' : Array.isArray(value) && value.length && value.every(item => typeof item === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(item))
      ? value.join(',') : null);
  const providers = list(changes.providers);
  const models = list(changes.models);
  if (providers === null || models === null) throw new Error('providers and models are lists of names, or "all".');
  // Check the saved setup before changing anything.
  const saved = require(path.join(config.engine, 'src/lib/host-runtime')).readHostConfig(config.stateRoot, { setupKind: 'plugin' });
  if (providers !== undefined || models !== undefined) {
    const args = [path.join(__dirname, 'setup-entry.js'), '--setup', saved.workspace];
    const keep = saved.providers ? saved.providers.join(',') : undefined;
    const chosen = providers === undefined ? keep : providers === 'all' ? undefined : providers;
    if (chosen) args.push('--providers', chosen);
    if (models !== undefined) args.push('--models', models);
    // Setup accepts only the project of the session it runs for: this is the
    // saved project itself, set up again from its own folder.
    const done = JSON.parse(run(args, 'Fleet setup', { cwd: saved.workspace, env: { ...process.env, CLAUDE_PROJECT_DIR: saved.workspace } })
      .replace(/^[^{]*/, ''));
    if (!done.workers) notes.push(done.note || 'Subagents are off: no chosen agent CLI is ready.');
    else if (!saved.workers) notes.push('Subagents are now on. Start a new Claude Code session in this project to use them.');
    else notes.push('Provider and model changes apply now, including in this session.');
  }
  for (const name of ['depth', 'width', 'apiMode', 'audit']) {
    if (changes[name] !== undefined) host(config, ['settings', 'set', SETTINGS[name].id, String(changes[name])]);
  }
  if (changes.depth !== undefined || changes.width !== undefined) notes.push('Depth and width apply to the next subagent started.');
  if (changes.apiMode !== undefined) notes.push('The Agent API mode applies to subagents started from now on.');
  if (changes.audit === true) {
    notes.push('Audit is on from the next Fleet operation: Fleet signs a record of the file reads and writes, commands, ledger changes and task and memory changes it makes, and refuses any of them it cannot record. The audit tools appear in new Claude Code sessions.');
  } else if (changes.audit === false) notes.push('Audit is off. Records already made are kept; the audit tools leave new Claude Code sessions.');
  return { ...current(config), notes };
}
async function main(argv = process.argv.slice(2)) {
  const config = configureEnvironment(resolveConfig());
  require('./node-guard').assertSafeNode();
  if (argv.length === 1 && argv[0] === '--show') { process.stdout.write(JSON.stringify(current(config)) + '\n'); return; }
  if (argv.length === 2 && argv[0] === '--apply') {
    let changes;
    try { changes = JSON.parse(argv[1]); } catch { throw new Error('Settings changes must be JSON.'); }
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)
        || Object.keys(changes).some(key => !['depth', 'width', 'apiMode', 'audit', 'providers', 'models'].includes(key))) {
      throw new Error('Change only depth, width, apiMode, audit, providers or models.');
    }
    process.stdout.write(JSON.stringify(apply(config, changes)) + '\n');
    return;
  }
  throw new Error('Use --show, or --apply followed by a JSON object of changes.');
}
if (require.main === module) main().catch(error => {
  // The code lets the prompt hook tell a missing or moved setup from other failures.
  const code = typeof error.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(error.code) && !String(error.message).startsWith(error.code) ? `${error.code}: ` : '';
  process.stderr.write(`Fleet settings failed: ${code}${error.message}\n`);
  process.exitCode = 1;
});
module.exports = { main, SETTINGS };
