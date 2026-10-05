'use strict';

// Dependency-light child environment policy, in two parts.
//
// AN AGENT CLI (claude, codex) THAT FLEET STARTS AS A SUBAGENT runs on the
// person's own sign-in, exactly as it would from their terminal. Its own
// authentication variables (API keys, Bedrock, Vertex, Foundry, AWS and the
// like) are passed through unchanged, because restricting a CLI's built-in
// sign-in methods is not Fleet's to do. What is removed is only what binds a
// process to the lead session that started Fleet: its session ids, messaging
// socket, host sign-in refresh, IDE binding and Fleet's own internal variables.
// agentCliEnvironment() is that environment; the plugin's setup sign-in check
// uses the same function, so setup and subagents see one environment.
//
// EVERY OTHER HELPER PROCESS (process listings, audit file inspection, host
// commands) needs no provider credential, so safeLaunchEnvironment() removes
// them and refuses a launch where one survived.
//
// This module stays loadable while provider and fleet code is broken or
// mid-edit: it depends only on built-ins and the env-scrub helper.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const envScrub = require('../env-scrub.js');

const SUBSCRIPTION_PROVIDER_IDS = Object.freeze(['codex', 'claude', 'gemini', 'grok']);

// Provider sign-in and endpoint variables that Fleet's own helper processes
// never need. Agent CLIs keep all of them (agentCliEnvironment below);
// credentialFreeEnvironment() removes them from every other helper, and
// assertNoBillingCredentials() refuses a helper launch where a variable marked
// `tripwire: true` survived. `tripwire: false` marks selectors such as a region
// that are removed but are not themselves a secret or endpoint. Fleet starts
// only claude and codex; the Gemini and Grok entries stay so that keys a person
// set for those tools never reach Fleet's helpers either.
const ENVIRONMENT_RULES = Object.freeze([
  ['ANTHROPIC_API_KEY', 'claude', true],
  ['ANTHROPIC_AUTH_TOKEN', 'claude', true],
  ['ANTHROPIC_BASE_URL', 'claude', true],
  ['CLAUDE_CODE_OAUTH_TOKEN', 'claude', true],
  ['CLAUDE_CODE_USE_BEDROCK', 'claude', true],
  ['CLAUDE_CODE_USE_VERTEX', 'claude', true],
  ['CLAUDE_CODE_USE_FOUNDRY', 'claude', true],
  ['AWS_BEARER_TOKEN_BEDROCK', 'claude', true],
  ['AWS_BEDROCK_API_KEY', 'claude', true],
  ['AWS_ACCESS_KEY_ID', 'claude', true],
  ['AWS_SECRET_ACCESS_KEY', 'claude', true],
  ['AWS_SESSION_TOKEN', 'claude', true],
  ['OPENAI_API_KEY', 'codex', true],
  ['OPENAI_BASE_URL', 'codex', true],
  ['CODEX_API_KEY', 'codex', true],
  ['CODEX_ACCESS_TOKEN', 'codex', true],
  ['GEMINI_API_KEY', 'gemini', true],
  ['GOOGLE_API_KEY', 'gemini', true],
  ['GOOGLE_GENAI_USE_VERTEXAI', 'gemini', true],
  ['XAI_API_KEY', 'grok', true],
  ['GROK_API_KEY', 'grok', true],
  ['GROK_API_BASE_URL', 'grok', true],
  ['GROK_CLI_CHAT_PROXY_BASE_URL', 'grok', true],
  ['GROK_AUTH_TOKEN', 'grok', true],
  ['AWS_PROFILE', 'claude', false],
  ['AWS_REGION', 'claude', false],
  ['AWS_DEFAULT_REGION', 'claude', false],
  ['GOOGLE_CLOUD_PROJECT', 'gemini', false],
  ['GOOGLE_CLOUD_LOCATION', 'gemini', false]
].map(([name, provider, tripwire]) => Object.freeze({ name, provider, tripwire })));

const PROVIDER_ENVIRONMENT_NAMES = Object.freeze(Object.fromEntries(
  SUBSCRIPTION_PROVIDER_IDS.map(provider => [provider, Object.freeze(
    ENVIRONMENT_RULES.filter(rule => rule.provider === provider).map(rule => rule.name)
  )])
));
const BILLING_TRIPWIRE = Object.freeze(
  ENVIRONMENT_RULES.filter(rule => rule.tripwire).map(rule => rule.name)
);

class LaunchEnvironmentError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'LaunchEnvironmentError';
    this.code = code;
    this.details = details;
  }
}

function invalidEnvironment(baseEnvironment) {
  if (!baseEnvironment || typeof baseEnvironment !== 'object') {
    throw new LaunchEnvironmentError(
      'LAUNCH_ENVIRONMENT_INVALID',
      'A launch environment could not be constructed.'
    );
  }
}

// Variables that bind a process to the agent session or app that started
// Fleet: session ids, a messaging socket, sign-in refresh provided by the host,
// account ids, host-only tools, the parent's IDE connection and the person's
// terminal multiplexer and agent sockets. A subagent is its own CLI session on
// its own sign-in, so none of them are passed on. Sign-in locations such as
// CLAUDE_CONFIG_DIR and CODEX_HOME, and the CLIs' own sign-in variables, are
// kept.
const LEAD_SESSION_ENV = Object.freeze(new Set([
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_HOST_SESSION_ID',
  'CLAUDE_CODE_REMOTE_SESSION_ID', 'CLAUDE_CODE_BRIDGE_SESSION_ID', 'CLAUDE_CODE_CLOUD_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH', 'CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH', 'CLAUDE_CODE_HOST_AUTH_ENV_VAR',
  'CLAUDE_CODE_HOST_AUTH_REFRESH_TIMEOUT_MS', 'CLAUDE_CODE_HOST_CREDS_FILE', 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_SESSION_ACCESS_TOKEN', 'CLAUDE_BRIDGE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_OAUTH_SCOPES', 'CLAUDE_CODE_ORGANIZATION_UUID', 'CLAUDE_CODE_ACCOUNT_UUID',
  'CLAUDE_CODE_BRIDGE_OWNER_ACCOUNT_UUID', 'USE_STAGING_OAUTH', 'USE_LOCAL_OAUTH',
  'CLAUDE_CODE_DESKTOP_APP_VERSION', 'CLAUDE_AGENT_SDK_VERSION', 'CLAUDE_CODE_TERMINAL_MCP_TOOLS',
  'CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL', 'CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES',
  'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING', 'CLAUDE_CODE_REPORT_FINDINGS', 'CLAUDE_CODE_EAGER_FLUSH',
  'CLAUDE_CODE_SSE_PORT', 'ENABLE_IDE_INTEGRATION',
  'CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA', 'CLAUDE_PROJECT_DIR', 'CLAUDE_ENV_FILE',
  'MCP_CONNECTION_NONBLOCKING', 'MCP_SERVER_CONNECTION_BATCH_SIZE', 'AI_AGENT', 'SENTRY-TRACE', 'BAGGAGE',
  'CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_CI',
  'SSH_AUTH_SOCK', 'GPG_AGENT_INFO', 'TMUX', 'TMUX_PANE',
  'OPENSHELL_SANDBOX', 'TOOLSENABLED_AGENT_ID', 'TOOLSENABLED_AGENT_ACTOR',
]));
// Whole families: the parent's IDE binding and Fleet's own internal routing.
const LEAD_SESSION_PREFIXES = Object.freeze(['CLAUDE_CODE_IDE_', 'VSCODE_', 'TOOLSENABLED_OPENSHELL_', 'TOOLSENABLED_HOST_']);

function leadSessionBinding(name) {
  const upper = String(name).toUpperCase();
  return LEAD_SESSION_ENV.has(upper) || LEAD_SESSION_PREFIXES.some(prefix => upper.startsWith(prefix));
}

/* The environment an agent CLI gets: the person's own, without the lead
   session's bindings. A new object; the caller's is never changed. */
function agentCliEnvironment(baseEnvironment = process.env) {
  invalidEnvironment(baseEnvironment);
  const environment = { ...baseEnvironment };
  envScrub.deleteEnvMatching(environment, leadSessionBinding);
  return environment;
}

/* The same environment under its earlier name, which the plugin's setup
   sign-in check calls. */
const subscriptionLaunchEnvironment = agentCliEnvironment;

/* A helper process that is not an agent CLI gets no provider credential. */
function credentialFreeEnvironment(baseEnvironment = process.env) {
  invalidEnvironment(baseEnvironment);
  // Each spread leaves the caller's environment unchanged; envScrub matches
  // names without regard to case and includes inherited keys.
  let environment = { ...baseEnvironment };
  for (const providerId of SUBSCRIPTION_PROVIDER_IDS) {
    environment = envScrub.deleteEnvNames(
      { ...environment }, PROVIDER_ENVIRONMENT_NAMES[providerId]
    );
  }
  return environment;
}

function assertNoBillingCredentials(environment, { context = '' } = {}) {
  if (environment === null || environment === undefined) {
    throw new LaunchEnvironmentError(
      'LAUNCH_ENVIRONMENT_INHERITS_AMBIENT',
      `Refusing to start a helper process${context ? ` (${context})` : ''}: the launch environment is ${String(environment)}, which node treats as "inherit the full ambient environment" -- including every credential this scrub exists to remove.`,
      { variables: [] }
    );
  }
  const leaked = envScrub.presentEnvNames(environment, BILLING_TRIPWIRE);
  if (leaked.length > 0) {
    throw new LaunchEnvironmentError(
      'LAUNCH_BILLING_CREDENTIAL_PRESENT',
      `Refusing to start a helper process${context ? ` (${context})` : ''}: ${leaked.join(', ')} survived the environment scrub, and Fleet's helper processes run without provider credentials.`,
      { variables: leaked }
    );
  }
  return environment;
}

function safeLaunchEnvironment(baseEnvironment = process.env, { context = '' } = {}) {
  return assertNoBillingCredentials(credentialFreeEnvironment(baseEnvironment), { context });
}

/* WHERE AN AGENT CLI IS, found the way the person's terminal finds it -- the
 * first match on PATH -- except that no folder a subagent can write is ever
 * searched. A Codex subagent can create an executable file in the project, and
 * Fleet starts the CLIs outside any sandbox, so a `codex` or `claude` planted
 * in a project folder that happens to be on PATH (an activated .venv/bin,
 * direnv's PATH_add, node_modules/.bin, an empty or relative entry meaning
 * the working folder) must never be the one Fleet runs. Skipped: empty and
 * relative entries, and every entry inside the project, /tmp, $TMPDIR or the
 * system temporary folder, by lexical path and by real path. A match whose
 * real path lies inside one of those is skipped as well.
 *
 * Returns the absolute path as found on PATH (so a CLI that updates itself by
 * moving a link keeps working), or null when no safe match exists. Callers pin
 * the answer once and launch only that path; assertAgentCliPath() checks a
 * pinned path again before each launch. */
const AGENT_CLI_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function realOrSelf(value) {
  try { return fs.realpathSync(value); } catch { return value; }
}

function subagentWritableRoots({ env = process.env, workspace = null, extraRoots = [] } = {}) {
  const roots = ['/tmp', os.tmpdir(), env && env.TMPDIR, env && env.TMP, env && env.TEMP, workspace, ...extraRoots]
    .filter(value => typeof value === 'string' && value.length > 0 && path.isAbsolute(value))
    .map(value => path.resolve(value));
  return [...new Set(roots.flatMap(root => [root, realOrSelf(root)]))];
}

function insideAny(roots, candidate) {
  return roots.some(root => within(root, candidate));
}

function resolveAgentCli(name, { env = process.env, workspace = null, extraRoots = [] } = {}) {
  if (typeof name !== 'string' || !AGENT_CLI_NAME.test(name)) return null;
  const roots = subagentWritableRoots({ env, workspace, extraRoots });
  for (const folder of String((env && env.PATH) || '').split(path.delimiter)) {
    if (!folder || !path.isAbsolute(folder)) continue;
    const lexical = path.resolve(folder);
    if (insideAny(roots, lexical) || insideAny(roots, realOrSelf(lexical))) continue;
    const candidate = path.join(lexical, name);
    let real;
    try {
      real = fs.realpathSync(candidate);
      fs.accessSync(real, fs.constants.X_OK);
      if (!fs.statSync(real).isFile()) continue;
    } catch { continue; }
    if (insideAny(roots, real)) continue;
    return candidate;
  }
  return null;
}

/* THE PATH AN AGENT CLI, AND EVERY HELPER FLEET STARTS FOR IT, RUNS WITH: the
 * person's PATH without the folders resolveAgentCli() never searches (empty and
 * relative entries, and entries inside the project, /tmp, $TMPDIR or the system
 * temporary folder, by lexical and by real path). Pinning the CLI itself is not
 * enough: an npm-installed `claude` or `codex` starts with
 * `#!/usr/bin/env node`, which looks `node` up on the PATH it is given, so a
 * `node` planted in a project folder on PATH (an activated .venv/bin,
 * node_modules/.bin) would run outside any sandbox. When no entry is left the
 * system folders are used, because an empty PATH means the working folder. */
function agentSearchPath({ env = process.env, workspace = null, extraRoots = [] } = {}) {
  const roots = subagentWritableRoots({ env, workspace, extraRoots });
  const kept = [];
  for (const folder of String((env && env.PATH) || '').split(path.delimiter)) {
    if (!folder || !path.isAbsolute(folder)) continue;
    const lexical = path.resolve(folder);
    if (insideAny(roots, lexical) || insideAny(roots, realOrSelf(lexical))) continue;
    if (!kept.includes(lexical)) kept.push(lexical);
  }
  return (kept.length ? kept : ['/usr/bin', '/bin']).join(path.delimiter);
}

/* agentCliEnvironment() with that PATH. A new object; the caller's is never
   changed. */
function confinedAgentCliEnvironment(baseEnvironment = process.env, { workspace = null, extraRoots = [] } = {}) {
  const environment = agentCliEnvironment(baseEnvironment);
  environment.PATH = agentSearchPath({ env: baseEnvironment, workspace, extraRoots });
  return environment;
}

/* THE PERSON'S OWN CLAUDE SIGN-IN SETTINGS, FOR A CLAUDE SUBAGENT.
 *
 * Fleet starts a Claude subagent without the person's settings files, so a
 * project's or a user's configuration cannot widen what it may do. That also
 * dropped every sign-in the person configured in their user settings file: an
 * apiKeyHelper, a cloud provider's credential commands, or Bedrock, Vertex or
 * Foundry switches in the file's env block. Measured with `claude auth status`
 * (Claude Code 2.1.289): signed in with the settings file, signed out with
 * --setting-sources '' or --restricted, signed in again once the same keys are
 * passed inline through --settings.
 *
 * So the subagent gets back those keys and nothing else of that file:
 *   - only the USER settings file (CLAUDE_CONFIG_DIR, else ~/.claude), never a
 *     project or local file, which a repository could supply;
 *   - only a fixed list of sign-in commands, passed inline through --settings
 *     (a command is not a secret);
 *   - only env entries whose names are provider sign-in or endpoint variables.
 *     Their values go to the child's process environment, in memory: never on
 *     a command line, never written to disk. A variable already set in the
 *     person's environment wins, as it does in their terminal.
 * A file that is not a plain file owned by this account, is writable by others,
 * lies in a folder a subagent can write, or is over 1 MiB gives nothing. */
const AUTH_SETTING_COMMANDS = Object.freeze(['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'gcpAuthRefresh']);
const AUTH_SETTING_ENV = Object.freeze([
  /^CLAUDE_CODE_USE_(?:BEDROCK|VERTEX|FOUNDRY)$/,
  /^CLAUDE_CODE_SKIP_(?:BEDROCK|VERTEX|FOUNDRY)_AUTH$/,
  /^ANTHROPIC_(?:API_KEY|AUTH_TOKEN|BASE_URL)$/,
  /^ANTHROPIC_(?:BEDROCK|VERTEX|FOUNDRY|AWS)_[A-Z0-9_]{1,60}$/,
  /^ANTHROPIC_VERTEX_PROJECT_ID$/,
  /^ANTHROPIC_(?:DEFAULT_(?:OPUS|SONNET|HAIKU|FABLE)_MODEL|SMALL_FAST_MODEL)$/,
  /^CLAUDE_CODE_OAUTH_TOKEN$/,
  /^AWS_[A-Z0-9_]{1,60}$/,
  /^CLOUD_ML_REGION$/, /^VERTEX_REGION_[A-Z0-9_]{1,40}$/, /^GOOGLE_APPLICATION_CREDENTIALS$/, /^GCLOUD_PROJECT$/, /^GOOGLE_CLOUD_PROJECT$/,
]);
const MAX_AUTH_SETTINGS_BYTES = 1024 * 1024;
const MAX_AUTH_VALUE = 8192;

function readUserAuthSettings({ env = process.env, workspace = null, extraRoots = [] } = {}) {
  const none = reason => Object.freeze({ settings: Object.freeze({}), env: Object.freeze({}), note: reason || null });
  const home = (env && env.HOME) || os.homedir();
  const folder = env && typeof env.CLAUDE_CONFIG_DIR === 'string' && env.CLAUDE_CONFIG_DIR ? env.CLAUDE_CONFIG_DIR : path.join(home, '.claude');
  if (!path.isAbsolute(folder)) return none('Claude Code\'s configuration folder is not a full path');
  const file = path.join(folder, 'settings.json');
  let real;
  let stat;
  try { real = fs.realpathSync(file); stat = fs.statSync(real); } catch { return none(null); }
  if (!stat.isFile()) return none('the user settings file is not a regular file');
  /* Owned by this account, and writable by NOBODY else. An earlier release
   * accepted a group-writable file when its gid matched this process's primary
   * group, reasoning that a private per-user group is just a umask of 002. The
   * gid match does not prove the group is private: macOS gives every local user
   * `staff`, SUSE a shared `users`, and site setups routinely hand out a shared
   * default group -- and umask 002 is deployed precisely on those systems, so the
   * configurations where the allowance fired were the ones where its premise
   * failed. There, mode 0664 lets another account rewrite this file, and Fleet
   * would run the sign-in commands it names as the person and take an
   * ANTHROPIC_BASE_URL from it. Node cannot enumerate a group's members, so there
   * is nothing here to check against: refuse, and say how to fix it. */
  if (typeof process.getuid === 'function' && (stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0)) {
    return none('the user settings file is not owned by this account or can be changed by others (run chmod 600 on it)');
  }
  if (stat.size > MAX_AUTH_SETTINGS_BYTES) return none('the user settings file is over 1 MiB');
  const roots = subagentWritableRoots({ env, workspace, extraRoots });
  if (insideAny(roots, real)) return none('the user settings file is in a folder a subagent can write');
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(real, 'utf8')); } catch { return none('the user settings file is not valid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return none(null);
  const settings = {};
  const relative = [];
  const writable = [];
  for (const key of AUTH_SETTING_COMMANDS) {
    const command = parsed[key];
    if (typeof command !== 'string' || command.length === 0 || command.length > MAX_AUTH_VALUE) continue;
    // A command named by a relative path would run from the subagent's working
    // folder, which the subagent can write. A full path, ~/ or a bare name found
    // on the (filtered) PATH is the person's own program.
    const program = command.trim().split(/\s+/)[0];
    const named = program.startsWith('~/') ? path.join(home, program.slice(2)) : program;
    if (program.includes('/') && !path.isAbsolute(named)) { relative.push(key); continue; }
    /* A program Fleet is willing to name is also a program a subagent must not be
     * able to rewrite. The agent never needs to touch settings.json for that: it
     * only has to edit the helper the file points at, and the next launch runs it
     * as the person. So a named command gets the same writable-root exclusion
     * assertAgentCliPath applies to the agent CLI. A bare name needs no check
     * here -- it is found on agentSearchPath, which already drops those roots. */
    if (path.isAbsolute(named) && (insideAny(roots, path.resolve(named)) || insideAny(roots, realOrSelf(named)))) { writable.push(key); continue; }
    settings[key] = command;
  }
  const login = parsed.forceLoginMethod;
  if (login === 'claudeai' || login === 'console') settings.forceLoginMethod = login;
  const variables = {};
  const block = parsed.env;
  if (block && typeof block === 'object' && !Array.isArray(block)) {
    for (const [name, value] of Object.entries(block)) {
      if (typeof value !== 'string' || value.length === 0 || value.length > MAX_AUTH_VALUE || /[\0\r\n]/.test(value)) continue;
      if (!AUTH_SETTING_ENV.some(pattern => pattern.test(name))) continue;
      if (env && Object.hasOwn(env, name)) continue;
      variables[name] = value;
    }
  }
  const notes = [];
  if (relative.length) notes.push(`${relative.join(' and ')} names a program by a relative path, which Fleet does not run from a subagent's folder (use a full path)`);
  if (writable.length) notes.push(`${writable.join(' and ')} names a program inside a folder a subagent can write, so Fleet will not run it (move it outside the workspace and the temporary folders)`);
  return Object.freeze({ settings: Object.freeze(settings), env: Object.freeze(variables),
    note: notes.length ? notes.join('; ') : null });
}

/* The environment and the --settings keys a Claude subagent, and the setup
   sign-in check, run with. A new environment object; the caller's is unchanged. */
function claudeAuthLaunch(baseEnvironment, { workspace = null, extraRoots = [] } = {}) {
  const found = readUserAuthSettings({ env: baseEnvironment, workspace, extraRoots });
  return Object.freeze({ env: { ...baseEnvironment, ...found.env }, settings: found.settings, note: found.note });
}

/* A pinned CLI path, checked again just before a launch: still absolute,
   still an executable file, and neither it nor its real path inside a folder
   a subagent can write. */
function assertAgentCliPath(file, { env = process.env, workspace = null, extraRoots = [] } = {}) {
  const refuse = () => {
    throw new LaunchEnvironmentError('LAUNCH_AGENT_CLI_UNSAFE',
      'The agent CLI Fleet pinned for subagents is missing or now lies in a folder subagents can write, so nothing was started. Start a new session.');
  };
  if (typeof file !== 'string' || !path.isAbsolute(file)) refuse();
  const roots = subagentWritableRoots({ env, workspace, extraRoots });
  let real;
  try {
    real = fs.realpathSync(file);
    fs.accessSync(real, fs.constants.X_OK);
    if (!fs.statSync(real).isFile()) refuse();
  } catch (error) {
    if (error instanceof LaunchEnvironmentError) throw error;
    refuse();
  }
  if (insideAny(roots, path.resolve(file)) || insideAny(roots, real)) refuse();
  return file;
}

module.exports = Object.freeze({
  BILLING_TRIPWIRE,
  LEAD_SESSION_ENV,
  LEAD_SESSION_PREFIXES,
  LaunchEnvironmentError,
  PROVIDER_ENVIRONMENT_NAMES,
  SUBSCRIPTION_PROVIDER_IDS,
  agentCliEnvironment,
  agentSearchPath,
  assertAgentCliPath,
  claudeAuthLaunch,
  readUserAuthSettings,
  confinedAgentCliEnvironment,
  assertNoBillingCredentials,
  credentialFreeEnvironment,
  leadSessionBinding,
  resolveAgentCli,
  safeLaunchEnvironment,
  subagentWritableRoots,
  subscriptionLaunchEnvironment
});
