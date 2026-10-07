'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { launcherEnvironment } = require('./runtime-config');
const VERSION = '1.11.0';
const PROTOCOLS = Object.freeze(['2024-11-05', '2025-03-26', '2025-06-18']);
const guidance = 'Fleet is installed but not set up for this project. Type /tefleet setup (or ask Claude to set up Fleet) and approve the setup tool. Fleet\'s tools then appear in this session.';
// Fleet works in one project at a time; from any other project it offers to move.
function elsewhereGuidance(workspace) {
  return `Fleet is set up for another project, ${workspace}, and works in one project at a time, so its tools are not offered here. `
    + 'To use Fleet in this project instead, type /tefleet setup and approve the setup tool; Fleet\'s tools then appear in this session. '
    + 'Your ledger and memory come along.';
}

const statusTool = Object.freeze({
  name: 'fleet_setup_status', title: 'Fleet setup status',
  description: 'Report that Fleet is not set up for this project yet and how to set it up. Changes nothing.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
});
const setupTool = Object.freeze({
  name: 'fleet_setup', title: 'Set up Fleet for a project',
  description: 'Set up Fleet for this session\'s project folder when the person asks for it. Creates Fleet\'s private state folder (~/.toolsenabled-fleet-plugin by default) at the Standard permission level and records the project folder. Accepts only the folder this session works in, or a folder above it inside the home folder. Refuses a folder that does not exist, a version-control, CI, git-hook, package, Python environment or tool settings folder such as .git, .github, .husky, node_modules, .venv, .claude, .codex, .opencode or .vscode or anything inside one, a dot folder of the home folder, ~/bin and any folder on the person\'s PATH or inside one. Turns on subagents for each installed agent CLI that passes its check: its own sign-in status command or, for a CLI that speaks the Agent Client Protocol, that protocol\'s initialize request. Does not change Claude Code settings, other projects, or any sign-in.',
  inputSchema: {
    type: 'object',
    properties: {
      workspace: { type: 'string', description: 'Absolute path of the project folder to set up: the current working directory, or a folder above it inside the home folder.' },
      providers: { type: 'array', items: { type: 'string', enum: Object.keys(require('./setup-entry').SUBAGENT_CLIS) }, minItems: 1, uniqueItems: true,
        description: 'Only when the person names which agent CLIs subagents may use. Omit it to use every installed agent CLI that is signed in.' },
    },
    required: ['workspace'], additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
});

function text(value, isError = false) {
  return { ...(isError ? { isError: true } : {}), content: [{ type: 'text', text: value }] };
}

// Runs setup-entry.js in its own process; it and the setup engine validate the
// folder. Only this session's project folder, or a folder above it inside the
// home folder, is accepted, whatever folder Claude names; setup-entry.js checks
// the same again. `afterSetup` is the sentence that tells the person what
// happens next.
function runSetup(workspace, { providers, run = spawnSync, env = process.env,
  afterSetup = 'Fleet\'s tools are now available in this session.' } = {}) {
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) {
    return { ok: false, result: text('Give the absolute path of the project folder to set up.', true) };
  }
  if (providers !== undefined && (!Array.isArray(providers) || !providers.length
      || !providers.every(name => typeof name === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(name)))) {
    return { ok: false, result: text('List the agent CLIs for subagents by name (claude, codex or opencode), or leave providers out.', true) };
  }
  const refusal = require('./setup-entry').setupRefusal(workspace, { env, cwd: process.cwd() });
  if (refusal) return { ok: false, result: text(`Fleet setup did not finish: ${refusal}`, true) };
  const result = run(process.execPath, [path.join(__dirname, 'setup-entry.js'), '--setup', workspace,
    ...(providers ? ['--providers', providers.join(',')] : [])],
    { env: launcherEnvironment(env), encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 });
  if (result.status !== 0) {
    const detail = String(result.stderr || result.error?.message || 'Setup failed.')
      .replace(/^Fleet setup failed:\s*/, '').replace(/^[A-Z][A-Z0-9_]+:\s*/, '').trim();
    return { ok: false, result: text(`Fleet setup did not finish: ${detail}`, true) };
  }
  let done;
  try { done = JSON.parse(result.stdout.slice(result.stdout.indexOf('{'))); }
  catch { return { ok: false, result: text('Fleet setup returned an unexpected result. Run setup again.', true) }; }
  const lines = [`Fleet is set up for ${done.workspace} at the Standard permission level.`,
    done.workers ? `Subagents are on and can use: ${(done.providers || []).join(', ')}.` : 'Subagents are off.'];
  if (done.note) lines.push(done.note);
  lines.push(typeof afterSetup === 'function' ? afterSetup(done.workspace, done) : afterSetup);
  return { ok: true, workspace: done.workspace, workers: done.workers === true, result: text(lines.join('\n')) };
}

// Binds the saved setup to this plugin version, keeping the person's choices.
function runRebind({ run = spawnSync, env = process.env } = {}) {
  const result = run(process.execPath, [path.join(__dirname, 'setup-entry.js'), '--rebind'],
    { env: launcherEnvironment(env), encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 });
  return result.status === 0;
}

// Newline-delimited JSON frames, keeping any partial line so the caller can
// hand the rest of the stream to the full server without losing bytes.
function frameReader(stream, consume) {
  let pending = '';
  const data = chunk => {
    pending += chunk;
    let split;
    while ((split = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, split);
      pending = pending.slice(split + 1);
      if (line.trim() && consume(line) === 'stop') return;
    }
  };
  stream.setEncoding('utf8');
  stream.on('data', data);
  // Pause before detaching so no bytes are emitted with nobody listening; the
  // next reader resumes the stream.
  return { stop: () => { stream.pause(); stream.removeListener('data', data); const rest = pending; pending = ''; return rest; } };
}

// Serves the two setup tools until Fleet is set up, then resolves with the
// client's initialize parameters and any unread input so the caller can start
// the full server in the same session. No engine, state or model calls until
// the person asks for setup. Resolves null if the client disconnects first.
function waitForSetup(input = process.stdin, output = process.stdout,
  { setup = runSetup, isReady = () => false, pollMs = 2000, notice = guidance } = {}) {
  const send = value => output.write(JSON.stringify(value) + '\n');
  let initParams = null;
  let settled = false;
  return new Promise(resolve => {
    let reader;
    const finish = handoff => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      input.removeListener('end', ended);
      const rest = reader.stop();
      resolve(handoff ? { ...handoff, remainder: rest } : null);
    };
    const ready = () => { if (initParams) finish({ initParams }); };
    const ended = () => finish(null);
    reader = frameReader(input, line => {
      let message;
      try { message = JSON.parse(line); }
      catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON.' } }); return; }
      if (!message || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
        send({ jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Invalid request.' } }); return;
      }
      if (!Object.hasOwn(message, 'id')) return;
      const reply = { jsonrpc: '2.0', id: message.id };
      let switchNow = false;
      if (message.method === 'initialize') {
        initParams = message.params && typeof message.params === 'object' ? message.params : {};
        const requested = initParams.protocolVersion;
        reply.result = { protocolVersion: PROTOCOLS.includes(requested) ? requested : PROTOCOLS[0],
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'toolsenabled-fleet', version: VERSION }, instructions: notice };
      } else if (message.method === 'tools/list') reply.result = { tools: [statusTool, setupTool] };
      else if (message.method === 'tools/call') {
        const name = message.params?.name;
        if (name === statusTool.name) reply.result = text(notice);
        else if (name === setupTool.name) {
          // Switch only when the project now set up covers this session's folder.
          const covers = () => { try { return isReady() === true; } catch { return false; } };
          const outcome = setup(message.params?.arguments?.workspace, { providers: message.params?.arguments?.providers,
            afterSetup: () => (covers() ? 'Fleet\'s tools are now available in this session.'
              : 'This session works in a different folder, so Fleet\'s tools are not offered here. Start Claude Code in the project folder above to use them.') });
          reply.result = outcome.result;
          switchNow = outcome.ok === true && covers();
        } else reply.result = text(notice, true);
      } else if (message.method === 'ping') reply.result = {};
      else reply.error = { code: -32601, message: notice };
      send(reply);
      if (switchNow && initParams) { finish({ initParams }); return 'stop'; }
    });
    input.once('end', ended);
    // Setup can also finish elsewhere: /fleet setup, another session, or a person's terminal.
    const poll = setInterval(() => { try { if (isReady()) ready(); } catch { /* not ready */ } }, pollMs);
    poll.unref?.();
  });
}
module.exports = { waitForSetup, runSetup, runRebind, setupTool, statusTool, frameReader, guidance, elsewhereGuidance, VERSION, PROTOCOLS };
