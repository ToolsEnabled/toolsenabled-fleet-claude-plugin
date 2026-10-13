'use strict';
const path = require('node:path');
const { spawn } = require('node:child_process');
const { launcherEnvironment } = require('./runtime-config');
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

// The largest request the engine accepts (MAX_MESSAGE_BYTES in its
// src/mcp-server.js). The bridge refuses a larger one itself, naming its id,
// because the engine can only answer it with id null, which leaves the call
// waiting.
const REQUEST_BYTES = 1024 * 1024;
// A request line is held whole up to this many characters, so its id can be
// read; past it only the line's ends are kept.
const REQUEST_HELD = 8 * 1024 * 1024;
// The longest engine answer passed on. One host.read_file of the 2 MiB file
// limit can be about 13 characters a byte: the file is in the answer twice
// (JSON text and structuredContent), and a control character is escaped once
// as \u0001 and again inside the text. This is more than twice that.
const RESPONSE_CHARS = 64 * 1024 * 1024;
// How much of each end of a too-long line is kept to find its id.
const EDGE = 1024;
const JSON_ID = String.raw`(-?(?:0|[1-9]\d*)|"(?:[^"\\]|\\.){0,512}")`;
// The id of a message whose own text begins with it, as the engine writes
// every answer: {"jsonrpc":"2.0","id":7,...
const LEADING_ID = new RegExp(String.raw`^\s*\{\s*(?:"jsonrpc"\s*:\s*"2\.0"\s*,\s*)?"id"\s*:\s*${JSON_ID}\s*[,}]`);
// The id of a message that ends with it, as Claude Code writes requests:
// {"method":...,"params":{...},"jsonrpc":"2.0","id":7}
const TRAILING_ID = new RegExp(String.raw`[{,]\s*"id"\s*:\s*${JSON_ID}\s*\}\s*$`);
function lineId(pattern, text) {
  const found = pattern.exec(text);
  if (!found) return undefined;
  try { return JSON.parse(found[1]); } catch { return undefined; }
}

// The canonical engine remains an unchanged child. Only the plugin's public,
// read-only session and settings tools and the setup tool are added; every
// other engine request/response is forwarded while Fleet serves this session's
// project. After Fleet moves away, tool calls are refused here and never reach
// the engine, which would act on the new project. With `preInitialized`, the client already
// initialized with the setup server in this same session: the bridge
// initializes the engine itself, then tells the client its tool list changed.
async function serveSession(config, { input = process.stdin, output = process.stdout,
  launch = () => spawn(process.execPath, [path.join(__dirname, 'runtime-entry.js')],
    { env: launcherEnvironment(), stdio: ['pipe', 'pipe', 'inherit'] }), readTrees, projectTrees, setup = runSetup, settings = runSettings,
  preInitialized = null, initialBuffer = '', readSetup = () => savedSetup(config.stateRoot), watchMs = 2000,
  requestBytes = REQUEST_BYTES, requestHeld = REQUEST_HELD, responseChars = RESPONSE_CHARS } = {}) {
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
  // One JSON-RPC message per line, in each direction. A line longer than
  // `limit` characters is never held whole: its first and last characters,
  // which name the request it belongs to, go to `oversized`, and the rest is
  // dropped. Only a line that is not JSON at all stops Fleet.
  function frames(stream, consume, { initial = '', limit, oversized }) {
    let parts = [];
    let held = 0;
    let over = null;
    let broken = false;
    const data = chunk => {
      let at = 0;
      while (!broken) {
        const split = chunk.indexOf('\n', at);
        const piece = split === -1 ? chunk.slice(at) : chunk.slice(at, split);
        if (over) {
          over.length += piece.length;
          over.tail = (over.tail + piece).slice(-EDGE);
        } else if (held + piece.length > limit) {
          const start = parts.join('') + piece;
          parts = []; held = 0;
          over = { head: start.slice(0, EDGE), tail: start.slice(-EDGE), length: start.length };
        } else if (piece) {
          parts.push(piece); held += piece.length;
        }
        if (split === -1) return;
        at = split + 1;
        if (over) { const line = over; over = null; oversized(line); continue; }
        const line = parts.join('');
        parts = []; held = 0;
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { broken = true; fail(); return; }
        try { consume(message, line); } catch { broken = true; fail(); return; }
      }
    };
    stream.setEncoding('utf8');
    stream.on('data', data);
    if (initial) data(initial);
    stream.resume();
    return () => stream.removeListener('data', data);
  }
  // A request too large for the engine is answered here, by its id, and never
  // forwarded; Fleet and every subagent keep running.
  const refuseRequest = (id, size) => {
    if (id === undefined) {
      process.stderr.write(`Fleet dropped a request of ${size} that has no id it could read; it is over the ${requestBytes}-byte limit.\n`);
      return;
    }
    send({ jsonrpc: '2.0', id, error: { code: -32600, message: `This request is ${size}, over Fleet's ${requestBytes}-byte limit for one request, so Fleet did not run it and nothing changed. Send less at once: write a large file in parts, the first with host.write_file and the rest with host.patch_file.` } });
  };
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
  const removeInput = frames(input, (message, line) => {
    const bytes = Buffer.byteLength(line, 'utf8');
    if (bytes > requestBytes) {
      // A response to a request of the engine's has nobody here to answer.
      if (message && typeof message === 'object' && typeof message.method === 'string' && Object.hasOwn(message, 'id')) refuseRequest(message.id, `${bytes} bytes`);
      else process.stderr.write(`Fleet dropped a ${bytes}-byte message from Claude Code; it is over the ${requestBytes}-byte limit.\n`);
      return;
    }
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
  }, { initial: initialBuffer, limit: requestHeld,
    oversized: line => refuseRequest(lineId(TRAILING_ID, line.tail) ?? lineId(LEADING_ID, line.head), `over ${line.length} characters`) });
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
  }, { limit: responseChars, oversized: line => {
    // An answer too long to pass on fails only the request it answers.
    const id = lineId(LEADING_ID, line.head);
    if (id === undefined) {
      process.stderr.write(`Fleet dropped a ${line.length}-character message from its engine; it is over the ${responseChars}-character limit.\n`);
      return;
    }
    if (initializing && id === INIT_ID) { fail(); return; }
    initializeIds.delete(JSON.stringify(id));
    lists.delete(JSON.stringify(id));
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: `Fleet's answer to this request was ${line.length} characters, over the ${responseChars} this connection passes on, so it was not delivered. Fleet and its subagents keep running, and anything the request changed stands. Ask for less at once: read part of a large file with host.read_file's startByte and endByte.` } });
  } });
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
module.exports = { serveSession, sessionView, sessionTool, REQUEST_BYTES, RESPONSE_CHARS };
