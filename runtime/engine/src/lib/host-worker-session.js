'use strict';

// Explicit host workers share the existing native adapters and tree protocol.
// The adapters retain normal CLI confinement and owned process containment.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Override the installed host entry in this worker process. A second name
// would leave the root registration active beside the narrower worker server.
const SERVER_NAME = 'toolsenabled-fleet-host';
const APPROVAL_DENIED = 'A native permission request was denied because host workers cannot present approval prompts. Run the needed action through your own CLI session.';
const MODES = ['Only', 'Optimized', 'Enabled', 'Disabled'];
const SERVER_ENV = ['HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_DATA_HOME', 'LOCALAPPDATA',
  'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'GIT_SSL_CAINFO',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy'];
const TREE_ENV = ['TOOLSENABLED_OPENSHELL_ROLE', 'TOOLSENABLED_OPENSHELL_DIRECT_ONLY', 'TOOLSENABLED_TOOL_ALLOWLIST'];
function refusal(code, message) { return Object.assign(new Error(message), { code }); }
function requireEnabled(config, env) {
  if (config?.mode !== 'host' || config.workers !== true || env.TOOLSENABLED_RUNTIME_MODE !== 'host'
      || env.TOOLSENABLED_HOST_WORKERS !== '1') {
    throw refusal('HOST_WORKERS_DISABLED', 'Host workers require explicit host mode and the saved worker opt-in.');
  }
  // Subagents run at the Standard level only; no wider launch exists.
  if (config.tier !== 'standard') {
    throw refusal('HOST_WORKER_LEVEL_REFUSED', 'Host workers run at the Standard level only.');
  }
}
function within(root, value) {
  const relative = path.relative(root, value);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
function privateFolder(folder, root) {
  if (!path.isAbsolute(root) || !path.isAbsolute(folder) || !within(root, folder)) {
    throw refusal('HOST_WORKER_PATH_INVALID', 'Worker files must stay in the private host state folder.');
  }
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  if (fs.realpathSync(folder) !== path.resolve(folder)) throw refusal('HOST_WORKER_PATH_INVALID', 'Worker folders cannot cross links.');
  let cursor = folder;
  while (within(root, cursor)) {
    const stat = fs.lstatSync(cursor);
    if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) {
      throw refusal('HOST_WORKER_PATH_INVALID', 'Worker folders must be private and owned by you.');
    }
    if (cursor === root) break;
    cursor = path.dirname(cursor);
  }
}
function writePrivate(file, text, root) {
  privateFolder(path.dirname(file), root);
  const temporary = `${file}.${crypto.randomBytes(12).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}
function hostWorkerEntry({ env, config, provider, socketPath, spec, tokenFile }) {
  const narrowed = spec.serverEnv || {};
  for (const [name, value] of Object.entries(narrowed)) {
    if (!TREE_ENV.includes(name) || typeof value !== 'string') throw refusal('HOST_WORKER_ENV_INVALID', 'Unexpected worker environment field.');
  }
  const parent = new Set(String(env.TOOLSENABLED_TOOL_ALLOWLIST || '').split(',').filter(Boolean));
  const listed = String(narrowed.TOOLSENABLED_TOOL_ALLOWLIST ?? env.TOOLSENABLED_TOOL_ALLOWLIST ?? '').split(',').filter(Boolean);
  // A Claude subagent reads and writes project files with its own Read, Edit
  // and Write under Claude Code's permission rules and protected paths. Fleet's
  // host file and search tools would be a second file channel beside them with
  // different refusals, so its server does not offer them to Claude.
  const tools = provider === 'claude' ? require('./claude-workspace-file-tools').confinedMcpNames(listed) : listed;
  if (!tools.length || listed.some(name => !parent.has(name))) {
    throw refusal('HOST_WORKER_ENV_INVALID', 'A worker tool list must be nonempty and no wider than its parent.');
  }
  const forwarded = Object.fromEntries(SERVER_ENV.filter(name => typeof env[name] === 'string').map(name => [name, env[name]]));
  return {
    command: process.execPath,
    args: [path.resolve(__dirname, '../../bin/toolsenabled-host.js'), 'serve', '--state-root', config.stateRoot, '--actor', provider],
    env: { ...forwarded, TOOLSENABLED_RUNTIME_MODE: 'host',
      TOOLSENABLED_TOOL_ALLOWLIST: tools.join(','), TOOLSENABLED_HOST_TREE_SOCKET: socketPath,
      TOOLSENABLED_HOST_NODE: spec.nodeId, TOOLSENABLED_HOST_SESSION: spec.sessionId,
      TOOLSENABLED_HOST_LINK_TOKEN_FILE: tokenFile,
      TOOLSENABLED_HOST_ROLE: narrowed.TOOLSENABLED_OPENSHELL_ROLE || '',
      TOOLSENABLED_HOST_DIRECT_ONLY: narrowed.TOOLSENABLED_OPENSHELL_DIRECT_ONLY || '0' },
  };
}
// The lead session's bindings (session ids, messaging socket, IDE binding and
// Fleet's internal variables) are removed from a subagent CLI; its own sign-in
// variables are kept. One policy, shared with the setup sign-in check:
// src/lib/supervision/launch-environment.js. PATH keeps only the folders the
// CLI itself was looked up in (no project or temporary folder), so a CLI that
// starts through `#!/usr/bin/env node`, and every helper Codex lists with,
// never runs a program a subagent planted in the project.
const launchPolicy = require('./supervision/launch-environment');
const HOST_SESSION_ENV = launchPolicy.LEAD_SESSION_ENV;
function cliEnvironment(env, workspaceRoot) {
  return launchPolicy.confinedAgentCliEnvironment(env, { workspace: workspaceRoot });
}
function untrustedProjectOverride(workspaceRoot) {
  const ancestors = [];
  for (let folder = path.resolve(workspaceRoot);; folder = path.dirname(folder)) {
    ancestors.unshift(folder);
    if (folder === path.dirname(folder)) break;
  }
  // JSON quotes TOML keys except for DEL, which JSON.stringify leaves raw but
  // TOML forbids. Preserve the exact path with TOML's Unicode escape.
  return `projects={${ancestors.map(folder => `${JSON.stringify(folder).replace(/\x7f/g, '\\u007f')}={trust_level="untrusted"}`).join(',')}}`;
}
// Codex features that act outside Codex's sandbox: connectors to the person's
// accounts, plugins and their MCP servers, hooks, browser or computer control,
// and image generation, which runs on the provider. A Standard Codex worker
// runs without them in every Agent API mode, and without web search
// (web_search="disabled" in codexOverrides), which reaches the network that
// its sandbox turns off.
const STANDARD_CODEX_FEATURES_OFF = Object.freeze(['apps', 'plugins', 'remote_plugin', 'plugin_sharing', 'hooks',
  'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'computer_use', 'in_app_browser',
  'in_app_local_automation', 'skill_mcp_dependency_install', 'multi_agent', 'multi_agent_v2', 'image_generation']);
// Codex's own subagents would run outside Fleet's depth, width and model
// limits. Its model catalog can turn them on even with features.multi_agent
// off. A maximum depth of 0 removes the tools for a model without a
// multi-agent version, but not for one that names it (measured on codex-cli
// 0.160.0), so confineCodexModelCatalog() below removes that from every model.
const CODEX_NO_NATIVE_SUBAGENTS = Object.freeze(['-c', 'agents.max_depth=0']);
// Codex starts MCP servers with a minimal environment. Fleet's server needs the
// runtime directory that holds its private tree socket.
const CODEX_FLEET_SERVER_ENV_VARS = Object.freeze(['XDG_RUNTIME_DIR']);
function codexOverrides(entry, apiMode, workspaceRoot) {
  const key = `mcp_servers.${SERVER_NAME}`;
  const args = ['-c', `${key}.command=${JSON.stringify(entry.command)}`,
    '-c', `${key}.args=${JSON.stringify(entry.args)}`,
    ...Object.entries(entry.env).flatMap(([name, value]) => ['-c', `${key}.env.${name}=${JSON.stringify(value)}`]),
    '-c', `${key}.env_vars=${JSON.stringify(CODEX_FLEET_SERVER_ENV_VARS)}`,
    '-c', `${key}.tool_timeout_sec=900`, '-c', apiMode === 'Disabled' ? `${key}.enabled=false` : `${key}.required=true`];
  args.push(...CODEX_NO_NATIVE_SUBAGENTS, '-c', 'web_search="disabled"');
  if (apiMode === 'Only') {
    args.push(...require('./agent-session-confinement').CODEX_API_ONLY_DISABLED_FEATURES.flatMap(name => ['-c', `features.${name}=false`]),
      '-c', 'features.code_mode_host=true', '-c', 'features.skip_host_skill_discovery=true');
  }
  const off = new Set(apiMode === 'Only' ? require('./agent-session-confinement').CODEX_API_ONLY_DISABLED_FEATURES : []);
  args.push(...STANDARD_CODEX_FEATURES_OFF.filter(name => !off.has(name)).flatMap(name => ['-c', `features.${name}=false`]));
  // Standard sets approvals to "never", so nobody could answer Codex asking to
  // approve a destructive Fleet tool; Fleet's server enforces its own gates
  // (workspace, roles, protected paths).
  // Workspace-write would otherwise also make /tmp and $TMPDIR writable, which
  // reach outside the project: other sessions' scratch files, and Fleet's own
  // state if it were placed there. Both are left out, and the start is refused
  // unless Codex's resolved sandbox confirms it.
  args.push('-c', 'sandbox_mode="workspace-write"', '-c', 'approval_policy="never"',
    '-c', 'sandbox_workspace_write.writable_roots=[]', '-c', 'sandbox_workspace_write.network_access=false',
    '-c', 'sandbox_workspace_write.exclude_slash_tmp=true', '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true',
    '-c', untrustedProjectOverride(workspaceRoot), '-c', `${key}.default_tools_approval_mode="approve"`);
  // The CLI keeps the person's sign-in variables; commands its shell runs get
  // only Codex's core variables (home, user, shell, path and temporary
  // folder), with its KEY, SECRET and TOKEN name exclusions applied as well.
  args.push(...CODEX_SHELL_ENVIRONMENT);
  return args;
}
const CODEX_SHELL_ENVIRONMENT = Object.freeze(['-c', 'shell_environment_policy.inherit="core"',
  '-c', 'shell_environment_policy.ignore_default_excludes=false']);

// A TOML basic string for a -c override. JSON escapes are valid TOML except a
// raw DEL, which TOML forbids, and lone surrogates, which TOML cannot hold.
function tomlString(text) {
  const wellFormed = typeof text.toWellFormed === 'function' ? text.toWellFormed() : text;
  return JSON.stringify(wellFormed).replace(/\x7f/g, '\\u007f');
}

// Codex's own list of the MCP servers it would load with these arguments, run
// with the pinned Codex program only. Only each server's name and on/off state
// are kept; null when Codex cannot list.
function listCodexMcpServers({ args, env, cwd, command, run = require('node:child_process').spawnSync }) {
  pinnedCommand({ command }, 'codex');
  const listing = run(command, [...args, 'mcp', 'list', '--json'], { cwd, env, encoding: 'utf8', timeout: 20000,
    maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  let rows = null;
  if (listing.status === 0) { try { rows = JSON.parse(listing.stdout); } catch { rows = null; } }
  if (!Array.isArray(rows)) return null;
  return rows.map(row => ({ name: row && typeof row.name === 'string' ? row.name : null, enabled: row ? row.enabled : undefined }));
}
// Every MCP server in the person's Codex configuration runs outside Codex's
// sandbox, so a Standard worker gets only Fleet's server: each other server is
// turned off for this worker only, and a second listing confirms it.
function confineCodexMcpServers({ list, args, env, cwd, fleetEnabled, command }) {
  const unverified = () => refusal('HOST_WORKER_MCP_POLICY_UNVERIFIED',
    'Codex did not list the MCP servers it would load, so Fleet could not confirm a Standard subagent gets only Fleet\'s server. Nothing was started.');
  const unconfined = names => refusal('HOST_WORKER_MCP_POLICY_WIDE',
    `Codex would keep MCP servers that run outside its sandbox (${names.map(name => JSON.stringify(String(name).slice(0, 64))).join(', ')}). `
    + 'Standard subagents may use only Fleet\'s server, so nothing was started.');
  const listEnv = launchPolicy.agentCliEnvironment(env);
  const before = list({ args, env: listEnv, cwd, command });
  if (!Array.isArray(before)) throw unverified();
  const others = [...new Set(before.map(row => row.name).filter(name => name !== SERVER_NAME))];
  const unnamed = others.filter(name => typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(name));
  if (unnamed.length) throw unconfined(unnamed);
  const off = others.flatMap(name => ['-c', `mcp_servers.${name}.enabled=false`]);
  const after = list({ args: [...args, ...off], env: listEnv, cwd, command });
  if (!Array.isArray(after)) throw unverified();
  const stillOn = after.filter(row => row.name !== SERVER_NAME && row.enabled !== false).map(row => row.name);
  const fleet = after.find(row => row.name === SERVER_NAME);
  if (stillOn.length) throw unconfined(stillOn);
  if (fleetEnabled && (!fleet || fleet.enabled === false)) throw unverified();
  return off;
}

// Codex's own model catalog, as `codex debug models` prints it with these
// arguments, run with the pinned Codex program only; null when Codex cannot
// list it.
function listCodexModelCatalog({ args, env, cwd, command, run = require('node:child_process').spawnSync }) {
  pinnedCommand({ command }, 'codex');
  const listing = run(command, [...args, 'debug', 'models'], { cwd, env, encoding: 'utf8', timeout: 30000,
    maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  if (listing.status !== 0) return null;
  try { return JSON.parse(listing.stdout); } catch { return null; }
}
function catalogModels(catalog) {
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog) || !Array.isArray(catalog.models)
      || !catalog.models.length || catalog.models.length > 1000) return null;
  return catalog.models.every(entry => entry && typeof entry === 'object' && !Array.isArray(entry)
    && typeof entry.slug === 'string' && entry.slug.length > 0 && entry.slug.length <= 200) ? catalog.models : null;
}
// CODEX'S OWN FILE-EDITING AND SUBAGENT TOOLS, TURNED OFF THROUGH ITS MODEL
// CATALOG AND CONFIRMED FROM CODEX'S OWN LISTING OF IT.
//
// codex-cli 0.160.0 has no setting or feature flag for either. Each model's
// entry in Codex's model catalog decides whether a session gets apply_patch
// (apply_patch_tool_type) and Codex's native subagent tools, spawn_agent,
// send_message and the rest of its "collaboration" tools (multi_agent_version);
// agents.max_depth=0 does not remove the latter for a model that names a
// multi-agent version. apply_patch writes any file in the project, protected
// ones included, and native subagents run outside Fleet's depth, width and
// model limits. Codex's model_catalog_json setting replaces the catalog, and a
// catalog given that way is not refreshed from the network.
//
// So Fleet asks Codex for its catalog, writes a copy for this subagent with
// multi_agent_version removed from every model (every mode) and
// apply_patch_tool_type null for every model (Only mode, where a Codex subagent
// edits files only through Fleet's host tools, which refuse protected paths),
// points Codex at the copy, and lists the catalog again. Nothing starts unless
// that listing has the fields off for every model and names the requested
// model.
//
// Measured with codex-cli 0.160.0 against a local stand-in model server, no
// network and no sign-in: with the copy, apply_patch is gone from the tools
// sent to the model (directly and inside code mode), a call to it is refused as
// unsupported, spawn_agent is refused as unsupported, and a ChatGPT-style
// sign-in no longer refreshes the model list.
function confineCodexModelCatalog({ list, args, env, cwd, command, apiMode, model, file, root }) {
  const unverified = () => refusal('HOST_WORKER_TOOL_POLICY_UNVERIFIED',
    'Codex did not list its model catalog, so Fleet could not confirm a Codex subagent runs without Codex\'s own '
    + (apiMode === 'Only' ? 'file-editing and subagent tools' : 'subagent tools') + '. Nothing was started. Update Codex, then start a new session.');
  const models = catalogModels(list({ args, env, cwd, command }));
  if (!models) throw unverified();
  const confined = models.map(entry => {
    const { multi_agent_version: ignored, ...copy } = entry;
    return apiMode === 'Only' ? { ...copy, apply_patch_tool_type: null } : copy;
  });
  writePrivate(file, `${JSON.stringify({ models: confined })}\n`, root);
  const override = ['-c', `model_catalog_json=${tomlString(file)}`];
  const listed = catalogModels(list({ args: [...args, ...override], env, cwd, command }));
  if (!listed || listed.length !== confined.length) throw unverified();
  const wide = listed.filter(entry => entry.multi_agent_version != null
    || (apiMode === 'Only' && entry.apply_patch_tool_type != null)).map(entry => entry.slug);
  if (wide.length) {
    throw refusal('HOST_WORKER_TOOL_POLICY_WIDE', `Codex kept its own ${apiMode === 'Only' ? 'file-editing or subagent' : 'subagent'} tools for `
      + `${wide.slice(0, 4).map(slug => JSON.stringify(slug.slice(0, 64))).join(', ')}, so nothing was started.`);
  }
  if (model && !listed.some(entry => entry.slug === model)) {
    throw refusal('HOST_WORKER_MODEL_UNLISTED', `Codex's model list does not include ${JSON.stringify(String(model).slice(0, 64))}, `
      + 'so Fleet could not confirm which of Codex\'s own tools it would get. Nothing was started. Choose a model Codex lists.');
  }
  return override;
}

function codexEvents(onEvent) {
  let session;
  const deniedTurns = new Map();
  const assistantText = new Map();
  const forward = event => { if (typeof onEvent === 'function') onEvent(event); };
  return {
    bind(value) { session = value; },
    onEvent(event) {
      if (event?.type === 'approval_request') {
        const approval = event.approval;
        deniedTurns.set(event.turnId, APPROVAL_DENIED);
        try {
          if (!approval || !['commandExecution', 'fileChange', 'permissions'].includes(approval.kind)
              || !session?.adapter?.answerApproval) throw refusal('HOST_APPROVAL_UNAVAILABLE', APPROVAL_DENIED);
          session.adapter.answerApproval({ approvalId: approval.approvalId,
            response: approval.kind === 'permissions' ? { permissions: {}, scope: 'turn' } : { decision: 'decline' } });
        } catch {
          try { session?.close(); } catch { /* the normal owned-session close remains authoritative */ }
          forward({ type: 'turn_completed', threadId: event.threadId, turnId: event.turnId, status: 'failed', text: APPROVAL_DENIED });
          deniedTurns.delete(event.turnId);
          assistantText.delete(event.turnId);
        }
        return;
      }
      if (event?.type === 'assistant_text') assistantText.set(event.turnId, event.text);
      if (event?.type === 'turn_completed') {
        if (deniedTurns.has(event.turnId)) event = { ...event,
          text: [event.text || assistantText.get(event.turnId), deniedTurns.get(event.turnId)].filter(Boolean).join('\n\n') };
        deniedTurns.delete(event.turnId);
        assistantText.delete(event.turnId);
      }
      forward(event);
    },
  };
}

function claudeEvents(onEvent, { workspaceRoot = null } = {}) {
  const assistantText = new Map();
  return event => {
    if (event?.type === 'assistant_text') assistantText.set(event.turnId, event.text);
    if (event?.type === 'turn_completed') {
      if (event.payload?.permissionDenied === true) {
        const names = Array.isArray(event.payload.permissionDeniedTools) ? event.payload.permissionDeniedTools : [];
        const explanation = ['Standard Claude workers can Read, Edit and Write only inside the sealed workspace; other native tools and outside paths are denied.'];
        if (names.length) explanation.push(`Denied tools: ${names.join(', ')}.`);
        const outside = require('./claude-workspace-file-tools').outsideWriteDenial(
          event.payload.permissionDeniedFiles, workspaceRoot, 'Standard');
        if (outside) explanation.push(outside);
        explanation.push('Use a workspace path or ask the person to change the Fleet permission tier before retrying.');
        event = { ...event, text: [event.text || assistantText.get(event.turnId), explanation.join(' ')].filter(Boolean).join('\n\n') };
      }
      assistantText.delete(event.turnId);
    }
    if (typeof onEvent === 'function') return onEvent(event);
  };
}

// The real CLI launches run only the absolute program pinned for this tree,
// never a name looked up again on PATH (see pinnedCli in the launcher below).
function pinnedCommand(options, name) {
  if (typeof options?.command !== 'string' || !path.isAbsolute(options.command)) {
    throw refusal('HOST_WORKER_CLI_UNAVAILABLE',
      `The ${name} CLI was not found on PATH outside the project and temporary folders, so no ${name} subagent was started. Install it or fix PATH, then start a new session.`);
  }
  return options;
}

function createHostWorkerLauncher({ env = process.env, config, workspaceRoot, socketPath,
  startCodex = options => require('./agent-engine/codex-process').startCodexSession(pinnedCommand(options, 'codex')),
  resumeCodex = options => require('./agent-engine/codex-process').resumeCodexSession(pinnedCommand(options, 'codex')),
  startClaude = options => require('./agent-engine/claude-cli-process').startClaudeSession(pinnedCommand(options, 'claude')),
  resumeClaude = options => require('./agent-engine/claude-cli-process').resumeClaudeSession(pinnedCommand(options, 'claude')),
  checkNative = () => require('./host-worker-prerequisite').requireHostWorkerNative(),
  agentApiMode = () => require('./agent-api-policy').agentApiMode({ env }),
  listCodexMcp = listCodexMcpServers,
  listCodexModels = listCodexModelCatalog,
  resolveCli = name => launchPolicy.resolveAgentCli(name, { env, workspace: workspaceRoot }),
  checkCli = file => launchPolicy.assertAgentCliPath(file, { env, workspace: workspaceRoot }),
} = {}) {
  requireEnabled(config, env);
  // Each CLI is found once, when this tree's launcher is made, from PATH with
  // every folder a subagent can write skipped, and that absolute path is the
  // only program launched afterwards. A program a subagent plants later on
  // PATH is never picked up; the pinned one is checked again before each use.
  const pinned = new Map();
  const pinnedCli = name => {
    if (!pinned.get(name)) {
      let found = null;
      try { found = resolveCli(name); } catch { found = null; }
      if (typeof found === 'string' && path.isAbsolute(found)) pinned.set(name, found);
    }
    const file = pinned.get(name) || null;
    if (file) checkCli(file);
    return file;
  };
  for (const name of ['codex', 'claude']) { try { pinnedCli(name); } catch { /* checked again at start */ } }
  async function start(spec) {
    requireEnabled(config, env);
    if (!['codex', 'claude'].includes(spec.provider)) throw refusal('HOST_WORKER_PROVIDER_UNSUPPORTED', 'Host workers use Codex or Claude Code.');
    checkNative();
    const apiMode = typeof agentApiMode === 'function' ? agentApiMode() : agentApiMode;
    if (!MODES.includes(apiMode)) throw refusal('AGENT_API_MODE_UNAVAILABLE', 'The saved Agent API mode is unavailable.');
    if (apiMode === 'Optimized' && spec.provider !== 'claude') throw refusal('AGENT_OPTIMIZED_TOOLS_UNSUPPORTED', 'Optimized Agent API mode supports Claude only.');
    const command = pinnedCli(spec.provider);
    // The person's standing rules travel outside the task text: Claude's
    // system prompt or Codex's developer instructions (see below).
    const standingRules = typeof spec.standingRules === 'string' && spec.standingRules.trim() ? spec.standingRules : null;
    const tokenFile = path.join(spec.nodeFolder, 'link-token');
    const entry = hostWorkerEntry({ env, config, provider: spec.provider, socketPath, spec, tokenFile });
    writePrivate(tokenFile, `${spec.linkToken}\n`, config.stateRoot);
    const common = { cwd: workspaceRoot, env: cliEnvironment(env, workspaceRoot), onEvent: spec.onEvent, containProcessTree: true,
      ...(command ? { command } : {}) };
    if (spec.provider === 'codex') {
      const events = codexEvents(spec.onEvent);
      const beforeThread = async adapter => {
        if (spec.threadId) {
          let saved;
          try { saved = await adapter.readThread(spec.threadId, { includeTurns: false }); }
          catch { throw refusal('HOST_WORKER_WORKSPACE_UNVERIFIED',
            'Codex could not read the saved thread workspace before resume; the thread may have been deleted. Start a fresh worker in this workspace.'); }
          if (typeof saved?.cwd !== 'string' || path.resolve(saved.cwd) !== path.resolve(workspaceRoot)) {
            throw refusal('HOST_WORKER_WORKSPACE_MISMATCH',
              'The saved Codex thread belongs to another workspace. Start a new worker in this workspace.');
          }
        }
        let layers;
        try { layers = await adapter.readConfigLayers({ cwd: workspaceRoot }); }
        catch (error) {
          const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
            ? ` (${error.code})` : '';
          throw refusal('HOST_WORKER_POLICY_UNVERIFIED', `Codex did not confirm project-local configuration before worker start${code}.`);
        }
        if (!Array.isArray(layers) || layers.some(layer => !layer || !layer.name
            || typeof layer.name.type !== 'string'
            || !Object.hasOwn(layer, 'disabledReason')
            || layer.disabledReason !== null && typeof layer.disabledReason !== 'string'
            || layer.name.type === 'project' && !(typeof layer.disabledReason === 'string' && layer.disabledReason.length > 0))) {
          throw refusal('HOST_WORKER_POLICY_WIDE', 'Codex enabled or could not verify a project-local configuration layer.');
        }
      };
      const overrides = codexOverrides(entry, apiMode, workspaceRoot);
      const mcpOff = confineCodexMcpServers({ list: listCodexMcp, args: overrides, env: common.env,
        cwd: workspaceRoot, fleetEnabled: apiMode !== 'Disabled', command });
      const catalog = confineCodexModelCatalog({ list: listCodexModels, args: [...overrides, ...mcpOff], env: common.env,
        cwd: workspaceRoot, command, apiMode, model: spec.model || null, file: path.join(spec.nodeFolder, 'codex-models.json'),
        root: config.stateRoot });
      // Codex's documented developer_instructions: a developer message of its
      // own, which the parent's task text cannot write. Set for the app-server
      // and again on the thread start or resume itself.
      const rulesArgs = standingRules ? ['-c', `developer_instructions=${tomlString(standingRules)}`] : [];
      const options = { ...common, onEvent: events.onEvent, clientInfo: { name: 'toolsenabled-host', title: 'ToolsEnabled Fleet', version: '1' },
        args: ['app-server', ...overrides, ...mcpOff, ...catalog, ...rulesArgs],
        beforeThread, threadOptions: {
          ...(spec.model ? { model: spec.model } : {}),
          sandbox: 'workspace-write', approvalPolicy: 'never',
          ...(standingRules ? { developerInstructions: standingRules } : {}) } };
      const session = spec.threadId ? await resumeCodex({ ...options, threadId: spec.threadId, threadProvider: 'codex' }) : await startCodex(options);
      if (spec.threadId && (typeof session.threadCwd !== 'string'
          || path.resolve(session.threadCwd) !== path.resolve(workspaceRoot))) {
        session.close();
        throw refusal('HOST_WORKER_WORKSPACE_MISMATCH', 'The saved Codex thread belongs to another workspace. Start a new worker in this workspace.');
      }
      events.bind(session);
      const sandbox = session.resolvedSandbox;
      let rootsSafe = sandbox?.type === 'workspaceWrite' && sandbox.networkAccess === false
        && Array.isArray(sandbox.writableRoots)
        && sandbox.excludeSlashTmp === true && sandbox.excludeTmpdirEnvVar === true;
      if (rootsSafe) {
        for (const root of sandbox.writableRoots) {
          if (typeof root !== 'string' || !path.isAbsolute(root)) { rootsSafe = false; break; }
          try { require('./workspace-boundary').assertInsideRoots(root, [workspaceRoot],
            { label: 'Codex writable root', tool: 'agent.spawn' }); }
          catch { rootsSafe = false; break; }
        }
      }
      if (!rootsSafe) {
        session.close();
        throw refusal('HOST_WORKER_POLICY_WIDE', 'Codex did not confirm workspace-only writes, with /tmp and $TMPDIR left out and network access off.');
      }
      let policy;
      try { policy = await session.adapter.readEffectivePolicy({ cwd: workspaceRoot }); }
      catch (error) {
        session.close();
        throw refusal('HOST_WORKER_POLICY_UNVERIFIED', `Codex did not confirm the Standard host policy: ${error.code || error.message}`);
      }
      if (!policy || !['read-only', 'workspace-write'].includes(policy.sandboxMode)
          || policy.approvalPolicy !== 'never') {
        session.close();
        throw refusal('HOST_WORKER_POLICY_WIDE', 'Codex did not keep workspace-write confinement with approvals disabled.');
      }
      if (spec.effort) {
        try { await session.adapter.updateThreadSettings(session.threadId, { effort: spec.effort }); }
        catch (error) { session.close(); throw error; }
      }
      // A resumed Codex thread keeps the developer instructions it started
      // with: neither developer_instructions nor the thread's own option
      // reaches the model on thread/resume (measured on codex-cli 0.160.0), so
      // the tree carries the current rules in the next turn instead.
      return Object.freeze({ ...session, apiMode, standingRulesDelivered: Boolean(standingRules) && !spec.threadId });
    }
    const mcpConfig = path.join(spec.nodeFolder, 'mcp.json');
    writePrivate(mcpConfig, JSON.stringify({ mcpServers: apiMode === 'Disabled' ? {} : { [SERVER_NAME]: { type: 'stdio', ...entry } } }) + '\n', config.stateRoot);
    if (workspaceRoot !== config.workspace || fs.realpathSync(workspaceRoot) !== workspaceRoot) {
      throw refusal('HOST_WORKSPACE_SYMLINK_REFUSED', 'The sealed Standard workspace changed before Claude started.');
    }
    const settings = path.join(spec.nodeFolder, 'settings.json');
    writePrivate(settings,
      JSON.stringify(require('./claude-workspace-file-tools').settings(SERVER_NAME,
        { serverEnabled: apiMode !== 'Disabled', workspaceRoot, pathDirectories: String(env.PATH || '').split(path.delimiter) })) + '\n', config.stateRoot);
    const options = { ...common, onEvent: claudeEvents(spec.onEvent, { workspaceRoot }),
      threadOptions: { ...(spec.model ? { model: spec.model } : {}), ...(spec.effort ? { effort: spec.effort } : {}) },
      // Standard replaces saved permission sources with exact workspace file rules.
      plan: { mcpConfig, settings,
        claudePermissionMode: 'dontAsk',
        agentApiMode: apiMode === 'Disabled' ? 'Enabled' : apiMode,
        roleFunctionsOnly: true, preserveSettingsSources: false,
        workspaceFileTools: true,
        ...(standingRules ? { standingRules } : {}) } };
    const session = spec.threadId ? await resumeClaude({ ...options, threadId: spec.threadId, threadProvider: 'claude' }) : await startClaude(options);
    // True when the system prompt carries the current rules, or on a resume
    // with none now, was rebuilt without earlier ones.
    return Object.freeze({ ...session, apiMode, standingRulesDelivered: session.standingRulesDelivered === true
      && (Boolean(standingRules) || Boolean(spec.threadId)) });
  }
  return Object.freeze({ start });
}

module.exports = { createHostWorkerLauncher, hostWorkerEntry, HOST_SESSION_ENV, STANDARD_CODEX_FEATURES_OFF, listCodexMcpServers,
  listCodexModelCatalog };
