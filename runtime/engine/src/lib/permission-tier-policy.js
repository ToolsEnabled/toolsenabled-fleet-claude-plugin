'use strict';

const ORIGINS = Object.freeze(['local']);
// Fleet sessions are local. Guided and Standard use confined profiles, and
// host setup also needs a local guarded read view. No recorded level maps to
// the full tier.
const TIERS = Object.freeze(['full', 'guarded', 'confined']);
// Standard is the level Fleet runs at. Guided remains only as the fail-closed
// level a session falls back to when its recorded one cannot be read
// (agent-session-confinement.js FAIL_CLOSED_TIER).
const INSTALL_TIERS = Object.freeze(['guided', 'standard']);
// The one mapping. Guided is the read-only surface; Standard is write-capable
// but cannot reach off the workspace through a tool.
const INSTALL_TIER_SESSIONS = Object.freeze({
  guided: Object.freeze({ origin: 'local', tier: 'confined', profile: 'read-only' }),
  standard: Object.freeze({ origin: 'local', tier: 'confined', profile: 'workspace' })
});
const GUARDED_EFFECTS = Object.freeze(['local-read', 'external-read']);
// Confined's two shapes. Guided is NOT simply the Guarded tier: Guarded is an
// effect filter, and `host.read_file`, `repo.read_file`, `host.list_dir`,
// `repo.list_dir` and `clipboard.read` are all local-read, so a purely
// effect-derived Guided surface carried tools that read any file on the
// machine -- under a level whose own words are "cannot reach anything else on
// this computer". Confined applies the permanent exclusions first and the
// effect narrowing second, so Guided is a strict subset of Standard rather than
// a differently-shaped surface that happens to be smaller.
//
// A null effect list means "any effect", not "no effects"; an unknown profile
// is refused rather than treated as either.
//
// THESE NAME THE MCP TOOL AXIS ONLY, AND SAY NOTHING ABOUT THE FILESYSTEM.
// 'read-only' here means "this level's MCP tool surface carries no write-effect
// tool", because Guided generates the read-only server and nothing else. It
// does NOT mean the agent process may not write files. Those are two different
// boundaries enforced by two different mechanisms, and the design is explicit
// that they differ at this very level: docs/design/INSTALLER-EXPERIENCE.md 2.2
// and guided spawn rule give Guided `--sandbox workspace-write --cd <workspace>` with no
// `--add-dir`, and `--permission-mode acceptEdits` -- the beginner assistant is
// MEANT to write inside the one folder it was given, since section 2.1 sells
// that level as "good for writing, organizing files". Reading this word as a
// filesystem mode would produce a Guided install that cannot do the thing its
// own question offers. The filesystem axis is not decided in this file.
const CONFINED_PROFILES = Object.freeze({
  'read-only': GUARDED_EFFECTS,
  workspace: null
});
const SURFACE_REFUSALS = Object.freeze([
  // Guarded's own unconfinable refusal filters the advertised surface the same
  // way the confined ones do; without this allowedToolNames would throw instead
  // of omitting the tool.
  'PERMISSION_GUARDED_UNCONFINABLE_REFUSED',
  'PERMISSION_EFFECT_REFUSED',
  'PERMISSION_CONFINED_EXCLUSION_REFUSED',
  'PERMISSION_CONFINED_EFFECT_REFUSED',
  // The two deny-by-default refusals. They are surface refusals -- "this tier
  // does not carry that tool" -- and NOT malformed-input errors, so tool-surface
  // enumeration filters them out instead of failing the whole enumeration.
  // Leaving them off this list would make allowedToolNames() throw the first
  // time it met an unclassified tool, which turns a fail-closed refusal into a
  // total outage and is exactly the pressure that gets a security default
  // reverted.
  'PERMISSION_CONFINED_UNCLASSIFIED_REFUSED',
  'PERMISSION_CONFINED_UNCONFINABLE_REFUSED'
]);

class PermissionTierRefusal extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PermissionTierRefusal';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

// The confined tool table loads only for decisions that need it.
function confinedSurfaceModule() {
  return require('./confined-tool-surface');
}

// The local confined policy owns the exclusions for installed Fleet sessions.
//
// FAIL CLOSED. If that module cannot be loaded, or answers with something that
// is not a populated exclusion set, this raises rather than returning an empty
// set -- an empty exclusion set would read as "nothing is excluded", which is
// the exact inversion this whole file exists to prevent.
function permanentExclusions() {
  let loaded;
  try { loaded = require('./fleet-confined-policy'); }
  catch {
    throw new PermissionTierRefusal('PERMISSION_EXCLUSIONS_UNREADABLE',
      'The permanently excluded tools could not be read, so no tool surface can be granted.');
  }
  const tools = loaded && loaded.PERMANENT_EXCLUDED_TOOLS;
  const namespaces = loaded && loaded.PERMANENT_EXCLUDED_NAMESPACES;
  if (!(tools instanceof Set) || tools.size === 0 || !(namespaces instanceof Set) || namespaces.size === 0) {
    throw new PermissionTierRefusal('PERMISSION_EXCLUSIONS_UNREADABLE',
      'The permanently excluded tools are not a readable exclusion set, so no tool surface can be granted.');
  }
  return { tools, namespaces };
}

function toolNamespace(name) {
  const separator = name.indexOf('.');
  return separator < 0 ? name : name.slice(0, separator);
}

function session(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new PermissionTierRefusal('PERMISSION_SESSION_UNREADABLE', 'A readable permission session is required.');
  }
  const origin = input.origin;
  const tier = input.tier;
  if (!ORIGINS.includes(origin)) {
    throw new PermissionTierRefusal('PERMISSION_ORIGIN_REFUSED', 'The caller origin is not recognised.', { origin });
  }
  if (!TIERS.includes(tier)) {
    throw new PermissionTierRefusal('PERMISSION_TIER_REFUSED', 'The permission tier is not recognised.', { tier });
  }
  if (tier === 'confined') {
    const profile = input.profile;
    if (typeof profile !== 'string' || !Object.prototype.hasOwnProperty.call(CONFINED_PROFILES, profile)) {
      throw new PermissionTierRefusal('PERMISSION_CONFINED_PROFILE_REFUSED',
        'The Confined tier requires a recognised profile, so an unnamed one cannot borrow the widest of them.',
        { profile: typeof profile === 'string' ? profile.slice(0, 60) : null });
    }
    return Object.freeze({ origin, tier, profile });
  }
  return Object.freeze({ origin, tier });
}

// Confined admits a tool only if the reviewed table in
// src/lib/confined-tool-surface.js names it as confinable. DENY BY DEFAULT.
//
// NOT INVERTED. A rule of "the whole registry EXCEPT the permanent exclusions"
// would admit at Standard nearly every tool, and every tool added in future
// by silence; a short exclusion list cannot name every tool that reaches
// outside the recorded workspace root.
//
// It is STILL not a plain effect filter, for the original and correct reason: a
// Standard installation is supposed to be able to write, so refusing every write
// effect would make it Guarded under a different name. What changed is that
// "may write" no longer implies "may write anywhere".
//
// The order below is deliberate. Permanent exclusions are checked FIRST so that
// a host/repo/clipboard tool is refused with the permanent code even if the
// table were ever edited to name it; the classification check second; the
// profile's effect narrowing last, so Guided remains a strict subset of
// Standard rather than a differently-shaped surface.
function assertConfinedToolAllowed(entry, resolved) {
  const { tools, namespaces } = permanentExclusions();
  // Host mode bounds the four host file tools by its sealed workspace record;
  // see fleet-confined-policy.js. Everywhere else they stay excluded.
  const hostWorkspaceFile = require('./fleet-confined-policy').hostModeWorkspaceFileTool(entry.name, resolved.profile);
  if (entry.name === 'host.exec' || (!hostWorkspaceFile && (tools.has(entry.name) || namespaces.has(toolNamespace(entry.name))))) {
    throw new PermissionTierRefusal('PERMISSION_CONFINED_EXCLUSION_REFUSED',
      `The Confined tier permanently refuses tool '${entry.name}'.`, { tool: entry.name, tier: resolved.tier });
  }
  try {
    confinedSurfaceModule().assertToolConfinable(entry.name, { tier: resolved.tier, profile: resolved.profile });
  } catch (error) {
    // Re-raised as the policy's own refusal type so every caller keeps catching
    // one error class, with the surface module's code and reason preserved.
    throw new PermissionTierRefusal(error.code, error.message, error.details || {});
  }
  const effects = CONFINED_PROFILES[resolved.profile];
  if (effects !== null && !effects.includes(entry.effect)) {
    throw new PermissionTierRefusal('PERMISSION_CONFINED_EFFECT_REFUSED',
      `The '${resolved.profile}' level refuses tool '${entry.name}' with effect '${entry.effect}'.`,
      { tool: entry.name, effect: entry.effect, tier: resolved.tier, profile: resolved.profile });
  }
  return resolved;
}

/**
 * The ARGUMENT half of a confined decision, for the dispatch chokepoint.
 *
 * assertToolAllowed above answers "may this level carry this tool at all", which
 * is the only question tool-surface enumeration can ask, because enumeration has
 * no arguments. A tool whose reach depends on a path it is GIVEN cannot be
 * judged by name, so the fence over those arguments runs here, at dispatch,
 * where the values exist.
 *
 * Full and local Guarded sessions pass through this argument check.
 */
function assertConfinedArgumentsAllowed(entry, input, argumentsValue, workspaceRoots) {
  const resolved = session(input);
  if (resolved.tier !== 'confined') return resolved;
  if (!entry || typeof entry.name !== 'string') {
    throw new PermissionTierRefusal('PERMISSION_POLICY_UNREADABLE', 'Tool policy metadata is unreadable.');
  }
  try {
    confinedSurfaceModule().assertArgumentsConfined(entry.name, argumentsValue, workspaceRoots,
      { tier: resolved.tier, profile: resolved.profile });
  } catch (error) {
    throw new PermissionTierRefusal(error.code, error.message, error.details || {});
  }
  return resolved;
}

function assertToolAllowed(entry, input) {
  const resolved = session(input);
  if (!entry || typeof entry.name !== 'string' || typeof entry.effect !== 'string') {
    throw new PermissionTierRefusal('PERMISSION_POLICY_UNREADABLE', 'Tool policy metadata is unreadable.');
  }
  if (resolved.tier === 'confined') return assertConfinedToolAllowed(entry, resolved);
  if (resolved.tier === 'full') return resolved;
  if (!GUARDED_EFFECTS.includes(entry.effect)) {
    throw new PermissionTierRefusal('PERMISSION_EFFECT_REFUSED', `Guarded tier refuses tool '${entry.name}' with effect '${entry.effect}'.`, {
      tool: entry.name, effect: entry.effect, tier: resolved.tier
    });
  }
  // A local guarded read view also refuses tools that cannot be confined.
  // An unreadable classification refuses the tool rather than admitting it.
    let guardedClass = null;
    try { guardedClass = confinedSurfaceModule().classify(entry.name); }
    catch (error) {
      throw new PermissionTierRefusal('PERMISSION_GUARDED_UNCONFINABLE_REFUSED',
        `Tool '${entry.name}' could not be classified for confinement, so the Guarded tier refuses it.`,
        { tool: entry.name, tier: resolved.tier, reason: error && error.code ? String(error.code) : 'unclassifiable' });
    }
    if (guardedClass === 'unconfinable') {
      const reason = confinedSurfaceModule().unconfinableReason(entry.name);
      throw new PermissionTierRefusal('PERMISSION_GUARDED_UNCONFINABLE_REFUSED',
        `Tool '${entry.name}' cannot be confined to a workspace (${reason}), so the Guarded tier refuses it.`,
        { tool: entry.name, tier: resolved.tier, reason });
    }
  return resolved;
}

function assertUnrestrictedSpawn(input) {
  const resolved = session(input);
  if (resolved.origin !== 'local' || resolved.tier !== 'full') {
    throw new PermissionTierRefusal('PERMISSION_UNRESTRICTED_SPAWN_REFUSED', 'Unrestricted agent flags require a local Full owner session.');
  }
  return resolved;
}

function assertConfinedTreeSpawn(input) {
  const resolved = session(input);
  if (resolved.origin !== 'local' || resolved.tier !== 'confined' || resolved.profile !== 'workspace'
      || !require('./tree-host-registry').supportsConfinedTreeSpawn()) {
    throw new PermissionTierRefusal('TREE_DELEGATION_REFUSED',
      'Tree delegation requires a local Standard session and a compatible application.');
  }
  return resolved;
}

function allowedToolNames(toolRegistry, input) {
  const resolved = session(input);
  if (!Array.isArray(toolRegistry)) {
    throw new PermissionTierRefusal('PERMISSION_POLICY_UNREADABLE', 'The tool registry is unreadable.');
  }
  return Object.freeze(toolRegistry.filter(entry => {
    try { assertToolAllowed(entry, resolved); return true; }
    catch (error) { if (SURFACE_REFUSALS.includes(error.code)) return false; throw error; }
  }).map(entry => entry.name));
}

// --- the recorded installation level ----------------------------------------
//
// FAIL CLOSED IS THE WHOLE POINT OF THESE FOUR FUNCTIONS. A level that cannot be
// read, is absent, or is a word this program does not know raises a refusal. It
// never falls back to Unrestricted, and it never falls back to "no allowlist" --
// which src/lib/tool-registry.js reads as the FULL surface, so an unnoticed
// widening here would be indistinguishable from a deliberate one.

function installTier(value) {
  if (typeof value !== 'string' || !INSTALL_TIERS.includes(value)) {
    throw new PermissionTierRefusal('PERMISSION_INSTALL_TIER_REFUSED',
      'The recorded permission level is missing or is not one this program recognises, so no tool surface can be granted.',
      { tier: typeof value === 'string' ? value.slice(0, 60) : null });
  }
  return value;
}

function installTierSession(value) {
  return session(INSTALL_TIER_SESSIONS[installTier(value)]);
}

function installTierFromRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new PermissionTierRefusal('PERMISSION_INSTALL_TIER_UNREADABLE',
      'The machine record could not be read, so the permission level it holds cannot be honoured.');
  }
  return installTier(record.tier);
}

function installTierSessionFromRecord(record) {
  return installTierSession(installTierFromRecord(record));
}

function installTierToolNames(toolRegistry, value) {
  return allowedToolNames(toolRegistry, installTierSession(value));
}

module.exports = Object.freeze({
  ORIGINS, TIERS, INSTALL_TIERS, INSTALL_TIER_SESSIONS, CONFINED_PROFILES,
  GUARDED_EFFECTS, SURFACE_REFUSALS, PermissionTierRefusal,
  session, assertToolAllowed, assertConfinedArgumentsAllowed, assertConfinedTreeSpawn,
  assertUnrestrictedSpawn, allowedToolNames,
  installTier, installTierSession, installTierFromRecord, installTierSessionFromRecord, installTierToolNames
});
