'use strict';

/* THE ONE PLACE A LONG-LIVED CHILD PROCESS IS STARTED, so the spawn rules are
 * a property of the API rather than a habit at 40 call sites.
 *
 * THE RULES THIS MODULE ENFORCES, none of which a caller may opt out of:
 *
 *   1. `windowsHide` is always true. A caller that passes `windowsHide: false`
 *      is refused rather than obeyed.
 *   2. `shell: true` is refused. It turns an argv array into a string a shell
 *      re-parses, so this module could not state what it started.
 *   3. With TOOLSENABLED_REFUSE_PROVIDER_SPAWN set in THIS process, every spawn
 *      is refused before anything is started. See below for why the switch is
 *      read where it is.
 *
 * WHY A NO-PROVIDER SWITCH LIVES HERE, AND WHY IT READS process.env.
 *
 * A fence built from a child environment with no PATH and no credentials
 * cannot stop a provider spawn on its own: agent-engine/codex-process.js falls
 * back to the ambient environment whenever a caller does not thread one
 * through (`(env && env.APPDATA) || process.env.APPDATA`, and the same shape
 * for PATH and PATHEXT), so a real provider CLI can still be found.
 *
 * That bypass acts on the CHILD environment being constructed. It cannot
 * touch THIS process's own process.env. That is the whole reason the switch is
 * read from process.env at call time and never from `options.env`: an option is
 * exactly what a caller can omit, which is how the codex fallbacks leak in the
 * first place. A gate that consulted the caller's environment would be
 * bypassable by the same mistake it exists to catch.
 *
 * It is read per call rather than latched at module load so a test can prove
 * both states in one process. That is not a weakness: in-process code that
 * wanted to spawn without the gate would simply call child_process.spawn
 * directly, so the boundary this defends is the caller-supplied environment,
 * not in-process good faith.
 *
 * ONLY '1' OR 'true' REFUSES. An unset, empty, or unrecognised value allows the
 * spawn, so an accidentally inherited empty variable cannot silently stop a
 * paying customer from starting an agent. A test that wants the fence sets it
 * explicitly.
 *
 * The provider processes all come through here -- codex-process.js and
 * claude-cli-process.js are the requirers in src/ -- which is what makes this
 * one function the single gate every provider spawn passes through.
 */

const path = require('node:path');
const { spawn: nodeSpawn } = require('node:child_process');
const {
  agentCliEnvironment,
} = require('../supervision/launch-environment');
const { spawnLinuxOwned } = require('../linux-process-control');

const PROVIDER_SPAWN_REFUSAL_VARIABLE = 'TOOLSENABLED_REFUSE_PROVIDER_SPAWN';

/* Read from THIS process's environment, never from a caller's. See the module
   header for the bypass that makes that distinction the whole point. Exported so a caller can ask the same question the gate asks, and so a
   test can pin the value semantics without spawning. */
function providerSpawnRefused(environment = process.env) {
  const value = environment ? environment[PROVIDER_SPAWN_REFUSAL_VARIABLE] : undefined;
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
}

class HiddenSpawnError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HiddenSpawnError';
    this.code = code;
  }
}

/**
 * Decide what will actually be executed, without executing it.
 *
 * Returns `{ command, args, env, resolved }`. Nothing is rewritten on Linux, so
 * `resolved` is null and `env` (the ADDITIONS a resolution would require) is
 * empty. Exported separately from spawnHidden so a precondition check can ask
 * "what would this start?" and get the SAME answer the spawn will use.
 */
function resolveHiddenInvocation(command, args = []) {
  if (typeof command !== 'string' || command.length === 0) {
    throw new HiddenSpawnError('HIDDEN_SPAWN_COMMAND_INVALID', 'A command must be a non-empty string');
  }
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) {
    throw new HiddenSpawnError('HIDDEN_SPAWN_ARGS_INVALID', 'Arguments must be an array of strings');
  }
  return { command, args, env: {}, resolved: null };
}

/**
 * Start a child process that can never put a console window on the screen.
 *
 * Same shape as child_process.spawn(command, args, options), minus the options
 * that reintroduce the defect. Returns the ChildProcess.
 */
function spawnHidden(command, args = [], options = {}) {
  /* FIRST, ahead of every other check. A refusal must not depend on the options
     being well-formed, and nothing -- no resolution, no environment scrub, no
     filesystem probe -- should happen on a process that has been told not to
     start providers. */
  if (providerSpawnRefused()) {
    throw new HiddenSpawnError(
      'HIDDEN_SPAWN_PROVIDER_REFUSED',
      `Refusing to start ${typeof command === 'string' && command ? command : 'a provider process'}: `
        + `${PROVIDER_SPAWN_REFUSAL_VARIABLE} is set on this process, so no paid provider process was started.`,
    );
  }
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new HiddenSpawnError('HIDDEN_SPAWN_OPTIONS_INVALID', 'Options must be a plain object');
  }
  if (options.shell) {
    throw new HiddenSpawnError(
      'HIDDEN_SPAWN_SHELL_REFUSED',
      'spawnHidden never runs a command through a shell; pass an executable and an argv array',
    );
  }
  if (Object.hasOwn(options, 'windowsHide') && options.windowsHide === false) {
    throw new HiddenSpawnError(
      'HIDDEN_SPAWN_VISIBLE_REFUSED',
      'spawnHidden cannot be asked to show a console window (STANDING-ORDERS.md LOCAL-WORK rule 3)',
    );
  }
  if (Object.hasOwn(options, 'containProcessTree') && typeof options.containProcessTree !== 'boolean') {
    throw new HiddenSpawnError(
      'HIDDEN_SPAWN_CONTAINMENT_INVALID',
      'spawnHidden containProcessTree must be true or false',
    );
  }
  /* A PROCESS GROUP OF ITS OWN, for a system whose seccomp profile answers
     pidfd_open with ENOSYS, where the Linux custodian below cannot start. The child becomes
     the leader of a new session and process group, and gains a terminateJob()
     that ends that group and every process below it from /proc
     (src/lib/proc/process-group.js). Linux only, and never together with
     containment or a root guard: it is the alternative to both, not a layer
     on top. */
  if (Object.hasOwn(options, 'processGroup') && typeof options.processGroup !== 'boolean') {
    throw new HiddenSpawnError('HIDDEN_SPAWN_PROCESS_GROUP_INVALID', 'spawnHidden processGroup must be true or false');
  }
  if (options.processGroup === true && (options.containProcessTree === true || options.rootLaunch !== undefined
      || process.platform !== 'linux')) {
    throw new HiddenSpawnError('HIDDEN_SPAWN_PROCESS_GROUP_INVALID',
      'A process group of its own is available only on Linux, and only for a child that is not already contained.');
  }
  const rootLaunch = options.rootLaunch;
  if (rootLaunch !== undefined && (!rootLaunch || options.containProcessTree !== true
      || typeof rootLaunch.beforeRootSpawn !== 'function' || typeof rootLaunch.spawned !== 'function')) {
    throw new HiddenSpawnError('HIDDEN_SPAWN_ROOT_GUARD_INVALID', 'A provider-root guard requires private synchronous admission and child-retention callbacks.');
  }
  const beforeRootSpawn = rootLaunch ? () => {
    const checked = rootLaunch.beforeRootSpawn();
    if (checked && typeof checked.then === 'function') {
      void Promise.resolve(checked).catch(() => {});
      throw new HiddenSpawnError('HIDDEN_SPAWN_ROOT_GUARD_INVALID', 'Provider-root admission must not yield before the OS launch.');
    }
  } : undefined;

  const invocation = resolveHiddenInvocation(command, args, options.env);

  /* THE ENVIRONMENT IS NEVER INHERITED BLIND. `spawn(cmd, args, { env: null })`
     is node's spelling of "inherit everything", so an omitted env must resolve
     to process.env explicitly rather than being passed through as undefined and
     then merged with the resolution's additions -- the merge would otherwise
     produce an env containing ONLY the additions and strip PATH, which is how
     the executable is found at all. */
  const baseEnv = options.env === undefined || options.env === null ? process.env : options.env;
  const childEnv = Object.keys(invocation.env).length
    ? { ...baseEnv, ...invocation.env }
    : baseEnv;

  /* EVERY CHILD STARTED HERE IS AN AGENT CLI (codex-process.js,
     claude-cli-process.js and acp-process.js are the requirers). It gets the
     person's environment with their own sign-in variables in place
     (agentCliEnvironment, src/lib/supervision/launch-environment.js); Fleet never
     adds a credential of its own, so a caller that states a credential overlay is
     refused instead of carried. */
  if (options.credentialEnvironment !== undefined) {
    throw new HiddenSpawnError(
      'HIDDEN_SPAWN_CREDENTIAL_ENVIRONMENT_REFUSED',
      'spawnHidden adds no credential to a child and has no channel to add one',
    );
  }

  // The only way a name of the CLI's own family, or any other name the scrub removes, reaches the child: the
  // variables this launch states for it, validated, and added after the scrub.
  const launchVariables = require('../supervision/launch-environment').assertLaunchVariables(options.launchVariables);
  const childEnvironment = environment => ({ ...agentCliEnvironment(environment), ...launchVariables });

  const {
    shell,
    windowsHide,
    env,
    launchVariables: _launchVariables,
    credentialEnvironment: statedCredentials,
    containProcessTree = false,
    processGroup = false,
    rootLaunch: privateRootLaunch,
    ...rest
  } = options;

  /* A PROVIDER SESSION IS A PROCESS TREE, NOT ONE PID.
   *
   * The direct CLI can exit while one of its tool processes is still walking a
   * workspace, and that orphan can no longer be found from the dead CLI pid.
   *
   * Long-lived provider transports opt into the Linux subreaper/pidfd
   * supervisor before their first instruction runs. The
   * wrapper owns the tree until it proves
   * zero active processes, including when the root exits first or this parent
   * disappears. Short probes keep the original direct-spawn path so version
   * checks do not pay for a containment supervisor.
   *
   */
  if (containProcessTree && process.platform === 'linux') {
    const containedCwd = path.resolve(rest.cwd || process.cwd());
    const child = spawnLinuxOwned(invocation.command, invocation.args, {
      ...rest,
      cwd: containedCwd,
      env: childEnvironment(childEnv),
      shell: false,
      windowsHide: true,
      terminateDescendantsOnRootExit: true,
    }, { launchEnvironment: childEnvironment, ...(beforeRootSpawn ? { beforeRootSpawn } : {}) });
    rootLaunch?.spawned(child);
    return child;
  }

  // No containment wrapper on this path. The same check runs immediately before
  // the direct root, after resolution and environment preparation, not earlier.
  const directEnvironment = childEnvironment(childEnv);
  beforeRootSpawn?.();
  const child = nodeSpawn(invocation.command, invocation.args, {
    ...rest,
    ...(processGroup ? { detached: true } : {}),
    env: directEnvironment,
    shell: false,
    windowsHide: true,
  });
  if (processGroup) attachProcessGroup(child);
  rootLaunch?.spawned(child);
  return child;
}

/* The group leader's identity (pid and /proc start time, read at once so a
   recycled pid is never mistaken for it later), and the one way to end it.
   `terminateJob` is the name the existing transports and startup cleanup
   already call for a contained child; its receipt has the same shape, and
   reports zero active processes only when /proc shows none left. */
function attachProcessGroup(child) {
  if (!Number.isSafeInteger(child.pid)) return;
  const groups = require('./process-group');
  const identity = Object.freeze({ pid: child.pid, startTime: groups.processStartTime(child.pid) });
  let ending = null;
  Object.defineProperty(child, 'processGroup', { value: identity, enumerable: true });
  Object.defineProperty(child, 'terminateJob', {
    value: () => {
      if (!ending) {
        ending = groups.terminateProcessTree(identity).then(result => Object.freeze({
          type: 'terminated',
          activeProcesses: result.survivors.length,
          ...(result.survivors.length > 0 ? { failure: 'survivors' } : {}),
        }));
      }
      return ending;
    },
  });
}

function waitForRootSpawn(child) {
  if (child.jobReady && typeof child.jobReady.then === 'function') return child.jobReady;
  return new Promise((resolve, reject) => {
    const cleanup = () => { child.off('spawn', spawned); child.off('error', failed); child.off('close', ended); };
    const spawned = () => { cleanup(); resolve(); };
    const failed = error => { cleanup(); reject(error); };
    const ended = () => failed(new HiddenSpawnError('HIDDEN_SPAWN_ROOT_ENDED', 'The provider root ended before its start could be observed.'));
    child.once('spawn', spawned); child.once('error', failed); child.once('close', ended);
  });
}

module.exports = {
  HiddenSpawnError,
  PROVIDER_SPAWN_REFUSAL_VARIABLE,
  providerSpawnRefused,
  resolveHiddenInvocation,
  spawnHidden,
  waitForRootSpawn,
};
