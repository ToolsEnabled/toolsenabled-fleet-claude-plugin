#!/usr/bin/env node
'use strict';
// Codex has no equivalent to this package's Claude typed-command hook.
// Only a separately configured, workers-off core may be served here.
const path = require('node:path');
const { createInterface } = require('node:readline');
const { inside } = require('./project-folder');
const VERSION = require('./.claude-plugin/plugin.json').version;
const INSTRUCTIONS = 'ToolsEnabled Fleet Codex core: workers, Claude typed commands, lifecycle hooks and panes are unavailable. Configure a separate workers-off state root with the documented terminal command. No setup, settings change or worker start is offered through this status connection.';

function coreConfig(env, readConfig) {
  const stateRoot = env.TOOLSENABLED_FLEET_CODEX_STATE_ROOT;
  const workspace = env.FLEET_CODEX_WORKSPACE;
  if (!stateRoot && !workspace) return null;
  if (!stateRoot || !workspace || !path.isAbsolute(stateRoot) || !path.isAbsolute(workspace))
    throw new Error('FLEET_CODEX_CONFIG_REQUIRED: set both absolute TOOLSENABLED_FLEET_CODEX_STATE_ROOT and FLEET_CODEX_WORKSPACE.');
  const config = readConfig(stateRoot, { setupKind: 'plugin' });
  if (config.workers !== false) throw new Error('FLEET_CODEX_WORKERS_REFUSED: this Codex package requires a separate workers-off setup.');
  if (!inside(workspace, config.workspace)) throw new Error('FLEET_CODEX_WORKSPACE_REFUSED: the requested workspace is outside the configured project.');
  return config;
}

function statusServer(input = process.stdin, output = process.stdout) {
  const tool = { name: 'fleet_codex_status', description: 'Show the Fleet Codex core installation limits without reading or changing Fleet state.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } };
  const lines = createInterface({ input, crlfDelay: Infinity });
  const send = message => output.write(JSON.stringify(message) + '\n');
  lines.on('line', line => {
    let request;
    try { request = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON.' } }); return; }
    if (!request || Array.isArray(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      send({ jsonrpc: '2.0', id: request?.id ?? null, error: { code: -32600, message: 'Invalid request.' } }); return;
    }
    if (!Object.hasOwn(request, 'id')) return;
    const reply = { jsonrpc: '2.0', id: request.id };
    if (request.method === 'initialize') reply.result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'toolsenabled-fleet-codex-core', version: VERSION }, instructions: INSTRUCTIONS };
    else if (request.method === 'ping') reply.result = {};
    else if (request.method === 'tools/list') reply.result = { tools: [tool] };
    else if (request.method === 'tools/call') {
      const args = request.params?.arguments ?? {};
      const allowed = request.params?.name === tool.name && args && typeof args === 'object' && !Array.isArray(args) && Object.keys(args).length === 0;
      reply.result = { ...(allowed ? {} : { isError: true }), content: [{ type: 'text', text: allowed ? INSTRUCTIONS : 'FLEET_CODEX_ACTION_REFUSED: only the read-only fleet_codex_status tool with empty arguments is available. Nothing changed.' }] };
    } else reply.error = { code: -32601, message: 'Method unavailable in the Fleet status connection.' };
    send(reply);
  });
  return new Promise(resolve => lines.once('close', resolve));
}

async function main({ env = process.env, readConfig, serve, status = statusServer } = {}) {
  const runtime = require('./runtime/engine/src/lib/host-runtime');
  const config = coreConfig(env, readConfig || runtime.readHostConfig);
  if (!config) return status();
  require('./node-guard').assertSafeNode({ env, workspaces: [config.workspace] });
  // All enforcement is in the canonical host server; no Claude bridge or hook
  // is loaded and the actor is the CLI actually making this connection.
  return (serve || runtime.serveHost)(config, { actor: 'codex' });
}
if (require.main === module) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
module.exports = { coreConfig, statusServer, main, INSTRUCTIONS };
