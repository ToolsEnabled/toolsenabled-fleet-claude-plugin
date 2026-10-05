#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { absolute, resolveConfig, configureEnvironment, childEnvironment } = require('./runtime-config');
const { real, inside, projectFolder } = require('./project-folder');
// Agent CLIs that Fleet can start as subagents on this computer, as equal
// entries. Fleet runs each CLI's own sign-in status command, with the launch
// options a subagent starts with, and uses only its exit status; it never reads,
// copies or stores a sign-in. "Signed in" therefore means a subagent can sign
// in. A CLI whose subagents run in its own operating-system sandbox also names a
// command that starts that sandbox around /bin/true in the project, with no
// model call.
const SUBAGENT_CLIS = Object.freeze({
  claude: Object.freeze({ status: Object.freeze(['--setting-sources', '', '--restricted', 'auth', 'status']), signIn: 'claude auth login' }),
  codex: Object.freeze({ status: Object.freeze(['login', 'status']), signIn: 'codex login',
    sandbox: Object.freeze({ args: workspace => ['sandbox', '-P', ':workspace', '-C', workspace, '/bin/true'],
      help: 'https://developers.openai.com/codex/concepts/sandboxing#prerequisites' }) }),
});
// Only a sandbox that reports it could not start turns a CLI off. A usage error
// (another CLI version), a timeout or any other failure leaves the CLI on.
const SANDBOX_FAILURE = /bwrap|bubblewrap|namespace|landlock|seccomp|sandbox/i;
const SETUP_COMMAND = '/tefleet setup';
// Folders whose files other programs run or obey: version control, CI and git
// hooks, build output and installed packages, Python environments, and the
// settings of Claude Code, Codex, editors and dev containers. Fleet refuses one
// at any depth of the project path.
const CONTROL_FOLDERS = Object.freeze(['.git', '.hg', '.svn', '.github', '.husky', '.claude', '.codex', '.vscode', '.idea',
  '.devcontainer', 'node_modules', '.venv', 'venv']);

// The engine's own rules for where an agent CLI may be found: never in the
// project, Fleet's state folder or a temporary folder (subagent launches use
// the same rules).
function launchRules() {
  return require(path.join(require('./runtime-config').engine, 'src/lib/supervision/launch-environment'));
}
function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
// PATH folders a program may be found in: absolute, and neither as written nor
// where they really are inside the project, Fleet's state folder or a
// temporary folder. An empty or relative entry would resolve against the
// project, so it is skipped too.
function safeFolders(env, { workspace = null, avoid = [] } = {}) {
  const roots = launchRules().subagentWritableRoots({ env, workspace, extraRoots: avoid });
  const folders = [];
  for (const folder of String(env.PATH || '').split(path.delimiter)) {
    if (!folder || !path.isAbsolute(folder) || folders.includes(folder)) continue;
    const lexical = path.resolve(folder);
    if (roots.some(root => within(root, lexical) || within(root, real(lexical)))) continue;
    folders.push(folder);
  }
  return folders;
}
// Installed CLIs in SUBAGENT_CLIS order, with the file PATH resolves each to,
// found the way Fleet finds them for subagents. A CLI found in, or linked into,
// the project, Fleet's state folder or a temporary folder is skipped: a
// subagent or another program could have put it there.
function installed(env = process.env, { avoid = [], workspace = null } = {}) {
  const launch = launchRules();
  const found = [];
  for (const name of Object.keys(SUBAGENT_CLIS)) {
    const file = launch.resolveAgentCli(name, { env, workspace, extraRoots: avoid.filter(root => typeof root === 'string' && path.isAbsolute(root)) });
    if (file) found.push({ name, file });
  }
  return found;
}
function providers(env = process.env) { return installed(env).map(cli => cli.name); }
// The home folder in HOME and the account's own, when they differ.
function accountHomes() {
  const os = require('node:os');
  let account = null;
  try { account = os.userInfo().homedir; } catch { account = null; }
  return [...new Set([os.homedir(), account].filter(home => typeof home === 'string' && path.isAbsolute(home)))];
}
// Why Fleet will not use this folder as its project, or null. Fleet's subagents
// write in the project, so it must not be a folder whose files git, CI, Claude
// Code, Codex, an editor, a package manager or the shell runs or obeys.
function projectRefusal(workspace, { env = process.env, homes = accountHomes() } = {}) {
  let stat;
  try { stat = fs.lstatSync(workspace); }
  catch (error) {
    if (error.code === 'ENOENT') return `There is no folder at ${workspace}. Fleet sets up an existing project folder and does not create one.`;
    return `Fleet cannot read the folder ${workspace} (${error.code || 'unreadable'}).`;
  }
  if (stat.isSymbolicLink()) return `${workspace} is a link. Set up the folder it points to instead.`;
  if (!stat.isDirectory()) return `${workspace} is not a folder.`;
  const resolved = real(workspace);
  for (const candidate of [workspace, resolved]) {
    const control = candidate.split(path.sep).find(part => CONTROL_FOLDERS.includes(part));
    if (control) return `${workspace} is a ${control} folder or inside one, whose files other programs run or obey. Set up the project folder itself.`;
  }
  const realHomes = homes.map(real);
  for (const home of homes) {
    const realHome = real(home);
    const underHome = path.relative(realHome, resolved).split(path.sep)[0];
    if (inside(resolved, realHome) && underHome && underHome.startsWith('.')) {
      const dotFolder = path.join(home, underHome);
      return `${resolved === real(dotFolder) ? `${workspace} is` : `${workspace} is inside ${dotFolder},`} a settings folder in your home folder. Set up a project folder instead.`;
    }
    if (resolved === real(path.join(home, 'bin'))) return `${workspace} is your ~/bin folder, whose programs your shell runs. Set up a project folder instead.`;
  }
  for (const folder of String(env.PATH || '').split(path.delimiter)) {
    if (!path.isAbsolute(folder)) continue;
    const onPath = real(folder);
    if (onPath === resolved) return `${workspace} is on your PATH, so your shell runs programs from it. Set up a project folder instead.`;
    // A folder inside a PATH folder, except where the PATH entry is the root,
    // a home folder or above one, which say nothing about the project.
    if (onPath !== path.parse(onPath).root && !realHomes.some(home => within(onPath, home)) && within(onPath, resolved)) {
      return `${workspace} is inside ${folder}, a folder on your PATH, so your shell runs programs from it. Set up a project folder instead.`;
    }
  }
  return null;
}
// Why this session may not set up that folder, or null. Fleet sets up only the
// project folder the session works in (CLAUDE_PROJECT_DIR, or the working
// folder), or a folder above it inside the home folder: never a folder Claude
// names elsewhere.
function sessionRefusal(workspace, { env = process.env, cwd = process.cwd(), homes = accountHomes() } = {}) {
  const session = projectFolder(env, cwd);
  const resolved = real(workspace);
  if (resolved === session) return null;
  const realHomes = homes.map(real);
  if (realHomes.includes(resolved)) {
    return 'Fleet needs a project folder, not your home folder. Open a project folder in Claude Code and set up Fleet there.';
  }
  if (within(resolved, session) && realHomes.some(home => home !== resolved && within(home, resolved))) {
    // A folder above the session's project is for the first setup only. Once Fleet
    // is set up, a call from the session cannot widen the folder subagents may
    // write to; to use a wider folder, start Claude Code in it. When the saved
    // setup cannot be read, the answer is no.
    let saved;
    try { saved = require('./project-folder').savedWorkspace(require('./runtime-config').resolveConfig().stateRoot); }
    catch { return `${workspace} is above this session's project folder, and Fleet could not read its saved setup, so it did not widen it. Start Claude Code in that folder and type ${SETUP_COMMAND}.`; }
    if (!saved || real(saved) === resolved) return null;
    return `${workspace} is above this session's project folder, and Fleet is already set up for ${saved}, so it did not widen it. `
      + `To use a wider folder, start Claude Code there and type ${SETUP_COMMAND}.`;
  }
  return `${workspace} is not this session's project folder. Fleet sets up the folder this session works in, ${session}, or a folder above it inside your home folder. `
    + `To use another folder, start Claude Code there and type ${SETUP_COMMAND}.`;
}
// Why this session may not set up that folder: the folder itself, then whether
// it is this session's project.
function setupRefusal(workspace, options = {}) {
  return projectRefusal(workspace, options) || sessionRefusal(workspace, options);
}
function checkProject(workspace, options) {
  const refusal = projectRefusal(workspace, options);
  if (refusal) throw new Error(refusal);
  return workspace;
}
// Which installed CLIs are signed in and can run here. The checks run with the
// environment subagents get: the person's own, without any provider sign-in
// variable and without the lead session's bindings, and PATH without folders in
// the project, Fleet's state folder or a temporary folder.
function survey(config, { env = process.env, run = spawnSync, workspace = null } = {}) {
  const launch = launchRules();
  const avoid = [config.stateRoot];
  const clean = { ...launch.subscriptionLaunchEnvironment(env), PATH: safeFolders(env, { workspace, avoid }).join(path.delimiter) };
  const found = installed(env, { workspace, avoid });
  const ready = [];
  const signedOut = [];
  const noSandbox = [];
  for (const cli of found) {
    const info = SUBAGENT_CLIS[cli.name];
    const result = run(cli.file, info.status, { env: clean, stdio: 'ignore', timeout: 15000 });
    if (result.status !== 0) { signedOut.push(cli.name); continue; }
    if (info.sandbox && workspace && fs.existsSync(workspace)) {
      const startsSandbox = () => run(cli.file, info.sandbox.args(workspace), { cwd: workspace, env: clean, encoding: 'utf8',
        stdio: ['ignore', 'ignore', 'pipe'], timeout: 20000, maxBuffer: 64 * 1024 });
      const failed = probe => probe.status === 1 && SANDBOX_FAILURE.test(String(probe.stderr || ''));
      // One failure can be a race with another start of the same CLI, so it is asked once more before the CLI is turned off.
      if (failed(startsSandbox()) && failed(startsSandbox())) { noSandbox.push(cli.name); continue; }
    }
    ready.push(cli.name);
  }
  return { installed: found.map(cli => cli.name), ready, signedOut, noSandbox };
}
function signInHint(name) {
  return `${name} is installed, but Fleet found no saved login its subagents can use. Subagents use a CLI's own saved login, not sign-in variables or settings files, so a sign-in kept only in one of those does not count. To use ${name}, run \`${SUBAGENT_CLIS[name].signIn}\` once in a terminal, then run ${SETUP_COMMAND} again.`;
}
function sandboxHint(name) {
  return `${name} is signed in, but its sandbox cannot start on this computer, so its subagents could not edit files. Follow ${SUBAGENT_CLIS[name].sandbox.help}, then run ${SETUP_COMMAND} again.`;
}
function surveyNote(status) {
  if (!status.installed.length) {
    return `Subagents are off because no supported agent CLI (${Object.keys(SUBAGENT_CLIS).join(', ')}) was found on PATH. Install one, sign in, then run ${SETUP_COMMAND} again.`;
  }
  return [...status.signedOut.map(signInHint), ...status.noSandbox.map(sandboxHint)].join('\n');
}
// The person may name which signed-in CLIs subagents use; by default all of them.
function chosenProviders(status, list) {
  if (list === undefined) return status.ready;
  const asked = list.split(',').map(name => name.trim()).filter(Boolean);
  const unknown = asked.filter(name => !Object.hasOwn(SUBAGENT_CLIS, name));
  if (!asked.length || unknown.length) throw new Error(`Choose subagent CLIs from: ${Object.keys(SUBAGENT_CLIS).join(', ')}.`);
  const unavailable = asked.filter(name => !status.ready.includes(name));
  if (unavailable.length) {
    throw new Error(unavailable.map(name => (status.signedOut.includes(name) ? signInHint(name)
      : status.noSandbox.includes(name) ? sandboxHint(name) : `${name} is not installed on PATH.`)).join(' '));
  }
  return Object.keys(SUBAGENT_CLIS).filter(name => asked.includes(name));
}
// Models (tier names such as terra or claude-sonnet) the person allows. A list
// limits only the providers it names. Without a new list, setup keeps the saved
// one for the providers that stay on; "all" clears it.
function chosenModels(config, chosen, list) {
  const tiers = require(path.join(config.engine, 'src/lib/fleet-worker-tiers'));
  const known = name => Object.hasOwn(tiers, name) && chosen.includes(tiers[name].provider);
  if (list === 'all') return null;
  if (list === undefined) {
    let saved = null;
    try { saved = require(path.join(config.engine, 'src/lib/host-runtime')).readHostConfig(config.stateRoot, { setupKind: 'plugin', allowPluginRebind: true }).models; }
    catch { saved = null; }
    const kept = (saved || []).filter(known);
    return kept.length ? kept : null;
  }
  const asked = list.split(',').map(name => name.trim()).filter(Boolean);
  const unknown = asked.filter(name => !known(name));
  if (!asked.length || unknown.length) {
    const offered = chosen.map(provider => `${provider}: ${Object.keys(tiers).filter(name => tiers[name].provider === provider).join(', ')}`).join('; ');
    throw new Error(`${unknown.length ? `Not a model of the agent CLIs turned on: ${unknown.join(', ')}. ` : ''}Choose from ${offered || 'the models of a turned-on agent CLI'}.`);
  }
  return [...new Set(asked)];
}
// Run one setup attempt in its own process and return its JSON result.
function runSetup(hostEntry, args) {
  const result = spawnSync(process.execPath, [hostEntry, ...args],
    { env: childEnvironment(), encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.error?.message || String(result.stderr || 'Setup failed.').trim());
  return JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
}
function flags(rest) {
  const named = {};
  for (let at = 0; at < rest.length; at += 2) {
    const key = { '--providers': 'providers', '--models': 'models' }[rest[at]];
    if (!key || Object.hasOwn(named, key) || typeof rest[at + 1] !== 'string' || !rest[at + 1]) return null;
    named[key] = rest[at + 1];
  }
  return named;
}
// After a plugin update the saved setup points at the old plugin folder. This
// binds it to this version with the person's saved choices: the same project,
// providers and models, minus any agent CLI that is no longer ready.
function rebind() {
  const config = configureEnvironment(resolveConfig());
  const previous = require(path.join(config.engine, 'src/lib/host-runtime'))
    .readHostConfig(config.stateRoot, { setupKind: 'plugin', allowPluginRebind: true });
  if (previous.setupKind !== 'plugin') throw new Error('This state is not a Fleet plugin setup.');
  checkProject(previous.workspace);
  require('./node-guard').assertSafeNode({ workspaces: [previous.workspace] });
  const status = survey(config, { workspace: previous.workspace });
  const chosen = previous.workers ? (previous.providers || status.ready).filter(name => status.ready.includes(name)) : [];
  const tiers = require(path.join(config.engine, 'src/lib/fleet-worker-tiers'));
  const models = (previous.models || []).filter(name => Object.hasOwn(tiers, name) && chosen.includes(tiers[name].provider));
  const dropped = previous.workers ? (previous.providers || []).filter(name => !chosen.includes(name)) : [];
  let note = dropped.length ? [...status.signedOut, ...status.noSandbox].filter(name => dropped.includes(name))
    .map(name => (status.signedOut.includes(name) ? signInHint(name) : sandboxHint(name))).join('\n') : '';
  const host = path.join(config.engine, 'bin/toolsenabled-host.js');
  const base = ['setup', '--plugin', '--workspace', previous.workspace, '--tier', 'standard', '--state-root', config.stateRoot];
  let result;
  try {
    result = runSetup(host, chosen.length
      ? [...base, '--enable-workers', '--providers', chosen.join(','), ...(models.length ? ['--models', models.join(',')] : [])] : base);
  } catch (error) {
    if (!chosen.length || !String(error.message).includes('LINUX_PROCESS_NATIVE_UNAVAILABLE')) throw error;
    result = runSetup(host, base);
    note = 'Subagents are off because this system does not allow the process control they need (Linux 5.3+ with pidfd).';
  }
  process.stdout.write(JSON.stringify({ ...result, rebound: true, ...(note ? { note } : {}) }) + '\n');
}
async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === '--rebind') return rebind();
  const [action, target, ...rest] = argv;
  const named = flags(rest);
  if (!['--check', '--setup'].includes(action) || !target || !named) {
    throw new Error('Use --check or --setup followed by the confirmed project path, optionally with --providers CLI,CLI and --models MODEL,MODEL (or all).');
  }
  const config = configureEnvironment(resolveConfig());
  const workspace = absolute(target, 'workspace');
  const refusal = setupRefusal(workspace);
  if (refusal) throw new Error(refusal);
  require('./node-guard').assertSafeNode({ workspaces: [workspace] });
  const status = survey(config, { workspace });
  const chosen = chosenProviders(status, named.providers);
  const models = chosen.length ? chosenModels(config, chosen, named.models) : null;
  // Hints about other CLIs are noise when the person chose which ones to use.
  let note = named.providers ? '' : surveyNote(status);
  if (action === '--check') {
    process.stdout.write(JSON.stringify({ mode: config.mode, workspace, providers: chosen, ...(models ? { models } : {}), installed: status.installed,
      signedOut: status.signedOut, noSandbox: status.noSandbox, tier: 'standard', subagents: chosen.length > 0, ...(note ? { note } : {}) }) + '\n');
    return;
  }
  const host = path.join(config.engine, 'bin/toolsenabled-host.js');
  const base = ['setup', '--plugin', '--workspace', workspace, '--tier', 'standard', '--state-root', config.stateRoot];
  let result;
  try {
    result = runSetup(host, chosen.length
      ? [...base, '--enable-workers', '--providers', chosen.join(','), ...(models ? ['--models', models.join(',')] : [])] : base);
  } catch (error) {
    // Subagents need native process control. Without it, Fleet's other tools still work.
    if (!chosen.length || !String(error.message).includes('LINUX_PROCESS_NATIVE_UNAVAILABLE')) throw error;
    result = runSetup(host, base);
    note = 'Subagents are off because this system does not allow the process control they need (Linux 5.3+ with pidfd).';
  }
  process.stdout.write(JSON.stringify({ ...result, ...(note ? { note } : {}) }) + '\n');
}
if (require.main === module) main().catch(error => {
  process.stderr.write(`Fleet setup failed: ${error.message}\n`);
  process.exitCode = 1;
});
module.exports = { main, resolveConfig, providers, installed, survey, projectRefusal, sessionRefusal, setupRefusal, chosenProviders, chosenModels,
  SUBAGENT_CLIS, CONTROL_FOLDERS };
