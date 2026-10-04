'use strict';

/* WHAT A PROVIDER CLI ON THIS COMPUTER IS, AND WHAT IT SUPPORTS.
 *
 * One row per agent program says how to recognize a copy and which options or
 * protocol methods the engine uses:
 *   - describeCopy() says which copy a path is: its `channel` (toolsenabled,
 *     npm-global, native, standalone, unknown), `owner` (toolsenabled or
 *     person) and `version`, read from package.json or the version folder
 *     name.
 *   - featuresFromHelp() and evaluateFeatures() turn what a probe found into
 *     one word from FEATURE_STATES. A version number is shown, and never
 *     admits or refuses a start. recallProbe() and rememberProbe() keep that
 *     answer per copy.
 *   - isOwnedPath() and selfUpdateEnvironment() turn off a program's own
 *     updater only for a copy inside the ToolsEnabled-owned providers folder;
 *     a copy the person installed keeps updating itself the way they set it up.
 *
 * WHAT THIS MODULE READS. File metadata (stat, realpath) and, by fixed name
 * only, a program's own package.json, capped at 64 KiB. It never reads a
 * sign-in file, never starts, installs or updates a program, and makes no
 * network call.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FEATURE_STATES = Object.freeze(['ready', 'ready-with-limits', 'update-needed', 'not-installed', 'unknown']);
const CHANNELS = Object.freeze(['toolsenabled', 'npm-global', 'native', 'standalone', 'unknown']);
const OWNERS = Object.freeze(['toolsenabled', 'person']);

const SMALL_FILE_LIMIT = 64 * 1024;
const VERSION_PATTERN = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,64})?$/;

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

/* A FEATURE is one option or protocol method the engine uses.
 *   name      what the screen and receipt call it
 *   any       the spellings that count as present (an older and a newer
 *             spelling of one option, for example)
 *   required  true: a start cannot work without it (update-needed);
 *             false: the engine drops that argument and says so
 *             (ready-with-limits). */
function feature(name, required, any = [name]) {
  return { name, required, any };
}

/* THE TABLE. One row per program.
 *
 *   npmPackage        the official npm package, or null when there is none
 *   nativeLayouts     where the maker's own installer keeps versions, relative
 *                     to the login home; `version` says how a version is read
 *   selfUpdateOff     how to turn off the program's self-update in a session
 *                     that uses a ToolsEnabled-owned copy ({ env } or { args })
 *   features          { probe, list } -- see feature(); `probe` names how the
 *                     caller asks (help, app-server-schema)
 */
const PROVIDER_TOOLCHAIN = deepFreeze({
  claude: {
    id: 'claude',
    label: 'Claude Code',
    npmPackage: '@anthropic-ai/claude-code',
    /* Claude's native installer: ~/.local/bin/claude -> ~/.local/share/claude/versions/<version>,
       one FILE per version (for example 2.1.277, 2.1.278, 2.1.280). */
    nativeLayouts: [{ channel: 'native', under: ['.local', 'share', 'claude', 'versions'], version: 'segment' },
      { channel: 'native', under: ['.claude', 'local'], version: 'package' }],
    selfUpdateOff: { env: { DISABLE_AUTOUPDATER: '1' } },
    /* Every option claude-cli-adapter.js passes, as `claude --help` of 2.1.280
       lists them. */
    features: {
      probe: 'help',
      list: [
        feature('--print', true), feature('--input-format', true), feature('--output-format', true),
        feature('--verbose', true), feature('--include-partial-messages', true),
        feature('--permission-mode', true), feature('--model', true), feature('--mcp-config', true),
        feature('--strict-mcp-config', true), feature('--settings', true), feature('--tools', true),
        feature('--setting-sources', true), feature('--disable-slash-commands', true),
        feature('--restricted', false),
        feature('--session-id', true), feature('--resume', true), feature('--fork-session', true),
        feature('--effort', false),
      ],
    },
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    npmPackage: '@openai/codex',
    /* Codex's standalone installer: ~/.local/bin/codex ->
       ~/.codex/packages/standalone/releases/<version>-<target>/bin/codex. */
    nativeLayouts: [{ channel: 'standalone', under: ['.codex', 'packages', 'standalone', 'releases'], version: 'segment-before-target' }],
    selfUpdateOff: null,
    /* The app-server methods the adapter uses, from the Codex app-server
       schema. Optional ones have a -32601 fallback. */
    features: {
      probe: 'app-server-schema',
      list: [
        feature('initialize', true), feature('thread/start', true), feature('thread/resume', true),
        feature('turn/start', true), feature('turn/interrupt', true),
        feature('item/agentMessage/delta', true), feature('item/started', true),
        feature('item/completed', true), feature('turn/completed', true),
        feature('thread/settings/update', false), feature('thread/read', false), feature('thread/fork', false),
        feature('model/list', false), feature('turn/steer', false), feature('config/read', false),
        feature('collaborationMode/list', false), feature('account/rateLimits/read', false),
      ],
    },
  },
});

function rowFor(providerId, client = null) {
  if (client != null) return null;
  return Object.hasOwn(PROVIDER_TOOLCHAIN, providerId) ? PROVIDER_TOOLCHAIN[providerId] : null;
}

function pathApiFor(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function defaultLoginHome() {
  try { return os.userInfo().homedir; } catch { return null; }
}

function absoluteFor(platform, value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0') && pathApiFor(platform).isAbsolute(value);
}

/* THE TOOLSENABLED-OWNED PROVIDERS FOLDER. Fleet installs nothing there; a
 * copy found there counts as ToolsEnabled-owned.
 *   Windows  %LOCALAPPDATA%\ToolsEnabled\providers
 *   Linux    $XDG_DATA_HOME/ToolsEnabled/providers, else <login home>/.local/share/ToolsEnabled/providers
 * TOOLSENABLED_PROVIDERS_ROOT (absolute) overrides both, for a test. Returns
 * null when no absolute folder can be named, and a caller then treats "owned
 * copy" as absent rather than guessing. */
function ownedProvidersRoot({ env = process.env, platform = process.platform, loginHome } = {}) {
  const paths = pathApiFor(platform);
  const override = env && env.TOOLSENABLED_PROVIDERS_ROOT;
  if (absoluteFor(platform, override)) return paths.normalize(override);
  if (platform === 'win32') {
    const local = env && env.LOCALAPPDATA;
    return absoluteFor(platform, local) ? paths.join(local, 'ToolsEnabled', 'providers') : null;
  }
  const xdg = env && env.XDG_DATA_HOME;
  if (absoluteFor(platform, xdg)) return paths.join(xdg, 'ToolsEnabled', 'providers');
  const home = loginHome === undefined ? defaultLoginHome() : loginHome;
  return absoluteFor(platform, home) ? paths.join(home, '.local', 'share', 'ToolsEnabled', 'providers') : null;
}

function inside(paths, parent, child) {
  const relative = paths.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !paths.isAbsolute(relative);
}

function readSmallJson(fsImpl, file) {
  try {
    if (typeof fsImpl.readFileSync !== 'function' || typeof fsImpl.statSync !== 'function') return null;
    const stat = fsImpl.statSync(file);
    if (!stat.isFile() || stat.size > SMALL_FILE_LIMIT) return null;
    const value = JSON.parse(String(fsImpl.readFileSync(file, 'utf8')));
    return value && typeof value === 'object' ? value : null;
  } catch { return null; }
}

function cleanVersion(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/^v/, '');
  return VERSION_PATTERN.test(trimmed) ? trimmed : null;
}

function realPathOf(fsImpl, file) {
  try { return typeof fsImpl.realpathSync === 'function' ? fsImpl.realpathSync(file) : file; } catch { return file; }
}

function statKey(fsImpl, file) {
  try {
    const stat = fsImpl.statSync(file);
    return { size: Number(stat.size) || 0, mtimeMs: Math.trunc(Number(stat.mtimeMs) || 0) };
  } catch { return { size: null, mtimeMs: null }; }
}

/* ---------- describing any copy ---------- */

function nativeLayoutMatch(row, realPath, { platform, loginHome, fsImpl }) {
  if (!absoluteFor(platform, loginHome)) return null;
  const paths = pathApiFor(platform);
  for (const layout of row.nativeLayouts || []) {
    const base = paths.join(loginHome, ...layout.under);
    if (!inside(paths, base, realPath)) continue;
    const first = paths.relative(base, realPath).split(paths.sep)[0];
    let version = null;
    if (layout.version === 'segment') version = cleanVersion(first);
    else if (layout.version === 'segment-before-target') version = cleanVersion(first.replace(/-(?:x86_64|aarch64|arm64|x64)-.*$/, ''));
    else if (layout.version === 'package') version = packageVersionAbove(row, realPath, { platform, fsImpl });
    return { channel: layout.channel, version };
  }
  return null;
}

/* The npm package a file belongs to: walk up at most six folders for a
 * package.json whose name is the row's package (or its per-platform native
 * package, like @anthropic-ai/claude-code-linux-x64). */
function packageVersionAbove(row, realPath, { platform, fsImpl }) {
  if (!row.npmPackage) return null;
  const paths = pathApiFor(platform);
  let dir = paths.dirname(realPath);
  for (let depth = 0; depth < 6; depth++) {
    const manifest = readSmallJson(fsImpl, paths.join(dir, 'package.json'));
    if (manifest && typeof manifest.name === 'string'
        && (manifest.name === row.npmPackage || manifest.name.startsWith(`${row.npmPackage}-`))) {
      return cleanVersion(manifest.version);
    }
    const parent = paths.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function describeCopy(providerId, file, { source = 'path', platform = process.platform, loginHome, fsImpl = fs, root = null, client = null } = {}) {
  const row = rowFor(providerId, client);
  if (!row) return null;
  const paths = pathApiFor(platform);
  const realPath = realPathOf(fsImpl, file);
  let channel = 'unknown';
  let owner = 'person';
  let version = null;
  if (root && inside(paths, root, realPath)) {
    channel = 'toolsenabled'; owner = 'toolsenabled';
    version = packageVersionAbove(row, realPath, { platform, fsImpl }) || null;
  } else {
    const native = nativeLayoutMatch(row, realPath, { platform, loginHome, fsImpl });
    if (native) { channel = native.channel; version = native.version || null; } else {
      const packaged = packageVersionAbove(row, realPath, { platform, fsImpl });
      if (packaged !== undefined) { channel = 'npm-global'; version = packaged || null; }
    }
  }
  return Object.freeze({
    path: file,
    realPath,
    source,
    channel,
    owner,
    version,
    script: /\.(?:c|m)?js$/i.test(realPath),
    launchable: platform !== 'win32' || /\.(?:exe|com)$/i.test(realPath),
    key: Object.freeze(statKey(fsImpl, realPath)),
  });
}

/* ---------- features ---------- */

function helpMentions(text, spelling) {
  if (!spelling.startsWith('-')) return new RegExp(`(^|\\s)${spelling.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(\\s|$)`, 'm').test(text);
  const escaped = spelling.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\\s,])${escaped}(?=[\\s,=<\\[]|$)`, 'm').test(text);
}

/* What one probe found, as the set of feature names present. For a `help`
 * probe that is the options named in the program's own --help; for a method
 * probe the caller passes the method names it saw. */
function featuresFromHelp(providerId, helpText, { client = null } = {}) {
  const row = rowFor(providerId, client);
  if (!row || typeof helpText !== 'string') return null;
  // Count option declarations, not descriptions that merely mention a flag.
  // Wrapped prose is more deeply indented than the option table itself.
  const optionLines = helpText.split(/\r?\n/).filter(line => /^\s*-{1,2}[A-Za-z]/.test(line));
  const optionIndent = optionLines.length ? Math.min(...optionLines.map(line => /^\s*/.exec(line)[0].length)) : 0;
  const declarations = optionLines.filter(line => /^\s*/.exec(line)[0].length === optionIndent)
    .map(line => line.trimStart().split(/\s{2,}/)[0]).join('\n');
  const present = new Set();
  for (const entry of row.features.list) if (entry.any.some(spelling => helpMentions(spelling.startsWith('-') ? declarations : helpText, spelling))) present.add(entry.name);
  return present;
}

/* One closed word per probe result. `present` null means the probe did not
 * produce an answer (timeout, crash): that is 'unknown', never 'update-needed'. */
function evaluateFeatures(providerId, present, { client = null, installed = true } = {}) {
  const row = rowFor(providerId, client);
  if (!row) return null;
  if (!installed) return deepFreeze({ state: 'not-installed', missingRequired: [], missingOptional: [], checked: 0 });
  if (!(present instanceof Set) || !row.features.list.length) {
    return deepFreeze({ state: 'unknown', missingRequired: [], missingOptional: [], checked: 0 });
  }
  const missingRequired = row.features.list.filter(entry => entry.required && !present.has(entry.name)).map(entry => entry.name);
  const missingOptional = row.features.list.filter(entry => !entry.required && !present.has(entry.name)).map(entry => entry.name);
  const state = missingRequired.length ? 'update-needed' : (missingOptional.length ? 'ready-with-limits' : 'ready');
  return deepFreeze({ state, missingRequired, missingOptional, checked: row.features.list.length });
}

/* Probe results are remembered per (realPath, size, mtime): an update made
 * outside the app changes the key, so the next start probes again. */
const probeMemo = new Map();
function probeCacheKey(copy) {
  if (!copy || !copy.realPath || !copy.key || copy.key.size == null) return null;
  return `${copy.realPath}\0${copy.key.size}\0${copy.key.mtimeMs}`;
}
function recallProbe(copy) {
  const key = probeCacheKey(copy);
  return key && probeMemo.has(key) ? probeMemo.get(key) : null;
}
function rememberProbe(copy, result) {
  const key = probeCacheKey(copy);
  if (!key || !result) return;
  if (probeMemo.size > 64) probeMemo.delete(probeMemo.keys().next().value);
  probeMemo.set(key, result);
}

/* ---------- self-update ---------- */

/* Environment additions that turn off the program's own updater, for a session
 * that runs an owned copy ONLY. A copy the person owns keeps updating itself
 * the way the person set it up. */
function selfUpdateEnvironment(providerId, copy, { client = null } = {}) {
  const row = rowFor(providerId, client);
  if (!row || !copy || copy.owner !== 'toolsenabled' || !row.selfUpdateOff || !row.selfUpdateOff.env) return {};
  return { ...row.selfUpdateOff.env };
}

function isOwnedPath(file, options = {}) {
  const platform = options.platform || process.platform;
  const root = options.root !== undefined ? options.root : ownedProvidersRoot(options);
  if (!root || !absoluteFor(platform, file)) return false;
  const paths = pathApiFor(platform);
  const fsImpl = options.fsImpl || fs;
  return inside(paths, root, paths.resolve(file)) || inside(paths, root, realPathOf(fsImpl, file));
}

module.exports = {
  PROVIDER_TOOLCHAIN,
  FEATURE_STATES,
  CHANNELS,
  OWNERS,
  rowFor,
  ownedProvidersRoot,
  describeCopy,
  featuresFromHelp,
  evaluateFeatures,
  probeCacheKey,
  recallProbe,
  rememberProbe,
  selfUpdateEnvironment,
  isOwnedPath,
};
