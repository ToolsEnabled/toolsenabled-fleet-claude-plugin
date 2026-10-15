'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const path = require('node:path');
const fs = require('node:fs');
const { coreConfig, main, statusServer } = require('./codex-entry');
const fixture = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'fleet-codex-binding-'));
const workspace = path.join(fixture, 'project');
const stateRoot = path.join(fixture, 'state');
for (const folder of [workspace, stateRoot, path.join(workspace, 'child'), path.join(fixture, 'unrelated')]) fs.mkdirSync(folder, { recursive: true });
const alias = path.join(fixture, 'same-project-alias'); fs.symlinkSync(workspace, alias, 'dir');
const env = { TOOLSENABLED_FLEET_CODEX_STATE_ROOT: stateRoot, FLEET_CODEX_WORKSPACE: workspace };

test('an unconfigured connection never reads or initializes Fleet state', async () => {
  let shown = 0;
  await main({ env: {}, readConfig: () => { throw Error('must not read'); }, serve: () => { throw Error('must not serve'); }, status: () => shown++ });
  assert.equal(shown, 1);
});
test('the canonical core is served as codex only when workers are explicitly disabled', async () => {
  const config = { workers: false, workspace, stateRoot };
  let actual;
  await main({ env, readConfig: (root, options) => { assert.equal(root, stateRoot); assert.equal(options.setupKind, 'plugin'); return config; }, serve: (saved, actor) => { actual = { saved, actor }; } });
  assert.deepEqual(actual, { saved: config, actor: { actor: 'codex' } });
});
test('workers, missing worker state, project mismatch and partial configuration refuse before serving', async () => {
  for (const workers of [true, undefined, null, 0, 'false']) {
    let served = false;
    await assert.rejects(main({ env, readConfig: () => ({ workers, workspace }), serve: () => { served = true; } }), /FLEET_CODEX_WORKERS_REFUSED/);
    assert.equal(served, false);
  }
  assert.throws(() => coreConfig({ ...env, FLEET_CODEX_WORKSPACE: path.join(fixture, 'unrelated') }, () => ({ workers: false, workspace })), /WORKSPACE_REFUSED/);
  for (const partial of [{ FLEET_CODEX_WORKSPACE: workspace }, { ...env, TOOLSENABLED_FLEET_CODEX_STATE_ROOT: 'relative' }])
    assert.throws(() => coreConfig(partial, () => { throw Error('must not read'); }), /CONFIG_REQUIRED/);
});
test('the status wire initializes and refuses hidden setup, worker and generic execution calls', async () => {
  const input = new PassThrough(), output = new PassThrough();
  let text = ''; output.on('data', chunk => { text += chunk; });
  const closed = statusServer(input, output);
  const requests = [
    { method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    { method: 'tools/list' },
    { method: 'tools/call', params: { name: 'fleet_codex_status', arguments: {} } },
    ...['fleet_setup', 'agent.spawn', 'execute', 'fleet_codex_status'].map(name => ({ method: 'tools/call', params: { name, arguments: { workers: true } } })),
  ];
  requests.forEach((r,id) => input.write(JSON.stringify({ jsonrpc:'2.0', id, ...r }) + '\n'));
  input.end(); await closed;
  const replies = text.trim().split('\n').map(JSON.parse);
  assert.equal(replies[0].result.serverInfo.name, 'toolsenabled-fleet-codex-core');
  assert.deepEqual(replies[1].result.tools.map(x => x.name), ['fleet_codex_status']);
  assert.equal(replies[2].result.isError, undefined);
  for (const reply of replies.slice(3)) assert.equal(reply.result.isError, true);
});


test('requested child, parent and unrelated roots refuse before serve; only exact physical project or its alias is admitted', async () => {
  const saved = { workers: false, workspace, stateRoot };
  for (const selected of [path.join(workspace, 'child'), fixture, path.join(fixture, 'unrelated')]) {
    let served = false;
    await assert.rejects(main({ env: { ...env, FLEET_CODEX_WORKSPACE: selected }, readConfig: () => saved,
      serve: () => { served = true; } }), /FLEET_CODEX_WORKSPACE_REFUSED/);
    assert.equal(served, false, selected);
  }
  for (const selected of [workspace, alias]) {
    let actual;
    await main({ env: { ...env, FLEET_CODEX_WORKSPACE: selected }, readConfig: () => saved,
      serve: config => { actual = config; } });
    assert.equal(actual, saved);
    assert.equal(fs.realpathSync(selected), fs.realpathSync(actual.workspace));
  }
});
