#!/usr/bin/env node
'use strict';

// A dependency-free stdio MCP server. The contract-driven registry keeps tool
// metadata, validation, policy, audit, and dispatch consistent across clients.
const readline = require('node:readline');
const packageInfo = require('../package.json');
const audit = require('./lib/audit');
const errorTaxonomy = require('./lib/error-taxonomy');
const mcpToolSurface = require('./lib/mcp-tool-surface');
const fileToolContext = require('./lib/file-tool-context');
// One anonymous scope for this stdio transport. Environment actor/agent hints
// do not become coordination authority. The Fleet host supplies its own
// per-session scope instead.
const { SchemaValidationError } = require('./lib/schema-validator');
const {
  UnknownToolError, ToolNotEnabledError, assertToolRegistered, dispatchKindForTool, executeTool, listTools
} = require('./lib/tool-registry');
const { throughputMode } = require('./lib/throughput-mode');

const fs = require('node:fs');
const path = require('node:path');
const v8 = require('node:v8');
const { statePath } = require('./lib/runtime-state-root');

/* LAST WORDS -- the file this process leaves behind so its death can be read.
 *
 * WHY. Two MCP servers of one circle once left crash dumps and NOTHING ELSE.
 * Working out whether they had died
 * mid-tool-call, run out of heap, or simply been shut down took a full
 * CONTEXT-based stack walk of two minidumps against 338 MB of breakpad symbols
 * (the crash investigation evidence). The answer -- both were exiting cleanly,
 * and aborted inside electron::NodeMain()'s teardown when V8's memory-pool
 * release task re-posted onto an already-closed libuv loop -- was three lines of
 * information that this process knew at the time and never wrote down.
 *
 * WHAT process.on('exit') CAN AND CANNOT DO, precisely, because the difference
 * is the whole point of this file. It CANNOT catch a V8 or libuv abort: those
 * call DebugBreak()/abort() and no JavaScript runs again. But the abort that
 * killed those two processes happened AFTER the JS exit hooks had already run,
 * in the native destructor chain. So the stamp this hook writes is exactly the
 * discriminator that was missing:
 *
 *   exit.reason === 'clean'    -> the JS side finished; a crash dump alongside
 *                                 this file is Electron/Node teardown, not us.
 *   exit.reason === 'running'  -> the process was killed or aborted while still
 *                                 working. lastRequest and memory say what it
 *                                 was doing and how much heap it held.
 *
 * COST. One small write at start, one per LAST_WORDS_SAMPLE_MS on an unref'd
 * timer, and one at exit. Nothing is written per tool call -- lastRequest is
 * held in memory only -- because this transport's per-call cost is already the
 * subject of its own report. Tool NAMES are recorded; arguments never are.
 */
const LAST_WORDS_SAMPLE_MS = 15000;
const LAST_WORDS_DIRECTORY = ['logs', 'mcp-last-words'];
// A bounded scan of the request line for its method and tool name. Deliberately
// not JSON.parse: this must never throw, never allocate a copy of the arguments,
// and never be able to put a caller's payload into a file on disk.
const LAST_WORDS_METHOD = /"method"\s*:\s*"([A-Za-z0-9_./-]{1,64})"/;
const LAST_WORDS_TOOL = /"name"\s*:\s*"([A-Za-z0-9_.-]{1,64})"/;

const lastWords = { file: null, state: null, timer: null };

function lastWordsMemory() {
  const usage = process.memoryUsage();
  let heapSizeLimit = null;
  try { heapSizeLimit = v8.getHeapStatistics().heap_size_limit; } catch {}
  return {
    at: new Date().toISOString(),
    rss: usage.rss,
    heapTotal: usage.heapTotal,
    heapUsed: usage.heapUsed,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
    heapSizeLimit
  };
}

// Never throws and never reports: a broker that fell over because its own
// breadcrumb could not be written would be a worse bug than the one this is for.
function writeLastWords() {
  if (lastWords.file === null || lastWords.state === null) return false;
  try {
    fs.writeFileSync(lastWords.file, `${JSON.stringify(lastWords.state, null, 2)}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function noteLastWordsRequest(line) {
  if (lastWords.state === null || typeof line !== 'string') return;
  lastWords.state.requests += 1;
  const method = LAST_WORDS_METHOD.exec(line);
  const tool = LAST_WORDS_TOOL.exec(line);
  lastWords.state.lastRequest = {
    at: new Date().toISOString(),
    method: method === null ? null : method[1],
    tool: tool === null ? null : tool[1]
  };
}

function openLastWords({ stateFile = null, now = () => new Date().toISOString() } = {}) {
  try {
    const file = stateFile === null
      ? path.join(statePath(...LAST_WORDS_DIRECTORY), `mcp-server-${process.pid}.json`)
      : stateFile;
    // Fresh diagnostics must stay private regardless of the launcher's umask.
    // These creation modes intentionally leave existing permissions unchanged.
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    lastWords.file = file;
    lastWords.state = {
      pid: process.pid,
      ppid: process.ppid,
      startedAt: now(),
      execPath: process.execPath,
      // The flags and versions this process runs with, recorded so a reader
      // never has to guess them.
      execArgv: [...process.execArgv],
      versions: {
        node: process.versions.node,
        v8: process.versions.v8
      },
      allowlisted: typeof process.env.TOOLSENABLED_TOOL_ALLOWLIST === 'string'
        && process.env.TOOLSENABLED_TOOL_ALLOWLIST !== '',
      requests: 0,
      lastRequest: null,
      stdinClosedAt: null,
      memory: lastWordsMemory(),
      exit: { reason: 'running', code: null, at: null }
    };
    writeLastWords();
    lastWords.timer = setInterval(() => {
      if (lastWords.state === null) return;
      lastWords.state.memory = lastWordsMemory();
      writeLastWords();
    }, LAST_WORDS_SAMPLE_MS);
    if (typeof lastWords.timer.unref === 'function') lastWords.timer.unref();
    process.on('exit', code => {
      if (lastWords.state === null) return;
      lastWords.state.exit = { reason: 'clean', code, at: now() };
      lastWords.state.memory = lastWordsMemory();
      writeLastWords();
    });
    return lastWords.file;
  } catch {
    lastWords.file = null;
    lastWords.state = null;
    return null;
  }
}

function closeLastWordsForTests() {
  if (lastWords.timer !== null) clearInterval(lastWords.timer);
  lastWords.timer = null;
  lastWords.file = null;
  lastWords.state = null;
}

const MAX_MESSAGE_BYTES = 1024 * 1024;
const SUPPORTED_PROTOCOLS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
// Only worker principals can bind to this transport. `human` and the
// historical `coordinator` principal carry broader authority and cannot be
// selected through an environment variable. Handlers keep their own role and
// permission checks.
const { isProviderId } = require('./lib/openshell-worker-providers');
const DECLARED_AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// The standing-rule tools carry the same binding: the attribution written on
// the ledger's head line is the principal this transport was started as.
const R_LEDGER_ACTOR_BOUND_TOOLS = new Set([
  't_ledger.file', 't_ledger.complete', 't_ledger.progress', 'a_ledger.file'
]);
// agent-comms handlers derive their sender and reader from this same
// transport-bound principal. A caller never supplies its fabric sender.

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

function publicMessage(error) {
  let reason = `Tool execution failed (${error === null ? 'null' : typeof error} thrown).`;
  try {
    const value = error?.message;
    if (typeof value === 'string') reason = value;
  } catch { /* An unreadable diagnostic must still produce a public refusal. */ }
  let message = audit.redact(reason);
  message = message
    .replace(/\r?\n\s*At\s+[^\r\n]+[\s\S]*$/i, '')
    .replace(/\r?\n\s*(?:CategoryInfo|FullyQualifiedErrorId)\s*:[\s\S]*$/i, '')
    .trim();
  return (message || 'Tool execution failed.').slice(0, 2000);
}

function structured(value) {
  // Copy only enumerable result fields.
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : { value };
}

function toolResult(value) {
  const output = value === undefined ? null : value;
  // Compact, not indented: the text copy is what most clients hand the model,
  // and clients cut long results (Codex keeps about 10,000 tokens). Indenting
  // added about a third to every result for nothing the model needs.
  const content = [{ type: 'text', text: JSON.stringify(output) }];
  return {
    content,
    structuredContent: structured(output)
  };
}

// This source code already carries a bounded action sentence from the host
// file boundary. Preserve only those exact, reviewed sentences; an arbitrary
// message attached to the code remains private and falls back to the closed
// taxonomy summary.
const PUBLIC_SOURCE_MESSAGES = Object.freeze({
  HOST_PATH_CHECK_FAILED: Object.freeze([
    'host control root', 'runtime state and control roots', 'host workspace',
    'executable search path', 'path against the product tree', 'path existence',
    'write target', 'directory entry', 'directory entry metadata'
  ].map(subject => `${subject} could not be checked; this does NOT claim that the path or entry is absent.`))
});

function exactPublicSourceMessage(error) {
  if (!error || typeof error.code !== 'string' || typeof error.message !== 'string'
      || !Object.hasOwn(PUBLIC_SOURCE_MESSAGES, error.code)) return '';
  const messages = PUBLIC_SOURCE_MESSAGES[error.code];
  return messages.includes(error.message) ? error.message : '';
}

function toolError(error) {
  const typed = errorTaxonomy.publicFailure(errorTaxonomy.adaptToolError(error));
  // Non-retryable is not synonymous with an actionable refusal. Verification,
  // malformed output, security and unknown internal failures can contain
  // arbitrary provider prose; redacting token patterns cannot make it public.
  // Keep their source message/details off BOTH MCP output representations.
  // POLICY_DENIED remains an actionable policy explanation.
  const protectedTerminal = typed.classification === 'terminal' && typed.code !== 'POLICY_DENIED';
  // Preserve the established sanitized error fields for existing MCP clients.
  // The additive closed taxonomy is the only controller/UI retry contract;
  // it never includes source messages, details, provider codes, or tokens.
  const boundedSourceCode = error && typeof error.code === 'string'
    && Object.hasOwn(PUBLIC_SOURCE_MESSAGES, error.code) ? error.code : '';
  const boundedSourceMessage = boundedSourceCode === '' ? '' : exactPublicSourceMessage(error);
  const details = { message: boundedSourceCode !== '' ? (boundedSourceMessage || typed.safeSummary)
    : protectedTerminal ? typed.safeSummary : publicMessage(error) };
  if (error && typeof error.code === 'string') details.code = error.code;
  if (boundedSourceCode === '' && !protectedTerminal && error && error.name === 'StateStoreError'
      && error.details && typeof error.details === 'object') {
    details.details = audit.scrub(error.details);
  }
  // Host file repairs need exact file/range metadata to be actionable, but
  // generic Error.details can contain private provider prose or file content.
  const coordination = !protectedTerminal && /^BYTE_/.test(error?.code || '')
    ? require('./lib/byte-tool-refusal').publicByteRefusal(error) : null;
  if (coordination) details.coordination = coordination;
  details.taxonomy = typed;
  /* AN ANSWER THE CALLER CANNOT ACT ON IS A LOOP.
   *
   * The closed taxonomy's safeSummary is a fixed sentence per classification,
   * and for a RETRYABLE failure that is right: "try again later" is genuinely
   * all there is to say about a transport that dropped. For a refusal it is
   * not. The tool has already worked out precisely what is wrong and written
   * it into details.message, and that sentence would reach the audit log and
   * nothing else -- structuredContent is not what an agent reads. An agent
   * shown "temporarily unavailable" retries a refusal that will never succeed.
   *
   * So an actionable input/policy refusal answers with its bounded, redacted
   * sentence. This exception must not include terminal provider/security
   * failures merely because those are also non-retryable. The taxonomy block
   * remains unchanged and carries no source message. */
  const text = boundedSourceCode !== ''
    ? details.message
    : typed.retryable === false && !protectedTerminal && typeof details.message === 'string' && details.message !== ''
      ? details.message
      : typed.safeSummary;
  // Some MCP clients show only content, not structuredContent. Keep this
  // deliberately closed: arbitrary provider codes (or diagnostic details)
  // must not become a new text channel. This is an identifier, not authority
  // to retry a refused lifecycle operation or bypass its admission checks.
  const publicCode = !protectedTerminal && details.code === 'TREE_DELEGATION_REFUSED'
    ? { code: 'TREE_DELEGATION_REFUSED' } : null;
  const contentText = publicCode ? `${text}\n${JSON.stringify(publicCode)}` : text;
  return {
    content: [{ type: 'text', text: coordination ? `${contentText}\n${JSON.stringify({ coordination })}` : contentText }],
    structuredContent: { error: details },
    isError: true
  };
}

function requireObject(value, label, optional = false) {
  if (optional && value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RpcError(-32602, `${label} must be an object.`);
  return value;
}

function bindAgentActor(name, args, boundActor = process.env.TOOLSENABLED_AGENT_ACTOR) {
  if (!R_LEDGER_ACTOR_BOUND_TOOLS.has(name)) return args;
  if (!isProviderId(boundActor)) {
    throw new RpcError(-32602, 'This ledger mutation requires a transport-bound provider id.');
  }
  if (Object.hasOwn(args, 'actor')) {
    throw new RpcError(-32602, 'Ledger actor comes from the transport; omit actor from the call.');
  }
  return args;
}

/* The provider actor above answers which assistant program made a call. This
 * identity answers which exact declared organisation entry the app bound at
 * start. Never infer one from the other: many agents can run on Codex, and an
 * anonymous/directions-only session intentionally has no organisation authority. */
function boundAgentId(options = {}, environment = process.env) {
  const supplied = options.agentId !== undefined
    ? options.agentId
    : environment.TOOLSENABLED_AGENT_ID;
  if (supplied === undefined || supplied === null || supplied === '') return undefined;
  if (typeof supplied !== 'string' || !DECLARED_AGENT_ID.test(supplied)) {
    throw new RpcError(-32602, 'This tool transport carries an invalid declared agent identity.');
  }
  return supplied;
}

function validateRequest(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    throw new RpcError(-32600, 'Invalid JSON-RPC 2.0 request.');
  }
}

function snapshotAllowedToolNames(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(name => typeof name !== 'string')) {
    throw new RpcError(-32603, 'The request-bound tool profile is invalid.');
  }
  return Object.freeze([...value]);
}

// A DEGRADED INSTALL AND A HEALTHY ONE MUST NOT LOOK THE SAME TO system.doctor.
//
// resolvePermissionSession() below falls back to the fail-closed tier (~102 of
// ~263 tools) whenever this session's machine-record seal could not be
// verified, and rides the reason along as `.degraded` on the session it
// returns -- see that function's own comment for why the field lives there
// instead of module state. `doctor()` in src/lib/system-status.js has no way
// to know about a check that happens one layer up, before it is ever called,
// so this broker -- the one place that DOES know -- annotates only the one
// tool response that reports installation health, rather than leaving that
// report looking identical to a healthy install.
//
// Scoped to `system.doctor` alone: every other tool's result is returned
// unchanged, and a session with no `.degraded` (a verified record, an
// explicitly constructed remote session, or the normal "never set up yet"
// state) reports `degraded: false` rather than omitting the field, so a
// caller can assert on it directly instead of inferring health from a tool
// count that could be small for other reasons too.
function annotateDoctorDegradation(toolName, output, permissionSession) {
  if (toolName !== 'system.doctor' || !output || typeof output !== 'object' || Array.isArray(output)) return output;
  const degraded = permissionSession && permissionSession.degraded;
  return {
    ...output,
    permissionSessionDegraded: degraded
      ? { degraded: true, code: degraded.code, reason: degraded.reason }
      : { degraded: false, code: null, reason: null }
  };
}

// THE SESSION-START TOOL NOTE.
//
// `instructions` is the MCP handshake's field for a note the client hands the
// model at session start; it has been in InitializeResult since 2024-11-05,
// the oldest protocol this server speaks. The caller supplies the note's
// wording as options.toolSummary (the host passes src/lib/host-descriptions.js);
// without one no note is sent. The person's agent.tool_summary setting (on by
// default) decides whether the note is sent at all; a settings file that
// cannot be read sends none.
//
// THE NOTE DESCRIBES THE SURFACE THIS BROKER ACTUALLY ADVERTISES. The names
// come from listTools(enumerationView) -- the identical call, on the identical
// view, that answers tools/list a moment later -- so they carry the
// request-bound allowedToolNames narrowing as well as the tier.
//
// FAIL CLOSED TO NO FIELD, NEVER TO A WRONG NOTE, AND NEVER TO A FAILED
// HANDSHAKE. Every way this can go wrong -- a session shape that is not one of
// the install tiers, an empty surface, a throwing registry -- omits
// `instructions` and leaves the rest of the result untouched. A session must
// never fail to start over its own introduction.
function installTierOfSession(permissionSession, policy) {
  if (!permissionSession || typeof permissionSession !== 'object') return undefined;
  const { origin, tier, profile } = permissionSession;
  // Matched against the policy module's own exported table rather than a copy
  // of it, so a fourth install level or a changed profile cannot leave this
  // lookup quietly answering "none of them" for a level that exists.
  for (const name of policy.INSTALL_TIERS) {
    const shape = policy.INSTALL_TIER_SESSIONS[name];
    if (shape.origin === origin && shape.tier === tier && shape.profile === profile) return name;
  }
  return undefined;
}

const TOOL_SUMMARY_SETTING_ID = 'agent.tool_summary';

function toolSummaryEnabled(options) {
  const resolved = require('./lib/settings').loadSettings({ ids: [TOOL_SUMMARY_SETTING_ID],
    ...(options.valuesPath === undefined ? {} : { valuesPath: options.valuesPath }),
    ...(options.env === undefined ? {} : { env: options.env }) });
  if (!resolved || !Array.isArray(resolved.rejected)
      || resolved.rejected.some(row => row && (row.id === '*' || row.id === TOOL_SUMMARY_SETTING_ID))) return false;
  return resolved.values[TOOL_SUMMARY_SETTING_ID] !== false;
}

function sessionInstructions(enumerationView, options = {}) {
  try {
    if (!options.toolSummary || !toolSummaryEnabled(options)) return undefined;
    const policy = options.permissionTierPolicy || require('./lib/permission-tier-policy');
    const installTier = installTierOfSession(options.permissionSession, policy);
    if (installTier === undefined) return undefined;
    const advertised = listTools(enumerationView).map(tool => tool.name);
    if (advertised.length === 0) return undefined;
    const note = options.toolSummary.briefToolSummary({
      tier: installTier,
      allowedNames: advertised,
      setupKind: options.setupKind
    });
    return note && note.enabled && typeof note.text === 'string' && note.text ? note.text : undefined;
  } catch {
    return undefined;
  }
}

async function dispatch(message, options = {}) {
  validateRequest(message);
  const allowedToolNames = snapshotAllowedToolNames(options.allowedToolNames);
  const toolView = {
    ...(allowedToolNames === undefined ? {} : { allowedToolNames }),
    ...(options.agentRole === undefined ? {} : { agentRole: options.agentRole }),
    ...(options.setupKind === undefined ? {} : { setupKind: options.setupKind }),
  };
  // THE ADVERTISED SURFACE IS NARROWED BY THE TIER; THE CALL PATH IS NOT --
  // because the call path already refuses, and refuses better.
  //
  // Enumeration through name filters alone would offer a session tools its
  // level refuses, so the session is handed to the enumeration view below.
  //
  // assertToolRegistered() deliberately keeps the name-only view. Narrowing it
  // too would make an out-of-tier call fail as "tool not enabled", which is
  // both less true and less useful than what executeTool() already raises a few
  // lines later -- PERMISSION_EFFECT_REFUSED, naming the tool, its effect and
  // the tier that refused it. A precise failure diagnostic matters here, and
  // "no such tool" is not one when the real answer is "your tier refuses this
  // effect". The tool is still unreachable either way; only the explanation
  // differs, so the honest explanation wins.
  const enumerationView = options.permissionSession === undefined
    ? toolView
    : { ...toolView, permissionSession: options.permissionSession };

  if (message.method === 'initialize') {
    const params = requireObject(message.params, 'initialize params');
    const requested = params.protocolVersion;
    if (typeof requested !== 'string' || !requested) throw new RpcError(-32602, 'initialize params.protocolVersion must be a non-empty string.');
    const result = {
      protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'toolsenabled', version: packageInfo.version }
    };
    const instructions = sessionInstructions(enumerationView, options);
    if (instructions !== undefined) result.instructions = instructions;
    return result;
  }

  if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') return undefined;
  if (message.method === 'ping') return {};

  if (message.method === 'tools/list') {
    requireObject(message.params, 'tools/list params', true);
    return { tools: listTools(enumerationView) };
  }

  if (message.method === 'tools/call') {
    const params = requireObject(message.params, 'tools/call params');
    if (typeof params.name !== 'string' || !params.name) throw new RpcError(-32602, 'tools/call params.name must be a non-empty string.');
    const canonicalName = params.name;
    try {
      assertToolRegistered(canonicalName, toolView);
    } catch (error) {
      if (error instanceof UnknownToolError || error instanceof ToolNotEnabledError) {
        throw new RpcError(-32602, publicMessage(error));
      }
      throw error;
    }
    const suppliedArgs = params.arguments === undefined ? {} : params.arguments;
    if (!suppliedArgs || typeof suppliedArgs !== 'object' || Array.isArray(suppliedArgs)) throw new RpcError(-32602, 'tools/call params.arguments must be an object.');
    const agentActor = options.agentActor || process.env.TOOLSENABLED_AGENT_ACTOR || undefined;
    const agentId = boundAgentId(options);
    const args = bindAgentActor(canonicalName, suppliedArgs, agentActor);
    try {
      const output = await executeTool(canonicalName, args, {
        requestId: message.id,
        agentActor,
        fileToolContext: options.fileToolContext,
        ...(options.toolMode === undefined ? {} : { toolMode: options.toolMode }),
        ...(options.agentApiMode === undefined ? {} : { agentApiMode: options.agentApiMode }),
        ...(agentId === undefined ? {} : { agentId }),
        ...(options.agentPrincipal === undefined ? {} : { agentPrincipal: options.agentPrincipal }),
        ...(options.agentRole === undefined ? {} : { agentRole: options.agentRole }),
        /* The session the Fleet host bound this transport to, whether or not
           it also holds a declared identity. A tool that must know which of
           two same-named circles is calling reads it (agent_comms.send_local,
           agent_comms.local_roster); nothing here decides anything from it. */
        ...(options.agentSessionId === undefined ? {} : { agentSessionId: options.agentSessionId }),
        ...(allowedToolNames === undefined ? {} : { allowedToolNames }),
        ...(options.permissionSession === undefined ? {} : { permissionSession: options.permissionSession }),
        ...(options.workspaceRoots === undefined ? {} : { workspaceRoots: options.workspaceRoots }),
        ...(options.setupKind === undefined ? {} : { setupKind: options.setupKind }),
        ...(options.signal === undefined ? {} : { signal: options.signal })
      });
      return toolResult(annotateDoctorDegradation(params.name, output, options.permissionSession));
    } catch (error) {
      if (error instanceof SchemaValidationError || error instanceof UnknownToolError) {
        throw new RpcError(-32602, publicMessage(error), error.errors);
      }
      return toolError(error);
    }
  }

  throw new RpcError(-32601, `Unsupported MCP method: ${message.method}`);
}

function errorResponse(id, error) {
  const code = error instanceof RpcError && Number.isInteger(error.code) ? error.code : -32603;
  const payload = { code, message: publicMessage(error) };
  if (error instanceof RpcError && error.data !== undefined) payload.data = error.data;
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: payload };
}

const defaultWrite = value => process.stdout.write(`${JSON.stringify(value)}\n`);

// Parses one transport line into a message, writing the JSON-RPC error and
// returning undefined when the line cannot become one.
function parseLine(line, write) {
  if (!line.trim()) return undefined;
  if (Buffer.byteLength(line, 'utf8') > MAX_MESSAGE_BYTES) {
    write(errorResponse(null, new RpcError(-32600, `MCP message exceeds the ${MAX_MESSAGE_BYTES}-byte limit.`)));
    return undefined;
  }
  try {
    return JSON.parse(line);
  } catch {
    write(errorResponse(null, new RpcError(-32700, 'Parse error.')));
    return undefined;
  }
}

async function processMessage(message, write, options = {}) {
  try {
    const result = await dispatch(message, options);
    if (Object.prototype.hasOwnProperty.call(message, 'id')) {
      write({ jsonrpc: '2.0', id: message.id, result: result === undefined ? {} : result });
    }
  } catch (error) {
    const hasId = message && typeof message === 'object' && !Array.isArray(message) && Object.prototype.hasOwnProperty.call(message, 'id');
    const invalidRequest = error instanceof RpcError && error.code === -32600;
    if (hasId || invalidRequest) write(errorResponse(hasId ? message.id : null, error));
  }
}

async function processLine(line, write = defaultWrite, options = {}) {
  const message = parseLine(line, write);
  if (message === undefined) return;
  await processMessage(message, write, options);
}

// Which scheduling lane a message belongs to (src/lib/tool-dispatch-scheduler.js).
function classifyMessage(message, options = {}) {
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.method !== 'tools/call') return 'control';
  const params = message.params;
  const name = params && typeof params === 'object' ? params.name : undefined;
  if (typeof name !== 'string' || !name) return 'control';
  const allowedToolNames = snapshotAllowedToolNames(options.allowedToolNames);
  return dispatchKindForTool(name, allowedToolNames === undefined ? {} : { allowedToolNames });
}

/**
 * MANY CALLS IN FLIGHT, ORDERED WHERE ORDER MATTERS.
 *
 * Every transport used to chain each line behind the previous one. This
 * returns a `handle(line, write, options, lane)` that parses the line,
 * classifies it by the tool's effect, and runs it under the scheduler:
 * reads side by side, writes in arrival order per lane (one lane per agent
 * session), exclusive tools one at a time. `tools.throughput = strict`
 * selects the old single-file chain instead, per lane, without a restart.
 *
 * A `notifications/cancelled` carrying a requestId aborts that request's
 * in-flight handler through the AbortSignal executeTool already honours,
 * which the serial chain could never deliver in time to matter.
 */
function createLineDispatcher(base = {}) {
  const { createDispatchScheduler } = require('./lib/tool-dispatch-scheduler');
  const parallel = base.parallelScheduler || createDispatchScheduler({ mode: 'parallel', ...(base.schedulerOptions || {}) });
  const serial = base.serialScheduler || createDispatchScheduler({ mode: 'serial' });
  const modeOf = typeof base.modeOf === 'function' ? base.modeOf : throughputMode;
  const reportError = typeof base.reportError === 'function' ? base.reportError : error => process.stderr.write(`${publicMessage(error)}\n`);
  const controllers = new Map();
  // Preserve request ID types and the boundary between lane and ID. Flattening
  // both into text makes 1 collide with "1" and can cancel another lane's call.
  const key = (lane, id) => JSON.stringify([String(lane), id]);

  async function handle(line, write = defaultWrite, options = {}, lane = 'default') {
    const message = parseLine(line, write);
    if (message === undefined) return;
    if (message && typeof message === 'object' && !Array.isArray(message) && message.method === 'notifications/cancelled') {
      const requestId = message.params && typeof message.params === 'object' ? message.params.requestId : undefined;
      if (requestId !== undefined) {
        const controller = controllers.get(key(lane, requestId));
        if (controller) controller.abort();
      }
      return;
    }
    const kind = classifyMessage(message, options);
    const scheduler = modeOf() === 'strict' ? serial : parallel;
    const hasId = message && typeof message === 'object' && !Array.isArray(message) && Object.prototype.hasOwnProperty.call(message, 'id');
    const controller = kind !== 'control' && hasId ? new AbortController() : null;
    const requestKey = controller ? key(lane, message.id) : null;
    if (controller) controllers.set(requestKey, controller);
    // A transport lifetime must not disable cancellation of one request. Both
    // signals are trusted in-process authority; neither is read from the wire.
    const dispatchOptions = controller ? { ...options, signal: options.signal
      ? AbortSignal.any([controller.signal, options.signal]) : controller.signal } : options;
    let dispatched = false;
    const runMessage = () => {
      dispatched = true;
      return processMessage(message, write, dispatchOptions);
    };
    try {
      await scheduler.run({ lane, kind, signal: dispatchOptions.signal }, runMessage);
    } catch (error) {
      if (!dispatched && error?.code === 'ABORT_ERR' && dispatchOptions.signal?.aborted) {
        // A queued cancellation has not entered the registry. Run its existing
        // pre-dispatch refusal now so the caller gets one typed terminal reply.
        try { await runMessage(); } catch (replyError) { reportError(replyError); }
      } else reportError(error);
    } finally {
      if (controller && controllers.get(requestKey) === controller) controllers.delete(requestKey);
    }
  }

  handle.stats = () => ({ parallel: parallel.stats(), serial: serial.stats(), cancellable: controllers.size });
  return handle;
}

function recordMcpSurface(options = {}) {
  const recorder = options.recordStartup || mcpToolSurface.recordStartup;
  return recorder({
    transport: options.transport || 'stdio-direct',
    tools: options.tools || listTools()
  });
}

/**
 * The permission ceiling this stdio broker runs under.
 *
 * ABSENCE MUST MEAN REFUSAL, AND HERE IT DID NOT. src/lib/tool-registry.js runs
 * its tier check only `if (context.permissionSession !== undefined)`, and
 * start() never set one -- it accepted an `options` object and forwarded it to
 * recordMcpSurface alone, so `processLine(line)` was called with no options at
 * all and the conditional spread in dispatch() yielded nothing. Every locally
 * spawned agent therefore reached the tool surface with the tier check never
 * running. The narrowing that DID apply was TOOLSENABLED_TOOL_ALLOWLIST, which
 * is a name filter written into a generated .mcp.json; the strictly stronger
 * effect-based check this resolves was dead on the local path.
 *
 * That is the third instance of one shape in this codebase -- an absent
 * `allowlisted` flag reading as the full surface, an absent `tierCheck` reading
 * as approval with no ceiling, and this. So this function has exactly one
 * postcondition: it ALWAYS returns a session. There is no branch that returns
 * undefined, because undefined is the value that means "no ceiling".
 *
 * Unreadable, absent, or unrecognised all resolve to the most restrictive level
 * the product offers rather than to a wider one. A machine that has never run
 * setup has never been granted anything, and an installation whose record we
 * cannot read is exactly the one not to guess generously about.
 */
function resolvePermissionSession({
  permissionSession,
  machineRecord = require('./lib/setup/machine-record'),
  permissionTierPolicy = require('./lib/permission-tier-policy'),
  agentConfinement = require('./lib/agent-session-confinement')
} = {}) {
  if (permissionSession !== undefined) return permissionSession;
  try {
    const record = machineRecord.readMachineRecord({ servicesRoot: machineRecord.resolveServicesRoot({}) });
    if (record) return permissionTierPolicy.installTierSessionFromRecord(record);
  } catch (error) {
    // WAS an empty catch. Falling back to the fail-closed tier here is correct
    // and stays exactly as it was -- the defect was that the reason reached
    // nobody. This branch runs only when a record EXISTS and could not be
    // trusted (machine-record.js's SetupRefusal family:
    // SETUP_MACHINE_RECORD_TAMPERED/_MALFORMED/_INVALID/_UNREADABLE, chiefly a
    // failed integrity-seal check). `record` coming back null with no throw --
    // the ordinary "this machine never ran setup" state -- does not reach this
    // catch at all and stays silent on purpose; absence is documented in
    // machine-record.js as the normal case, not a fault.
    //
    // Reported two ways so a degraded install stops looking healthy:
    //  1. stderr, immediately -- never stdout, which is the MCP protocol
    //     channel the `input.on('line')` loop below reads and writes; one
    //     stray byte there corrupts the JSON-RPC stream for every client.
    //     Same channel this file already uses for out-of-band failures (see
    //     that same loop's own `process.stderr.write`).
    //  2. carried on the returned session as `.degraded`, the one channel that
    //     survives to the system.doctor tools/call response in dispatch()
    //     (see annotateDoctorDegradation above) -- doctor() in
    //     src/lib/system-status.js has no notion of this session's own seal
    //     check, so the reason has to ride along with the session itself.
    return degradedFailClosedSession(error, permissionTierPolicy, agentConfinement);
  }
  return permissionTierPolicy.installTierSession(agentConfinement.FAIL_CLOSED_TIER);
}

// The reason a session fell back to the fail-closed tier, attached to the
// session object itself rather than kept in module-level state. Tests
// exercise both the healthy and the broken path from the same process
// (tests/agent-session-confinement.test.js, tests/entry/mcp-contract.js), and
// a shared mutable "last reason" would let one call's failure leak into
// another call's healthy result a moment later. `session()` in
// permission-tier-policy.js already rebuilds a clean {origin,tier,profile}
// object from whatever it is handed, so this extra property is inert
// everywhere permission enforcement actually reads the session -- it exists
// only for annotateDoctorDegradation() to notice.
function degradedFailClosedSession(error, permissionTierPolicy, agentConfinement) {
  const code = error && typeof error.code === 'string' ? error.code : 'PERMISSION_SESSION_RECORD_UNREADABLE';
  const reason = publicMessage(error);
  process.stderr.write(
    `[toolsenabled] machine-record integrity check failed (${code}); the MCP tool surface is falling back to the fail-closed permission tier: ${reason}\n`
  );
  return Object.freeze({
    ...permissionTierPolicy.installTierSession(agentConfinement.FAIL_CLOSED_TIER),
    degraded: Object.freeze({ code, reason })
  });
}

function start(startOptions = {}) {
  const options = startOptions;
  // The direct MCP broker can also be stopped by its parent without a
  // preceding stdin EOF. Close SQLite explicitly so WAL sidecars settle.
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.once(signal, () => {
      try { require('./lib/state-store').closeStateStore(); } catch {}
      process.exit(0);
    });
  }
  // Surface reporting is diagnostic only: an unavailable state store must not
  // make an otherwise usable stdio transport disappear. `system.doctor` will
  // report UNKNOWN/UNAVAILABLE rather than treating this process as fresh.
  try { recordMcpSurface({ ...options, transport: 'stdio-direct' }); } catch {}
  // Resolved ONCE, before the first line is read. Resolving per call would let a
  // record edited mid-session widen a running agent's ceiling without restart.
  const permissionSession = resolvePermissionSession(options);
  // One anonymous scope belongs to this actual stdin transport, not every
  // caller of processMessage in this process. Other transports must supply
  // their own private authenticated scope instead of sharing a fallback.
  const directFileScope = fileToolContext.createFileToolContext({ scopeKind: 'standalone-mcp' });
  const lineOptions = { ...options, permissionSession, fileToolContext: directFileScope };
  openLastWords(options);
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  // Calls are scheduled by effect (see createLineDispatcher): reads run side
  // by side, writes keep their arrival order, and `tools.throughput = strict`
  // restores the one-at-a-time chain this used to be.
  const handle = createLineDispatcher();
  const activeRequests = new Set();
  input.on('line', line => {
    noteLastWordsRequest(line);
    const request = handle(line, undefined, lineOptions, 'stdio')
      .catch(error => process.stderr.write(`${publicMessage(error)}\n`));
    activeRequests.add(request);
    request.finally(() => activeRequests.delete(request));
  });
  /* THE MOMENT THE PARENT WENT AWAY, written down.
   *
   * This is how both servers in that crashed pair actually ended: their client
   * closed stdin, readline closed, the loop drained, and the process exited. A
   * reader comparing this timestamp against a crash dump's header time can tell
   * a shutdown that raced teardown from a process killed mid-call. */
  input.on('close', () => {
    const closures = [];
    closures.push(fileToolContext.retireFileToolContext(directFileScope, 'stdio-closed')
      .catch(error => process.stderr.write(`[toolsenabled] file-scope closure could not be persisted (${error.code || 'CLOSURE_FAILED'}).\n`)));
    if (lastWords.state !== null) {
      lastWords.state.stdinClosedAt = new Date().toISOString();
      writeLastWords();
    }
    Promise.allSettled([...activeRequests, ...closures]).then(() => {
      try { require('./lib/state-store').closeStateStore(); }
      catch (error) { process.stderr.write(`[toolsenabled] state close failed (${error.code || 'CLOSURE_FAILED'}).\n`); }
    });
  });
}

if (require.main === module) {
  /* A declared agent identity or session credential needs the Fleet host to
   * bind it, and a server started directly has none. Refuse rather than serve
   * such a caller anonymously or treat a caller-written TOOLSENABLED_AGENT_ID
   * as authority.
   * An empty value means absent: generated documents stamp '' for "anonymous
   * on purpose", and boundAgentId() reads it the same way. */
  const declaredIdentity = value => typeof value === 'string' && value !== '';
  if (declaredIdentity(process.env.TOOLSENABLED_AGENT_SESSION_CREDENTIAL)
      || declaredIdentity(process.env.TOOLSENABLED_AGENT_ID)) {
    process.stderr.write('REFUSING TO SERVE: a declared agent identity must be bound by Fleet\'s host entry, and a server started directly cannot bind it.\n');
    process.exitCode = 1;
  } else {
    start();
  }
}

module.exports = {
  MAX_MESSAGE_BYTES, RpcError, SUPPORTED_PROTOCOLS,
  LAST_WORDS_SAMPLE_MS, closeLastWordsForTests, lastWordsMemory, noteLastWordsRequest,
  openLastWords, writeLastWords,
  bindAgentActor, boundAgentId, classifyMessage, createLineDispatcher, dispatch, errorResponse, installTierOfSession, processLine, processMessage, publicMessage,
  recordMcpSurface, resolvePermissionSession, sessionInstructions, snapshotAllowedToolNames,
  start, toolError, toolResult
};
