'use strict';

const path = require('node:path');
const { spawnHidden, waitForRootSpawn } = require('../proc/hidden-spawn');
const { killProcessTree } = require('../fleet-supervisor/kill-tree');
const { createStartupCleanup, cleanupFailure, validateCleanupTimeout, withOwnedStartupCleanup } = require('./codex-startup-cleanup');
const { createStartupControl } = require('./startup-control');
const { AcpAdapter } = require('./acp-adapter');
const { acpProfile } = require('./acp-profiles');
const launchPolicy = require('../supervision/launch-environment');

const STDERR_LIMIT = 64 * 1024;
function refusal(code, message) { return Object.assign(new Error(message), { code }); }

// The environment a CLI process really gets: the person's own, scrubbed, and then the variables the
// launch supplies for it. The launcher inspects the CLI with exactly this environment, so what is
// inspected is what runs.
function acpChildEnvironment({ env = process.env, profileEnv = {}, workspace = null } = {}) {
  return { ...launchPolicy.confinedAgentCliEnvironment(env, { workspace }), ...profileEnv };
}

function createAcpProcessTransport({ command, args, cwd, env, launchVariables, rootLaunch } = {}) {
  if (typeof command !== 'string' || !path.isAbsolute(command)
      || !Array.isArray(args) || args.some(arg => typeof arg !== 'string')) {
    throw refusal('ACP_LAUNCH_INVALID', 'An ACP worker requires a pinned absolute CLI and string arguments.');
  }
  const child = spawnHidden(command, args, { cwd, env, ...(launchVariables ? { launchVariables } : {}), stdio: ['pipe', 'pipe', 'pipe'],
    containProcessTree: true, ...(rootLaunch ? { rootLaunch } : {}) });
  const rootReady = rootLaunch ? waitForRootSpawn(child) : null;
  rootReady?.catch(() => {});
  // The CLI's own process: under the process supervisor it is the root the supervisor reports, not the supervisor.
  const rootPid = child.jobReady && typeof child.jobReady.then === 'function'
    ? child.jobReady.then(info => info.rootPid) : Promise.resolve(child.pid);
  rootPid.catch(() => {});
  const cleanup = createStartupCleanup(child);
  const listeners = new Set();
  let stderr = '';
  let exit = null;
  let paused = false;
  let delivered = false;
  let closing = false;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    for (const listener of listeners) {
      try { listener(chunk); } catch { /* A transport observer cannot disrupt process custody. */ }
    }
  });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-STDERR_LIMIT); });
  const deliverExit = () => {
    if (!exit || paused || delivered) return;
    delivered = true;
    for (const listener of listeners) {
      try { listener(null, exit); } catch { /* Exit delivery is best effort. */ }
    }
  };
  const noteExit = ({ code = null, signal = null, error = null } = {}) => {
    if (exit) return;
    exit = Object.freeze({ code, signal, error, stderr });
    deliverExit();
  };
  child.once('error', error => noteExit({ error }));
  child.once('exit', (code, signal) => noteExit({ code, signal }));
  child.stdin.on('error', error => noteExit({ error }));
  return {
    rootReady,
    rootPid: () => rootPid,
    write(line) {
      if (typeof line !== 'string' || closing || exit || !child.stdin.writable) {
        throw refusal('ACP_PIPE_CLOSED', 'The ACP worker pipe is unavailable.');
      }
      child.stdin.write(line);
    },
    onData(listener) {
      listeners.add(listener);
      if (exit) queueMicrotask(() => { if (listeners.has(listener)) listener(null, exit); });
      return () => listeners.delete(listener);
    },
    pause() { paused = true; child.stdout.pause(); },
    resume() { paused = false; child.stdout.resume(); if (exit) queueMicrotask(deliverExit); },
    close() {
      if (closing) return;
      closing = true;
      if (paused) { paused = false; child.stdout.resume(); }
      if (typeof child.terminateJob === 'function') {
        child.terminateJob().catch(() => {
          if (typeof child.terminateRetainedWrapper === 'function') {
            child.terminateRetainedWrapper().catch(() => {});
          }
        });
      }
      else if (child.exitCode === null && child.signalCode === null) killProcessTree(child);
      else child.stdin.destroy();
    },
    closeForStartupFailure(timeoutMs) { closing = true; return cleanup.confirm(timeoutMs); },
    closeForProtocolFailure() { closing = true; return cleanup.confirm(5_000); }
  };
}

function validatePlan({ provider, profile, command, args, cwd, mcpServers }) {
  if (!profile || profile !== acpProfile(provider) || typeof command !== 'string' || !path.isAbsolute(command)
      || !Array.isArray(args) || args.some(arg => typeof arg !== 'string')
      || typeof cwd !== 'string' || !path.isAbsolute(cwd) || !Array.isArray(mcpServers)) {
    throw refusal('ACP_PLAN_REQUIRED', 'An ACP worker requires a registered profile and a prepared private launch.');
  }
}

async function openAcpSession({ provider, profile = acpProfile(provider), command, args, cwd,
  env, profileEnv = {}, mcpServers = [], clientInfo, onEvent, rootLaunch, signal = null,
  startupTimeoutMs = 60_000, cleanupTimeoutMs = 5_000, threadId = null,
  model = null, transportFactory = createAcpProcessTransport } = {}) {
  validatePlan({ provider, profile, command, args, cwd, mcpServers });
  validateCleanupTimeout(cleanupTimeoutMs);
  if (model !== null && (typeof model !== 'string' || model.length === 0 || model.length > 512
      || /[\x00-\x1f\x7f]/.test(model))) {
    throw refusal('ACP_MODEL_UNAVAILABLE', 'Choose an exact model advertised by this CLI.');
  }
  const startup = createStartupControl({ signal, timeoutMs: startupTimeoutMs,
    label: `${provider} ACP startup`, codePrefix: 'ACP_START' });
  let transport;
  let adapter;
  try {
    const childEnv = acpChildEnvironment({ env: env || process.env, profileEnv, workspace: cwd });
    transport = transportFactory({ command, args, cwd, env: childEnv, launchVariables: profileEnv, rootLaunch });
    adapter = new AcpAdapter({ transport, clientInfo, defaultCwd: cwd, mcpServers });
    adapter.modelProvider = provider;
    if (onEvent) adapter.onEvent(onEvent);
    if (rootLaunch) await startup.wait(() => transport.rootReady);
    await startup.wait(() => adapter.initialize());
    const advertised = adapter.getAuthMethods() || [];
    const method = profile.authMethodIds.find(id => advertised.some(entry => entry.id === id));
    if (method) await startup.wait(() => adapter.authenticate(method));
    const started = await startup.wait(() => threadId === null ? adapter.startThread() : adapter.resumeThread(threadId));
    if (model) await startup.wait(() => adapter.selectModel(started.threadId, model));
    const pid = typeof transport.rootPid === 'function' ? await transport.rootPid().catch(() => null) : null;
    return { adapter, threadId: started.threadId, pid, ...(model ? { model: `${provider}/${model}` } : {}),
      close() { try { adapter.close(); } finally { transport.close(); } } };
  } catch (error) {
    const auth = error?.code === 'ACP_AUTH_REQUIRED'
      ? refusal('ACP_AUTH_REQUIRED', `${profile.id} requires its own saved login. Run "${profile.loginCommand}" in a terminal, then retry.`)
      : error;
    const nestedCleanup = typeof error?.retryCleanup === 'function' ? error.retryCleanup.bind(error) : null;
    let confirmed = false;
    const retryCleanup = async () => {
      if (confirmed) return;
      const errors = [];
      if (nestedCleanup) try { await nestedCleanup(); } catch (failure) { errors.push(failure); }
      try { adapter?.close(); } catch (failure) { errors.push(failure); }
      try { await transport?.closeForStartupFailure(cleanupTimeoutMs); } catch (failure) { errors.push(failure); }
      if (errors.length) throw cleanupFailure('ACP_START_CLEANUP_UNPROVEN', auth, errors, retryCleanup);
      confirmed = true;
    };
    await retryCleanup();
    throw withOwnedStartupCleanup(auth, retryCleanup);
  } finally { startup.dispose(); }
}
function startAcpSession(options) { return openAcpSession(options); }
function resumeAcpSession(options) {
  if (typeof options?.threadId !== 'string' || !options.threadId) {
    return Promise.reject(refusal('ACP_RESUME_ID_REQUIRED', 'Choose the ACP conversation to resume.'));
  }
  return openAcpSession(options);
}
module.exports = { createAcpProcessTransport, startAcpSession, resumeAcpSession, acpChildEnvironment };
