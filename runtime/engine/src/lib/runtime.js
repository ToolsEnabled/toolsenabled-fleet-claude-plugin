const fs = require('node:fs');
const path = require('node:path');
const { programOrStatePath } = require('./runtime-state-root');

const ROOT = path.resolve(__dirname, '..', '..');

// ROOT IS WHERE THE PROGRAM IS. IT IS NOT ALWAYS WHERE THE PROGRAM WRITES.
//
// Installed, the program lives in a directory that an update replaces wholesale
// and that may be read-only, so state/, logs/, the other runtime folders that
// src/lib/runtime-state-root.js lists, and the KILLSWITCH marker resolve to a
// per-user state root instead.
// src/lib/runtime-state-root.js makes that decision and documents why; every
// other top-level name still resolves against ROOT.
//
// In a source checkout nothing is redirected and every path this returns is
// byte-identical to what it returned before, which is what let this land under
// a running system.
function rootPath(...parts) {
  return programOrStatePath(ROOT, parts);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`Unable to read JSON ${file}: ${error.message}`);
  }
}

// Cache only successful executable lookups. A miss or an unavailable helper is
// rechecked on the next status call, and environment changes invalidate hits.
const COMMAND_PATH_HIT_TTL_MS = 60_000;
const commandPathHits = new Map();
let commandPathEnvKey = null;

function commandPathEnvironment() {
  return [
    process.env.PATH || '',
    // PATH entries and slash paths may be relative. An unset PATH also
    // uses the process launcher's default, whereas an empty PATH means cwd.
    process.cwd(),
    typeof process.env.PATH
  ].join('\u0000');
}

function commandPath(command) {
  const envKey = commandPathEnvironment();
  if (envKey !== commandPathEnvKey) {
    commandPathHits.clear();
    commandPathEnvKey = envKey;
  }
  const key = String(command);
  const remembered = commandPathHits.get(key);
  if (remembered && Date.now() - remembered.atMs < COMMAND_PATH_HIT_TTL_MS) return remembered.value;
  if (remembered) commandPathHits.delete(key);
  // A throw leaves the table untouched: unknown is not an answer.
  const resolved = resolveCommandPath(command);
  if (resolved) commandPathHits.set(key, { value: resolved, atMs: Date.now() });
  return resolved;
}

// Exists so a suite can drive the same process through a changed filesystem
// without waiting out the TTL. Not part of the capability surface.
function resetCommandPathCache() {
  commandPathHits.clear();
  commandPathEnvKey = null;
}

// PATH without empty, relative and temporary-folder entries; an unset PATH
// uses the system folders.
function searchPathOf(env) {
  if (env.PATH === undefined) return '/usr/bin:/bin';
  return require('./supervision/launch-environment').agentSearchPath({ env });
}

// Where a command is, looked up here and never by running a lookup program: a
// `which` planted in a folder on PATH would run as the person. Node is the
// program running this code, so its answer is process.execPath. Other names
// are searched on PATH the way subagent CLIs are found
// (src/lib/supervision/launch-environment.js): empty and relative entries,
// which mean the working folder, and /tmp and the temporary folders are
// skipped. Nothing found is run.
function resolveCommandPath(command) {
  function unknown(causeCode) {
    const error = new Error(
      `Command lookup for '${command}' could not be completed (${causeCode}), so whether it is installed is unknown; this is not a claim that it is absent.`
    );
    error.code = 'COMMAND_LOOKUP_UNKNOWN';
    error.causeCode = causeCode;
    return error;
  }
  const name = String(command);
  if (!name) return null;
  if (name === 'node') return process.execPath;
  let candidates;
  if (name.includes('/')) candidates = [path.resolve(name)];
  else {
    const searchPath = searchPathOf(process.env);
    candidates = searchPath.split(path.delimiter).filter(Boolean).map(directory => path.join(directory, name));
  }
  for (const candidate of candidates) {
    try {
      if (!fs.statSync(candidate).isFile()) continue;
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) continue;
      throw unknown(error.code || 'FILESYSTEM_STAT');
    }
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) continue;
      throw unknown(error.code || 'FILESYSTEM_ACCESS');
    }
  }
  return null;
}

function commandExists(command) {
  return Boolean(commandPath(command));
}

module.exports = {
  ROOT, rootPath, ensureDir, readJson, commandPath, commandExists, resetCommandPathCache
};
