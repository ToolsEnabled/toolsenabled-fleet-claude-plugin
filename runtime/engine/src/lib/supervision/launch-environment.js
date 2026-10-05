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

// Provider sign-in and endpoint variables. Fleet never carries a provider's key,
// token or endpoint: credentialFreeEnvironment() removes them for Fleet's own
// helper processes and agentCliEnvironment() removes them for the agent CLIs it
// starts, which sign in by their own saved login. assertNoBillingCredentials()
// refuses a helper launch where a variable marked `tripwire: true` survived.
// `tripwire: false` marks selectors such as a region that are removed but are
// not themselves a secret or endpoint. The Gemini and Grok entries stay so that
// keys a person set for those tools never reach Fleet's processes either.
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
// CLAUDE_CONFIG_DIR and CODEX_HOME are kept, so each CLI finds its own saved
// login; provider sign-in variables are removed (agentCliEnvironment below).
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

// A name that says it holds a key, token, secret, password or credential, whoever
// the provider is and whatever its naming convention, so a CLI Fleet has no list
// for never receives one either. The word must stand alone in the name, between
// underscores or at either end: OPENAI_API_KEY, HF_TOKEN and DB_PASSWORD match,
// KEYBOARD_LAYOUT does not. A subagent has no use for any of them.
const CREDENTIAL_LIKE_NAME = /(?:^|_)(?:API_?KEY|AUTH_?TOKEN|ACCESS_?TOKEN|OAUTH_?TOKEN|BEARER_?TOKEN|SESSION_?TOKEN|SECRET_?(?:ACCESS_?)?KEY|PRIVATE_?KEY|TOKENS?|KEYS?|SECRETS?|PASSWORDS?|PASSWD|PASSPHRASES?|CREDENTIALS?)(?:_|$)/i;

/* The environment an agent CLI gets: the person's own, without the lead
   session's bindings and without any provider sign-in variable, so Fleet never
   carries a key, token or endpoint and each CLI signs in by its own saved login.
   A new object; the caller's is never changed. */
function agentCliEnvironment(baseEnvironment = process.env) {
  invalidEnvironment(baseEnvironment);
  const environment = withoutCredentialLikeNames(credentialFreeEnvironment(baseEnvironment));
  envScrub.deleteEnvMatching(environment, leadSessionBinding);
  return environment;
}

/* The same environment under its earlier name, which the plugin's setup
   sign-in check calls. */
const subscriptionLaunchEnvironment = agentCliEnvironment;

/* The names listed for each provider, removed whole and without regard to case. */
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

/* Also without any name that says it holds a key or token. */
function withoutCredentialLikeNames(environment) {
  envScrub.deleteEnvMatching(environment, name => CREDENTIAL_LIKE_NAME.test(String(name)));
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
  return assertNoBillingCredentials(withoutCredentialLikeNames(credentialFreeEnvironment(baseEnvironment)), { context });
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
  confinedAgentCliEnvironment,
  assertNoBillingCredentials,
  credentialFreeEnvironment,
  leadSessionBinding,
  resolveAgentCli,
  safeLaunchEnvironment,
  subagentWritableRoots,
  subscriptionLaunchEnvironment
});
