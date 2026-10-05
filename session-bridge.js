'use strict';
const path = require('node:path');
const { spawn } = require('node:child_process');
const { childEnvironment } = require('./runtime-config');
// Setup stays available after setup, so a person can move Fleet to another project.
const { runSetup, setupTool, statusTool, elsewhereGuidance, VERSION } = require('./setup-server');
// Fleet's settings, shown read-only; only the person changes them.
const { settingsTool, runSettings } = require('./settings-tool');
const { savedSetup } = require('./project-folder');

const sessionTool = Object.freeze({
  name: 'fleet_session_status', title: 'Fleet session subagents',
  description: 'Show the subagents in this session\'s Fleet tree: names, state, provider and model, including finished ones from earlier sessions in this project, which can still be resumed. Does not start subagents or change anything.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { title: 'Fleet session subagents', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
});
// Claude Code shows a tool's annotations.title; MCP's schema also has a top-level title.
const titled = tool => ({ ...tool, annotations: { title: tool.title, ...tool.annotations } });

function sessionView(trees, pid, projectTrees) {
  const own = trees.filter(tree => tree.live === true && tree.owner?.pid === pid);
  // Ambiguous or absent ownership never selects a different session.
  return projectTrees(own.length === 1 ? own : []);
}

const INIT_ID = 'fleet-bridge-initialize';

// The canonical engine remains an unchanged child. Only the plugin's public,
// read-only session and settings tools and the setup tool are added; every
// other engine request/response is forwarded while Fleet serves this session's
// project. After Fleet moves away, tool calls are refused here and never reach
// the engine, which would act on the new project. With `preInitialized`, the client already
// initialized with the setup server in this same session: the bridge
// initializes the engine itself, then tells the client its tool list changed.
async function serveSession(config, { input = process.stdin, output = process.stdout,
  launch = () => spawn(process.execPath, [path.join(__dirname, 'runtime-entry.js')],
    { env: childEnvironment(), stdio: ['pipe', 'pipe', 'inherit'] }), readTrees, projectTrees, setup = runSetup, settings = runSettings,
  preInitialized = null, initialBuffer = '', readSetup = () => savedSetup(config.stateRoot), watchMs = 2000 } = {}) {
  const state = path.join(config.stateRoot, 'workers');
  const loadTrees = readTrees || (() => require(path.join(config.engine, 'src/lib/openshell-tree-store')).listTrees(state));
  const project = projectTrees || require(path.join(config.engine, 'src/lib/fleet-tree-view')).projectTrees;
  // The project this session serves; a setup for it applies here at once.
  let startWorkspace = null;
  let startWorkers = false;
  try {
    const started = require(path.join(config.engine, 'src/lib/host-runtime')).readHostConfig(config.stateRoot, { setupKind: 'plugin' });
    startWorkspace = started.workspace;
    startWorkers = started.workers === true;
  } catch { startWorkspace = null; }
  // A session that started without subagents has no subagent tools to update.
  const appliesHere = (workspace, workers) => workspace === startWorkspace && (startWorkers || !workers);
  // Once Fleet moves to another project, this session must not act there: it
  // offers only the setup tools, with the same notice as any other project,
  // until Fleet moves back. Null while Fleet still serves this project.
  const movedTo = () => {
    if (!startWorkspace) return null;
    const now = readSetup();
    return now && now.workspace !== startWorkspace ? now.workspace : null;
  };
  const signature = () => { const now = readSetup(); return now ? JSON.stringify(now) : ''; };
  const child = launch();
  const lists = new Set();
  let ended = false;
  let deadline;
  let killDeadline;
  let removeBinding = () => {};
  const send = value => output.write(JSON.stringify(value) + '\n');
  const stop = () => {
    if (!ended) child.kill('SIGTERM');
    if (!killDeadline) killDeadline = setTimeout(() => child.kill('SIGKILL'), 12000);
  };
  const fail = () => { process.exitCode = 1; stop(); };
  function frames(stream, consume, initial = '') {
    let pending = initial;
    const data = chunk => {
      pending += chunk;
      // Bounded transport frames, including a client that never sends newline.
      if (pending.length > 2_000_000) { fail(); return; }
      let split;
      while ((split = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, split); pending = pending.slice(split + 1);
        if (!line.trim()) continue;
        if (line.length > 1_000_000) { fail(); return; }
        try { consume(JSON.parse(line)); } catch { fail(); return; }
      }
    };
    stream.setEncoding('utf8');
    stream.on('data', data);
    if (pending) data('');
    stream.resume();
    return () => stream.removeListener('data', data);
  }
  let initializing = Boolean(preInitialized);
  const queued = [];
  // The client sees the plugin's name and version, not the bundled engine's.
  const initializeIds = new Set();
  const forward = message => {
    if (message?.method === 'initialize' && Object.hasOwn(message, 'id') && initializeIds.size < 4) initializeIds.add(JSON.stringify(message.id));
    if (message?.method === 'tools/list' && Object.hasOwn(message, 'id')) {
      if (lists.size >= 64) { fail(); return; }
      lists.add(JSON.stringify(message.id));
    }
    child.stdin.write(JSON.stringify(message) + '\n');
  };
  if (preInitialized) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: INIT_ID, method: 'initialize', params: preInitialized }) + '\n');
  }
  // The client hears about tool changes only after it has initialized.
  let clientReady = false;
  let lastSetup = signature();
  const toolsChanged = () => { lastSetup = signature(); if (clientReady) send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }); };
  // A move, or a provider or model change the person typed, changes which
  // tools this session offers.
  const watch = setInterval(() => { if (signature() !== lastSetup) toolsChanged(); }, watchMs);
  watch.unref?.();
  const removeInput = frames(input, message => {
    if (message?.method === 'tools/list' && Object.hasOwn(message, 'id') && movedTo()) {
      send({ jsonrpc: '2.0', id: message.id, result: { tools: [statusTool, setupTool] } });
      return;
    }
    if (message?.method === 'tools/call' && message.params?.name === statusTool.name) {
      if (!Object.hasOwn(message, 'id')) return;
      const elsewhere = movedTo();
      send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text',
        text: elsewhere ? elsewhereGuidance(elsewhere) : `Fleet is set up for this project${startWorkspace ? `, ${startWorkspace}` : ''}.` }] } });
      return;
    }
    if (message?.method === 'tools/call' && message.params?.name !== setupTool.name && movedTo()) {
      if (!Object.hasOwn(message, 'id')) return;
      send({ jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: elsewhereGuidance(movedTo()) }] } });
      return;
    }
    if (message?.method === 'tools/call' && message.params?.name === setupTool.name) {
      if (!Object.hasOwn(message, 'id')) return;
      // Subagent providers and models apply here at once; another project needs its own session.
      const outcome = setup(message.params?.arguments?.workspace, { providers: message.params?.arguments?.providers,
        afterSetup: (workspace, done) => (appliesHere(workspace, done.workers)
          ? 'The new subagent settings apply in this session now.'
          : workspace === startWorkspace
            ? 'Subagents are now on. Start a new Claude Code session in this project to use them.'
            : 'Start a new Claude Code session in that project to use Fleet there. Fleet works in one project at a time, so this session no longer offers its tools; /tefleet setup here moves Fleet back.') });
      send({ jsonrpc: '2.0', id: message.id, result: outcome.result });
      // Here the subagent tools change; elsewhere this session now offers only setup.
      if (outcome.ok && (appliesHere(outcome.workspace, outcome.workers) || outcome.workspace !== startWorkspace)) toolsChanged();
      return;
    }
    if (message?.method === 'tools/call' && message.params?.name === settingsTool.name) {
      if (!Object.hasOwn(message, 'id')) return;
      send({ jsonrpc: '2.0', id: message.id, result: settings(message.params?.arguments || {}) });
      return;
    }
    if (message?.method === 'tools/call' && message.params?.name === sessionTool.name) {
      if (!Object.hasOwn(message, 'id')) return;
      let result;
      try {
        const view = sessionView(loadTrees(), child.pid, project);
        result = { content: [{ type: 'text', text: JSON.stringify(view) }], structuredContent: view };
      } catch {
        result = { isError: true, content: [{ type: 'text', text: 'This Fleet session tree is unavailable. Check /mcp.' }] };
      }
      send({ jsonrpc: '2.0', id: message.id, result });
      return;
    }
    if (initializing) { queued.push(message); return; }
    forward(message);
  }, initialBuffer);
  const removeOutput = frames(child.stdout, message => {
    if (initializing && message?.id === INIT_ID) {
      if (message.error) { fail(); return; }
      initializing = false;
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      for (const waiting of queued.splice(0)) forward(waiting);
      clientReady = true;
      send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
      return;
    }
    if (initializeIds.delete(JSON.stringify(message?.id)) && message.result?.serverInfo) {
      clientReady = true;
      message.result.serverInfo = { ...message.result.serverInfo, name: 'toolsenabled-fleet', version: VERSION };
      // The bridge tells the client when Fleet's tools change (setup and settings).
      const capabilities = message.result.capabilities || {};
      message.result.capabilities = { ...capabilities, tools: { ...(capabilities.tools || {}), listChanged: true } };
    }
    if (lists.delete(JSON.stringify(message?.id)) && Array.isArray(message.result?.tools)) {
      message.result.tools.push(...[sessionTool, setupTool, settingsTool].map(titled));
    }
    send(message);
  });
  const closeInput = () => {
    child.stdin.end();
    if (!deadline) deadline = setTimeout(stop, 12000);
  };
  input.once('end', closeInput);
  child.stdin.on('error', fail);
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(signal, stop);
  try {
    try { removeBinding = require('./session-binding').createBinding(config, child.pid); }
    catch { process.stderr.write('Fleet status binding unavailable; status will not select another session.\n'); }
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        if (code !== 0 || signal) process.exitCode = code || 1;
        resolve();
      });
    });
  } catch (error) {
    stop();
    throw error;
  } finally {
    ended = true;
    clearInterval(watch);
    clearTimeout(deadline);
    clearTimeout(killDeadline);
    removeInput(); removeOutput();
    input.removeListener('end', closeInput);
    input.pause();
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.removeListener(signal, stop);
    removeBinding();
  }
}
module.exports = { serveSession, sessionView, sessionTool };
