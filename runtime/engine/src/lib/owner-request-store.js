'use strict';

// The durable request ledger's write API and scope-aware reader: the
// person's standing rules (R), and the tasks (T) and asks (A) agents file.
//
// WHAT IS WRITTEN, AND WHERE.
//   reports/OWNER-REQUEST-LEDGER.json          the record (one JSON document)
//   state/owner-request-record-events.jsonl    the history chain (append-only)
// Both resolve lazily through runtime-state-root.statePath at call time.
// `options.rootPath` overrides both for isolated callers.
//
// READS NEVER CREATE FILES. An absent ledger answers exists:false and empty
// lists. The first write creates them.
//
// Audit admission is handled by the agent tool path. The hash chain below is
// the store's tamper-evident record.
//
// The durable primitives stay local, avoiding a synchronous process probe on
// the first request. This file carries its own atomic write (temp + fsync +
// read-back + .bak + rename), its own shape check, its own finalize and its own
// lock. Every ledger writer shares `<ledger>.lock`, preventing concurrent
// read-modify-write operations. The protocol is described above acquireLock.
//
// DELETE IS A TOMBSTONE. Nothing is ever spliced out of requests[]: a removed
// record keeps its number (never reissued), its words and its history, with
// status 'removed'. Filing, declining or removing a standing rule refuses any
// actor but the person's.
//
// THE PERSON'S ACTOR VALUE IS A CONVENTION, NOT A CREDENTIAL. This store trusts
// the actor supplied by its caller. MCP agent calls pass through
// src/lib/r-ledger-agent-gate.js and src/lib/minor-ledger-agent-gate.js, which
// cannot supply the person's actor.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { statePath } = require('./runtime-state-root');
const { isRequestId, parseRequestId } = require('./request-id');
const { normalizeProvenance } = require('./owner-request-provenance');
const { readWaitingFor, assertTaskDependencies } = require('./task-waiting');
const { TASK_DIFFICULTY_SETTING_ID, newTaskDifficultyFields } = require('./task-difficulty');

const LEDGER_FILE = 'reports/OWNER-REQUEST-LEDGER.json';
const HISTORY_FILE = 'state/owner-request-record-events.jsonl';
const LOCK_SUFFIX = '.lock';
const LOCK_WRITER = 'owner-request-store';

const SCOPES = Object.freeze(['global', 'session', 'tree', 'thread']);
const SCOPE_WORD = Object.freeze({
  global: 'every agent',
  session: 'this session and everything it spawns',
  tree: 'this agent and every agent below it',
  thread: 'this agent, this conversation only'
});
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_WORDS_BYTES = 16 * 1024;
const MAX_FILED_BY_CHARS = 80;
const MAX_LABEL_CHARS = 120;
const MAX_REASON_BYTES = 2048;
const MAX_LEDGER_BYTES = 64 * 1024 * 1024;
const MAX_EVENT_BYTES = 8192;
const MAX_EVENTS = 250000;
const SCHEMA_VERSION = 1;

const STATUS_VOCABULARY = Object.freeze({
  proposed: 'Filed by an agent; waiting for you.',
  open: 'Accepted, not started.',
  'in-progress': 'Actively being worked.',
  partial: 'Substantially delivered with a stated shortfall.',
  'blocked-external': 'Cannot proceed without owner action.',
  done: 'Delivered and independently verified.',
  'not-possible-as-asked': 'The literal request cannot be satisfied.',
  superseded: 'Replaced by a later rule; kept for the record.',
  declined: 'You declined it.',
  removed: 'You deleted it; kept for the record.'
});
const ACTIVE_STATUSES = Object.freeze(new Set(['open', 'in-progress', 'partial', 'blocked-external']));
const HIDDEN_STATUSES = Object.freeze(new Set(['declined', 'removed']));
// A rule the person may decline: one that still stands, or one an agent suggested.
const DECLINABLE_RULE_STATUSES = Object.freeze(new Set(['proposed', ...ACTIVE_STATUSES]));
// How many tasks and asks one subagent may file. A subagent's own Fleet server
// carries its node id, and each record it files keeps that id, so one subagent
// cannot bury the person's ledger under its filings. The person and the lead
// session are not counted here.
const SUBAGENT_OPEN_FILINGS = 20;
const SUBAGENT_TOTAL_FILINGS = 100;
const CLOSED_FILING_STATUSES = Object.freeze(new Set(['done', 'answered', 'declined', 'removed', 'superseded', 'not-possible-as-asked']));
// 'drift-observed' is informational: the store found a record that differed
// from the chain's last word on it as a write touched it, and recorded the
// two hashes before recording the write. It never speaks for the record.
/* The chain READER validates every line's kind against this list, so a writer
   whose kind is missing here appends a line the reader then rejects. A new
   event kind and its writer land together or neither lands. */
const EVENT_KINDS = Object.freeze(['file', 'remove', 'decline', 'drift-observed', 'complete', 'answer', 'resolve']);
const BOM = '\uFEFF';

// ---------------------------------------------------------------------------
// Kinds -- one ledger file holds three record families. R records are the
// person's standing requests. T records are work items that an agent may
// close out and delete. A records are questions or needs an agent raises
// for the person to answer. T and A reuse R's construction: flat-numbered
// families sharing the same ledger file, the same lock, the same hash chain
// (kind is deliberately not part of the hashed core) and the same atomic
// write.
// ---------------------------------------------------------------------------

const KIND_ID_RE = Object.freeze({
  T: /^T([1-9]\d*)$/,
  A: /^A([1-9]\d*)$/
});
const KIND_LABEL = Object.freeze({ R: 'rule', T: 'task', A: 'ask' });

// Exported so a caller can show the right word for the right kind; never
// written into the ledger document (statusVocabulary on disk stays R's
// alone, built by finalize() exactly as it always was).
const TASK_STATUS_VOCABULARY = Object.freeze({
  open: 'Filed; a one-shot task, not yet done.',
  'in-progress': 'Actively being worked.',
  done: 'Completed.',
  recurring: 'A repeating task; each run logs a completion and it stays recurring.',
  'blocked-external': 'Cannot proceed without owner action.',
  superseded: 'Replaced by a newer task; terminal, like done or removed.',
  removed: 'Deleted; kept for the record.'
});
const ASK_STATUS_VOCABULARY = Object.freeze({
  open: 'Filed by an agent; waiting for you to answer.',
  answered: 'You answered it.',
  declined: 'You declined to answer it.',
  removed: 'Deleted; kept for the record.'
});
const TASK_COMPLETABLE_STATUSES = Object.freeze(new Set(['open', 'in-progress', 'recurring']));
const ASK_ANSWERABLE_STATUSES = Object.freeze(new Set(['open']));
const ASK_DECLINABLE_STATUSES = Object.freeze(new Set(['open']));

/** The kind (R, T or A) a ledger id belongs to, read from its own spelling. Null for anything else. */
function idKind(id) {
  if (isRequestId(id, { family: 'R' })) return 'R';
  if (typeof id !== 'string') return null;
  for (const kind of ['T', 'A']) if (KIND_ID_RE[kind].test(id)) return kind;
  return null;
}

/** A record's own kind: the stored field once one is written; the id's letter for a legacy row that predates it. */
function recordKindOf(entry) {
  if (plain(entry) && typeof entry.kind === 'string' && KIND_LABEL[entry.kind]) return entry.kind;
  return plain(entry) && typeof entry.id === 'string' ? idKind(entry.id) : null;
}

function assertKindId(kind, id) {
  if (typeof id !== 'string' || !KIND_ID_RE[kind].test(id)) {
    fail('R_LEDGER_ID_INVALID', `${KIND_LABEL[kind]} ids look like ${kind}1, ${kind}2, ...`);
  }
  return id;
}

/* The next number for one kind, over the file and the chain both -- the same
   never-reissue rule a standing rule's number follows. */
function nextKindNumber(kind, document, chain) {
  let highest = 0;
  for (const entry of document.data.requests) {
    if (plain(entry) && typeof entry.id === 'string' && KIND_ID_RE[kind].test(entry.id)) {
      highest = Math.max(highest, Number(KIND_ID_RE[kind].exec(entry.id)[1]));
    }
  }
  for (const event of chain.events) {
    if (typeof event.requestId === 'string' && KIND_ID_RE[kind].test(event.requestId)) {
      highest = Math.max(highest, Number(KIND_ID_RE[kind].exec(event.requestId)[1]));
    }
  }
  return highest + 1;
}
const PERSON = 'owner';
const FILED_BY_PATTERN = /^[^\r\n\t\0]{1,80}$/;

const GENESIS_SHA256 = sha256('owner-request-record-events:genesis');
const TRANSIENT_WRITE_CODES = new Set(['EACCES', 'EBUSY', 'ENOTEMPTY', 'EPERM']);
const WRITE_ATTEMPTS = 8;
const LOCK_WAIT_ATTEMPTS = 10;
const LOCK_WAIT_MS = 25;

class OwnerRequestStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OwnerRequestStoreError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new OwnerRequestStoreError(code, message);
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// Sorted-key canonical JSON, the same formula tools/ledger-archive.js uses for
// its overlay: key order and whitespace never read as a change; content does.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value === undefined ? null : value);
}

function chainHash(previousSha256, event) {
  const { eventSha256, ...core } = event;
  void eventSha256;
  return sha256(`${previousSha256}\n${canonical(core)}`);
}

function todayString(now) {
  return now.toISOString().slice(0, 10);
}

function waitSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

// ---------------------------------------------------------------------------
// Where the files are
// ---------------------------------------------------------------------------

function filesFor(options = {}) {
  const opts = plain(options) ? options : {};
  if (typeof opts.ledgerFile === 'string' && opts.ledgerFile) {
    const ledgerFile = path.resolve(opts.ledgerFile);
    const historyFile = typeof opts.historyFile === 'string' && opts.historyFile
      ? path.resolve(opts.historyFile)
      : path.join(path.dirname(path.dirname(ledgerFile)), 'state', 'owner-request-record-events.jsonl');
    return { ledgerFile, historyFile };
  }
  if (typeof opts.rootPath === 'function') {
    return {
      ledgerFile: opts.rootPath('reports', 'OWNER-REQUEST-LEDGER.json'),
      historyFile: opts.rootPath('state', 'owner-request-record-events.jsonl')
    };
  }
  return {
    ledgerFile: statePath('reports', 'OWNER-REQUEST-LEDGER.json'),
    historyFile: statePath('state', 'owner-request-record-events.jsonl')
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function assertScope(scope) {
  if (!SCOPES.includes(scope)) fail('R_LEDGER_SCOPE_INVALID', `scope must be one of ${SCOPES.join(', ')}.`);
  return scope;
}

function assertKey(scope, key, { strict = false } = {}) {
  if (scope === 'global') {
    if (strict && typeof key === 'string' && key.trim() !== '') {
      fail('R_LEDGER_KEY_INVALID', 'a global request takes no key; leave it out.');
    }
    return null;
  }
  if (typeof key !== 'string' || !SAFE_KEY.test(key)) {
    fail('R_LEDGER_KEY_INVALID', `a ${scope} request needs its ${scope} id (letters, digits, . _ -).`);
  }
  return key;
}

function normalizeWords(words) {
  if (typeof words !== 'string') fail('R_LEDGER_WORDS_INVALID', 'the request must be text.');
  const trimmed = words.replace(/\r\n/g, '\n').trim();
  if (!trimmed) fail('R_LEDGER_WORDS_EMPTY', 'the request is empty; nothing to file.');
  if (Buffer.byteLength(trimmed, 'utf8') > MAX_WORDS_BYTES) fail('R_LEDGER_WORDS_TOO_LONG', `the request exceeds ${MAX_WORDS_BYTES} bytes.`);
  return trimmed;
}

function normalizeFiledBy(filedBy) {
  if (filedBy === undefined || filedBy === null) return PERSON;
  if (typeof filedBy !== 'string') fail('R_LEDGER_FILED_BY_INVALID', 'filedBy must be text.');
  const trimmed = filedBy.trim();
  if (!trimmed) return PERSON;
  if (trimmed.length > MAX_FILED_BY_CHARS || !FILED_BY_PATTERN.test(trimmed)) {
    fail('R_LEDGER_FILED_BY_INVALID', `filedBy must be one line of at most ${MAX_FILED_BY_CHARS} characters.`);
  }
  return trimmed;
}

function normalizeLabel(label) {
  if (label === undefined || label === null) return null;
  if (typeof label !== 'string') fail('R_LEDGER_LABEL_INVALID', 'the label must be text.');
  const trimmed = label.replace(/\s+/g, ' ').trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_LABEL_CHARS) fail('R_LEDGER_LABEL_INVALID', `the label must be at most ${MAX_LABEL_CHARS} characters.`);
  return trimmed;
}

function normalizeReason(reason) {
  if (reason === undefined || reason === null) return null;
  if (typeof reason !== 'string') fail('R_LEDGER_REASON_INVALID', 'the reason must be text.');
  const trimmed = reason.replace(/\r\n/g, '\n').trim();
  if (!trimmed) return null;
  if (Buffer.byteLength(trimmed, 'utf8') > MAX_REASON_BYTES) fail('R_LEDGER_REASON_INVALID', `the reason exceeds ${MAX_REASON_BYTES} bytes.`);
  return trimmed;
}

function assertPerson(actor) {
  if (actor !== PERSON) fail('R_LEDGER_PERSON_REQUIRED', `Only the person edits, deletes, approves or declines a request. Ask them to do it ${require('./ledger-place').ledgerPlace()}.`);
}

function assertId(id) {
  if (!isRequestId(id, { family: 'R' })) fail('R_LEDGER_ID_INVALID', 'ids look like R12, or a refinement like R12.1.');
  return id;
}

function clockOf(now) {
  if (typeof now === 'function') return () => new Date(now());
  return () => new Date();
}

// ---------------------------------------------------------------------------
// Reading the record
// ---------------------------------------------------------------------------

function emptyLedger() {
  return { schemaVersion: SCHEMA_VERSION, revision: 0, updatedAt: todayString(new Date()), statusVocabulary: { ...STATUS_VOCABULARY }, requests: [] };
}

function validateShape(data, ledgerFile) {
  const name = path.basename(ledgerFile);
  if (!plain(data)) fail('R_LEDGER_SHAPE_INVALID', `${name} is not a JSON object.`);
  if (!Array.isArray(data.requests)) fail('R_LEDGER_SHAPE_INVALID', `${name} has no requests list.`);
  const seen = new Set();
  for (const entry of data.requests) {
    if (!plain(entry) || typeof entry.id !== 'string' || !entry.id) fail('R_LEDGER_SHAPE_INVALID', `${name} has a request with no id.`);
    if (seen.has(entry.id)) fail('R_LEDGER_SHAPE_INVALID', `${name} lists ${entry.id} twice.`);
    seen.add(entry.id);
  }
}

/* The document as it is on disk: { exists, raw, data }. Absent -> an empty
   document and raw ''. Unreadable bytes are a refusal, never an empty ledger:
   a caller must not file R1 over a record it could not read. `written` (only
   from readDocumentForWrite) is the document this process last wrote; it
   stands in for the parse only when the file holds exactly its text. */
function readDocument(ledgerFile, written = null) {
  let stat;
  try {
    stat = fs.statSync(ledgerFile);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      if (backupUsable(ledgerFile)) {
        fail('R_LEDGER_RESET_PARTIAL', 'the Ledger document is absent while its non-empty .bak remains; recovery must reconcile the reset before new owners can be admitted.');
      }
      return { exists: false, raw: '', data: emptyLedger() };
    }
    throw error;
  }
  if (stat.size > MAX_LEDGER_BYTES) fail('R_LEDGER_TOO_LARGE', `the ledger exceeds ${MAX_LEDGER_BYTES} bytes.`);
  const raw = fs.readFileSync(ledgerFile, 'utf8');
  if (written && raw === written.raw) return { exists: true, raw, data: written.data };
  let data;
  // An editor that saved the file with a byte-order mark did not change the record.
  try { data = JSON.parse(raw.startsWith(BOM) ? raw.slice(BOM.length) : raw); } catch {
    fail('R_LEDGER_UNREADABLE', `the ledger is not valid JSON.${backupUsable(ledgerFile) ? ' Restore it from the .bak beside it, then try again.' : ' Restore it from a backup, then try again.'}`);
  }
  validateShape(data, ledgerFile);
  return { exists: true, raw, data };
}

/* Only a .bak that exists and holds bytes is worth pointing the person at. */
function backupUsable(ledgerFile) {
  try { return fs.statSync(`${ledgerFile}.bak`).size > 0; } catch { return false; }
}

/* A LEDGER THAT HAS NOT CHANGED IS NOT PARSED AGAIN.
 *
 * Every agent Ledger lookup (ledger.read, a one-id find, a boot stack) goes
 * through readAll(). Parsing the WHOLE document on every call costs tens of
 * milliseconds for a ledger of several megabytes, and agents can call
 * ledger.read thousands of times in a session.
 *
 * So the parsed document is kept between reads, keyed by the file itself: the
 * same (dev, ino, size, mtime, ctime) stamp historyStamp() uses for the history
 * file. Any write through this store drops it (atomicWrite), and any other
 * writer -- another process, a hand edit, a restore -- changes the stamp, so
 * the next read parses the new bytes in full. Only a successful, validated
 * parse is kept; an unreadable or mis-shaped file is refused on every read.
 *
 * NOT ONE FIELD ALONE. Windows can report ino 0 and some file systems keep
 * mtime to the second or two, so no single field decides. And a file changed
 * in place within one timestamp tick of the read that cached it could keep
 * every field -- Windows moves file times on its 15.6 ms clock tick, so an
 * edit that restores the old mtime can leave even the change time as it was
 * -- so a document is only kept once BOTH its modification and its change
 * time are older than that tick: 3 s when either is reported in whole
 * milliseconds or coarser (FAT keeps 2 s), 50 ms otherwise. A read of a file
 * changed more recently than that simply parses it again. Aging only the
 * mtime is not enough: a same-size edit in place that restored the mtime would
 * be served from the kept copy.
 *
 * NEVER SHARED MUTABLE. The kept document is deep-frozen before anyone sees
 * it, and read-only callers receive it as it is: readAll()'s records point
 * into it, so a caller that tries to change a returned record's gates,
 * decisions or history throws instead of changing what the next reader sees.
 * Writers never get it: transact() and the lock-holding previews read the
 * file fresh, exactly as before, because they change what they read.
 *
 * BOUNDED: a handful of Ledger files per process, oldest first. */
const SHARED_LEDGER_DOCUMENTS = 4;
const COARSE_LEDGER_TIMESTAMP_MS = 3000;
const FINE_LEDGER_TIMESTAMP_MS = 50;
const sharedLedgerDocuments = new Map();

function deepFreezeDocument(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreezeDocument(child);
  }
  return value;
}

function ledgerStamp(ledgerFile) {
  const stat = fs.statSync(ledgerFile, { bigint: true });
  const nanoseconds = (ns, ms) => BigInt(ns ?? Math.round(Number(ms) * 1e6));
  const mtimeNs = nanoseconds(stat.mtimeNs, stat.mtimeMs);
  const ctimeNs = nanoseconds(stat.ctimeNs, stat.ctimeMs);
  const changedNs = ctimeNs > mtimeNs ? ctimeNs : mtimeNs;
  return {
    isFile: stat.isFile(),
    key: [stat.dev, stat.ino, stat.size, mtimeNs, ctimeNs].map(String).join(':'),
    changedMs: Number(changedNs / 1000000n),
    coarse: mtimeNs % 1000000n === 0n || ctimeNs % 1000000n === 0n
  };
}

function settledLedgerStamp(stamp) {
  return Date.now() - stamp.changedMs > (stamp.coarse ? COARSE_LEDGER_TIMESTAMP_MS : FINE_LEDGER_TIMESTAMP_MS);
}

function forgetSharedLedgerDocument(ledgerFile) {
  sharedLedgerDocuments.delete(ledgerFile);
}

/* The document for a caller that only reads it: { exists, data }, data
   deep-frozen. Same refusals as readDocument(), which it uses for every fill. */
function readSharedDocument(ledgerFile) {
  let before = null;
  try { before = ledgerStamp(ledgerFile); }
  catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
  const known = before && sharedLedgerDocuments.get(ledgerFile);
  if (known && known.key === before.key) return known.document;
  if (!before) forgetSharedLedgerDocument(ledgerFile);
  const fresh = readDocument(ledgerFile);
  const document = Object.freeze({ exists: fresh.exists, data: deepFreezeDocument(fresh.data) });
  if (!before || !before.isFile || !fresh.exists || !settledLedgerStamp(before)) return document;
  let after = null;
  try { after = ledgerStamp(ledgerFile); } catch { return document; }
  if (after.key !== before.key) return document;
  sharedLedgerDocuments.delete(ledgerFile);
  sharedLedgerDocuments.set(ledgerFile, { key: before.key, document });
  while (sharedLedgerDocuments.size > SHARED_LEDGER_DOCUMENTS) {
    sharedLedgerDocuments.delete(sharedLedgerDocuments.keys().next().value);
  }
  return document;
}

/* A LEDGER WRITE PARSES THE LEDGER ONCE, NOT THREE TIMES.
 *
 * A Ledger write (an agent's t_ledger.progress, a filing, a decision) could
 * parse the whole document three times: to read it (transact ->
 * readDocument), to check the text it was about to write, and again to check
 * the temp file after the fsync. For a ledger of several megabytes that costs
 * hundreds of milliseconds per write.
 *
 * The temp file is now checked BYTE FOR BYTE against the text that was checked
 * before it was written (writeLedgerFile). Identical bytes parse identically,
 * and any difference -- a short write, one changed byte, even one that still
 * parses -- is refused before the rename, so the check is stricter than the
 * parse it replaces.
 *
 * And the document this process last wrote -- the parse of exactly the text now
 * on disk, already checked -- is kept for the NEXT write only. That write still
 * reads the file under the lock (the .bak needs its bytes anyway) and uses the
 * kept document only when the file holds exactly the text this process wrote.
 * Another writer, a hand edit or a restore in between makes the text differ,
 * and the file is parsed and checked in full, exactly as before, so a change
 * made elsewhere is never written over. It is handed out once, because the
 * write changes what it is given: a refused or no-op write leaves nothing
 * behind, and the write after it reads the file in full.
 *
 * Readers never see it: they get the frozen read memo above, which a writer
 * cannot use because writers change what they read (a copy costs more than
 * the parse). verifyHistory and the lock-holding previews read the file fresh.
 * The file's format is unchanged: it stays pretty-printed, as earlier writers
 * of this file wrote it.
 *
 * BOUNDED: a handful of Ledger files per process, oldest first. */
const WRITTEN_LEDGER_DOCUMENTS = 4;
const writtenLedgerDocuments = new Map();

function keepWrittenLedgerDocument(ledgerFile, written) {
  writtenLedgerDocuments.delete(ledgerFile);
  writtenLedgerDocuments.set(ledgerFile, written);
  while (writtenLedgerDocuments.size > WRITTEN_LEDGER_DOCUMENTS) {
    writtenLedgerDocuments.delete(writtenLedgerDocuments.keys().next().value);
  }
}

/* The document for the writer that holds the lock: what readDocument() answers,
   data private and changeable. */
function readDocumentForWrite(ledgerFile) {
  const written = writtenLedgerDocuments.get(ledgerFile) || null;
  writtenLedgerDocuments.delete(ledgerFile);
  return readDocument(ledgerFile, written);
}

function parentIdOf(id) {
  const parsed = parseRequestId(id);
  if (!parsed || parsed.segments.length === 0) return null;
  const above = parsed.segments.slice(0, -1);
  return `${parsed.root}${above.length ? `.${above.join('.')}` : ''}`;
}

// Preserve absent legacy fields on reads and ordinary writes. Malformed saved
// fields remain visible; explicit grading/review operations validate them.
function taskDifficultyFields(entry) {
  if (recordKindOf(entry) !== 'T') return {};
  const fields = {};
  for (const key of ['difficulty', 'failedReviewCount']) {
    if (Object.prototype.hasOwnProperty.call(entry, key)) fields[key] = entry[key];
  }
  return fields;
}

// Called only inside the store transaction. The hook is an internal host/test
// dependency, never a tool payload flag or a renderer settings snapshot.
function taskDifficultyEnabled(options) {
  try {
    const read = options.loadSettings || require('./settings').loadSettings;
    const snapshot = read();
    if (!plain(snapshot) || typeof snapshot.then === 'function' || !plain(snapshot.values)) throw new Error('settings unavailable');
    if (Array.isArray(snapshot.rejected) && snapshot.rejected.some(row => row?.id === '*' || row?.id === TASK_DIFFICULTY_SETTING_ID)) throw new Error('rejected grading setting');
    const enabled = snapshot.values[TASK_DIFFICULTY_SETTING_ID];
    if (enabled !== undefined && typeof enabled !== 'boolean') throw new Error('invalid grading setting');
    return enabled === true;
  } catch {
    fail('T_LEDGER_DIFFICULTY_SETTINGS_UNAVAILABLE', 'The saved task difficulty setting could not be read. Try again before filing or reviewing this task.');
  }
}

/* One record as the readers see it. Records written by older tools have no
   scopeKey/filedBy/history; they normalise here and are never rewritten by a
   read. */
function normalizeRecord(entry) {
  const parsed = parseRequestId(entry.id);
  const scope = SCOPES.includes(entry.scope) ? entry.scope : 'global';
  const captureLog = Array.isArray(entry.captureLog) ? entry.captureLog : [];
  const firstCapture = captureLog.find(item => plain(item)) || null;
  const provenance = plain(entry.provenance) ? entry.provenance : null;
  const scopeKey = scope === 'global'
    ? null
    : (typeof entry.scopeKey === 'string' && entry.scopeKey ? entry.scopeKey : (typeof entry.threadId === 'string' && entry.threadId ? entry.threadId : null));
  const filedBy = typeof entry.filedBy === 'string' && entry.filedBy
    ? entry.filedBy
    : (firstCapture && typeof firstCapture.actor === 'string' && firstCapture.actor ? firstCapture.actor : null);
  const filedAt = typeof entry.filedAt === 'string' && entry.filedAt
    ? entry.filedAt
    : (firstCapture && typeof firstCapture.at === 'string' ? firstCapture.at : (provenance && typeof provenance.recordedAt === 'string' ? provenance.recordedAt : null));
  const normalized = {
    id: entry.id,
    kind: recordKindOf(entry),
    number: parsed ? parsed.rootNumber : null,
    parentId: typeof entry.parentId === 'string' && entry.parentId ? entry.parentId : parentIdOf(entry.id),
    scope,
    scopeKey,
    scopeLabel: typeof entry.scopeLabel === 'string' && entry.scopeLabel ? entry.scopeLabel : null,
    threadId: scope === 'thread' ? scopeKey : (typeof entry.threadId === 'string' ? entry.threadId : null),
    verbatim: typeof entry.verbatim === 'string' ? entry.verbatim : '',
    request: typeof entry.request === 'string' ? entry.request : null,
    status: typeof entry.status === 'string' ? entry.status : '',
    filedBy,
    filedAt,
    gates: Array.isArray(entry.gates) ? entry.gates : [],
    provenance,
    captureLog,
    decisions: Array.isArray(entry.decisions) ? entry.decisions : [],
    history: Array.isArray(entry.history) ? entry.history : [],
    removedAt: typeof entry.removedAt === 'string' ? entry.removedAt : null,
    removedBy: typeof entry.removedBy === 'string' ? entry.removedBy : null,
    // T/A-only fields. Always present (null/default for every R record and
    // for a T/A record that has not yet reached the state that fills them),
    // so a reader never has to branch on kind to know whether to look.
    recurrence: plain(entry.recurrence) ? entry.recurrence : null,
    completedAt: typeof entry.completedAt === 'string' ? entry.completedAt : null,
    completedBy: typeof entry.completedBy === 'string' ? entry.completedBy : null,
    // T-only: the id it replaces (set only on the new record) and the id that
    // replaced it (set only once superseded). Always present, default null,
    // same pattern as the other T/A-only fields above.
    supersedes: typeof entry.supersedes === 'string' && entry.supersedes ? entry.supersedes : null,
    supersededBy: typeof entry.supersededBy === 'string' && entry.supersededBy ? entry.supersededBy : null,
    answer: plain(entry.answer) ? entry.answer : null,
    ...taskDifficultyFields(entry)
  };
  if (recordKindOf(entry) === 'T' && Object.prototype.hasOwnProperty.call(entry, 'waitingFor')) {
    normalized.waitingFor = readWaitingFor(entry.waitingFor);
  }
  return normalized;
}

function isStoreRecordId(entry) {
  return plain(entry) && isRequestId(entry.id, { family: 'R' });
}

/**
 * Every record, normalised, in file order. Never creates the file.
 * @returns {{exists:boolean, path:string, revision:number|null, updatedAt:string|null, records:object[]}}
 */
/* kinds defaults to ['R'] and nothing else, so the reader that feeds agents
   their standing rules (collectStack) serves ONLY kind R. A caller that wants
   the whole ledger (T and A alongside R, each with its own kind set by
   normalizeRecord above) passes kinds explicitly. */
function readAll({ includeRemoved = false, includeProposed = true, kinds = ['R'], ...rest } = {}) {
  const { ledgerFile } = filesFor(rest);
  const document = readSharedDocument(ledgerFile);
  const records = document.data.requests
    .filter(entry => plain(entry) && typeof entry.id === 'string' && kinds.includes(recordKindOf(entry)))
    .map(entry => normalizeRecord(entry))
    .filter(record => (includeRemoved || !HIDDEN_STATUSES.has(record.status)) && (includeProposed || record.status !== 'proposed'));
  return Object.freeze({
    exists: document.exists,
    path: ledgerFile,
    revision: Number.isInteger(document.data.revision) ? document.data.revision : null,
    updatedAt: typeof document.data.updatedAt === 'string' ? document.data.updatedAt : null,
    records: Object.freeze(records.map(record => Object.freeze(record)))
  });
}

function layerEntry(record) {
  return Object.freeze({
    id: record.id,
    number: record.number,
    parentId: record.parentId,
    stamp: record.filedAt,
    filedBy: record.filedBy,
    words: record.verbatim,
    status: record.status,
    line: null
  });
}

function inLayer(record, scope, key) {
  return record.scope === scope && (scope === 'global' || record.scopeKey === key);
}

/* Reading order for a layer: each entry followed by its refinements, depth
   first, every row carrying its depth (0 for a root). File order is kept among
   siblings. A child whose parent is gone lists at the top with its parentId
   still set, so nothing standing is ever hidden. */
function nestEntries(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const byId = new Set(list.map(entry => entry.id));
  const children = new Map();
  const roots = [];
  for (const entry of list) {
    if (entry.parentId && byId.has(entry.parentId)) {
      if (!children.has(entry.parentId)) children.set(entry.parentId, []);
      children.get(entry.parentId).push(entry);
    } else {
      roots.push(entry);
    }
  }
  const out = [];
  const walk = (entry, depth) => {
    out.push(Object.freeze({ ...entry, depth }));
    for (const child of children.get(entry.id) || []) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  return Object.freeze(out);
}

/**
 * The stack an agent boots with, in reading order: global, then the session,
 * then every ancestor tree layer from the top of the chain down, then the
 * agent's own thread. Active rows only -- never proposed, declined, removed or
 * done. Every layer is listed even when empty, so an agent knows what it read.
 */
function collectStack({ sessionId = null, treeAnchors = [], threadId = null } = {}, options = {}) {
  const all = readAll({ includeRemoved: false, includeProposed: false, ...options });
  const active = all.records.filter(record => ACTIVE_STATUSES.has(record.status));
  const layers = [['global', null]];
  if (sessionId) layers.push(['session', sessionId]);
  for (const anchor of Array.isArray(treeAnchors) ? treeAnchors : []) if (anchor) layers.push(['tree', anchor]);
  if (threadId) layers.push(['thread', threadId]);
  return Object.freeze(layers.map(([scope, key]) => Object.freeze({
    scope,
    key,
    path: all.path,
    exists: all.exists,
    appliesTo: SCOPE_WORD[scope],
    entries: nestEntries(active.filter(record => inLayer(record, scope, key)).map(layerEntry)),
    warnings: Object.freeze([])
  })));
}

/* NUMBERS COME FROM THE FILE AND THE CHAIN TOGETHER. A record spliced out of
   the JSON by hand is gone from the file but not from the history, and its
   number must never be handed to a new request. The chain's events name every
   id ever written, so the highest number is taken over both. A broken chain
   still counts the events before the break. */
function chainedIds(chain) {
  const ids = new Set();
  for (const event of chain.events) if (isRequestId(event.requestId, { family: 'R' })) ids.add(event.requestId);
  return ids;
}

function highestRootNumber(records, chain) {
  let highest = records.reduce((max, record) => Math.max(max, record.number || 0), 0);
  for (const id of chainedIds(chain)) {
    const parsed = parseRequestId(id);
    if (parsed && parsed.rootNumber > highest) highest = parsed.rootNumber;
  }
  return highest;
}

// ---------------------------------------------------------------------------
// The lock
// ---------------------------------------------------------------------------
//
// ONE LOCK FILE FOR EVERY WRITER OF THE LEDGER: `<ledger>.lock`, the file
// the ledger archive and migrations share. The authoritative mutex is a
// nonce-claim directory beside the file, but every holder also publishes this
// fixed JSON status file with an exclusive create, refuses to start while the
// file names a live process, and never treats an unreadable record as
// absence. This store speaks the compatibility half of that protocol: it
// publishes a `{ pid, startedAt, nonce }` record, the legacy shape the digest
// lock's classifyFixedHolder reads, exactly as it publishes its own (a
// complete staged file hard-linked into place, so the public path never has a
// zero-byte interval). So:
//   - a CLI holder is visible to the store: the link fails EEXIST, the record
//     names a live pid, the store waits out its retry window and refuses with
//     R_LEDGER_LOCKED;
//   - a store holder is visible to the CLI: its own publish fails EEXIST, its
//     compatibility inspection finds a live pid whose process started before
//     `startedAt`, and it refuses with OWNER_CAPTURE_LEDGER_LOCKED.
// THE STALENESS RULE IS THE DIGEST LOCK'S. A holder is stale only when its
// process is proven absent (ESRCH). EPERM is alive. A record that cannot be
// read is uncertainty, never absence, and is waited out. Age is never a
// reason. The one part left to the CLI is the recycled-pid check: the digest
// lock proves a pid's generation with a process-start probe (powershell.exe
// on Windows, 5 s cold, on whichever thread asks) and this store does not pay
// for that on the person's /Request; it never reclaims a live pid at all, so
// it is strictly more conservative than the CLI, which does reclaim a store
// record whose pid was recycled, by the `startedAt` rule above. A stale record
// is reclaimed by rename to a nonce-unique quarantine path and a byte check,
// never by check-then-unlink, so a replacement a contender published between
// the read and the reclaim is left standing.

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return !(error && error.code === 'ESRCH'); }
}

/* { state: 'absent' | 'unreadable' | 'held', holder, contents } */
function readLockHolder(lockFile) {
  let contents;
  try { contents = fs.readFileSync(lockFile, 'utf8'); }
  catch (error) {
    if (error && error.code === 'ENOENT') return { state: 'absent', holder: null, contents: null };
    throw error;
  }
  let holder;
  try { holder = JSON.parse(contents); } catch { return { state: 'unreadable', holder: null, contents }; }
  if (!plain(holder) || !Number.isSafeInteger(holder.pid) || holder.pid <= 0) return { state: 'unreadable', holder: null, contents };
  return { state: 'held', holder, contents };
}

function unlinkIfPresent(file) {
  try { fs.unlinkSync(file); }
  catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
}

/* Publish a complete record at the fixed path without ever exposing a partial
   one: stage it, fsync, then link. EEXIST means another holder. A volume that
   refuses hard links falls back to an exclusive create, which still excludes;
   the digest lock's readers poll a short grace window over a zero-byte file. */
function publishLockRecord(lockFile, contents, nonce) {
  const staged = `${lockFile}.publishing.${nonce}.${crypto.randomUUID()}`;
  let descriptor = null;
  try {
    descriptor = fs.openSync(staged, 'wx', 0o600);
    fs.writeFileSync(descriptor, contents, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    try {
      fs.linkSync(staged, lockFile);
    } catch (error) {
      if (error && error.code === 'EEXIST') throw error;
      fs.writeFileSync(lockFile, contents, { flag: 'wx', mode: 0o600 });
    }
  } finally {
    if (descriptor !== null) { try { fs.closeSync(descriptor); } catch { /* the primary error is authoritative */ } }
    unlinkIfPresent(staged);
  }
}

/* The record was classified stale from `observed`. Move it aside, confirm the
   moved bytes are the bytes that were classified and that its holder is still
   absent, then remove it. Anything else restores the file and leaves it. */
function reclaimStaleLock(lockFile, observed, nonce) {
  const again = readLockHolder(lockFile);
  if (again.state === 'absent') return;
  if (again.state !== 'held' || again.contents !== observed.contents) return;
  const quarantine = `${lockFile}.stale.${nonce}.${crypto.randomUUID()}`;
  try { fs.renameSync(lockFile, quarantine); }
  catch (error) { if (error && error.code === 'ENOENT') return; throw error; }
  const moved = readLockHolder(quarantine);
  if (moved.state === 'held' && moved.contents === observed.contents && !pidAlive(moved.holder.pid)) {
    try { unlinkIfPresent(quarantine); } catch { /* verified evidence; leaving it costs nothing */ }
    return;
  }
  try { fs.renameSync(quarantine, lockFile); } catch { /* a new holder published meanwhile; its record stands */ }
}

function releaseLock(lockFile, contents) {
  const observed = readLockHolder(lockFile);
  if (observed.state !== 'held' || observed.contents !== contents) return;
  try { unlinkIfPresent(lockFile); } catch { /* released already */ }
}

function acquireLock(ledgerFile) {
  const lockFile = `${ledgerFile}${LOCK_SUFFIX}`;
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const nonce = crypto.randomUUID();
  const contents = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), nonce, writer: LOCK_WRITER });
  for (let attempt = 0; attempt <= LOCK_WAIT_ATTEMPTS; attempt += 1) {
    try {
      publishLockRecord(lockFile, contents, nonce);
      return { file: lockFile, release: () => releaseLock(lockFile, contents) };
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
    }
    const observed = readLockHolder(lockFile);
    if (observed.state === 'absent') continue;
    if (observed.state === 'held' && !pidAlive(observed.holder.pid)) {
      reclaimStaleLock(lockFile, observed, nonce);
      continue;
    }
    if (attempt < LOCK_WAIT_ATTEMPTS) waitSync(LOCK_WAIT_MS);
  }
  fail('R_LEDGER_LOCKED', 'Another write to the ledger is in progress. Wait a moment and try again.');
  return null;
}

// ---------------------------------------------------------------------------
// The write
// ---------------------------------------------------------------------------

function renameWithRetry(temporary, target) {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    try { fs.renameSync(temporary, target); return; }
    catch (error) {
      if (!TRANSIENT_WRITE_CODES.has(error && error.code) || attempt + 1 >= WRITE_ATTEMPTS) throw error;
      waitSync(25 * (attempt + 1));
    }
  }
}

/* Check the text -> temp file (wx, 0600) -> fsync -> read the bytes back and
   compare them with the checked text byte for byte -> .bak of what was there
   -> one rename. The original changes at the rename only. */
function atomicWrite(ledgerFile, previousRaw, nextData) {
  // Whatever happens below, the next reader parses the file as it then is,
  // and only a write that reached the file leaves a document for the next one.
  forgetSharedLedgerDocument(ledgerFile);
  writtenLedgerDocuments.delete(ledgerFile);
  try { keepWrittenLedgerDocument(ledgerFile, writeLedgerFile(ledgerFile, previousRaw, nextData)); }
  finally { forgetSharedLedgerDocument(ledgerFile); }
}

function writeLedgerFile(ledgerFile, previousRaw, nextData) {
  const serialized = `${JSON.stringify(nextData, null, 2)}\n`;
  const data = JSON.parse(serialized);
  validateShape(data, ledgerFile);
  const bytes = Buffer.from(serialized, 'utf8');
  fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
  const temporary = `${ledgerFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    // The file must hold exactly the text checked above: nothing short, nothing changed.
    if (!bytes.equals(fs.readFileSync(temporary))) {
      fail('R_LEDGER_WRITE_UNCONFIRMED', 'The Ledger change did not read back exactly as it was written, so it was not saved. Everything already on file is kept. Try again.');
    }
    fs.writeFileSync(`${ledgerFile}.bak`, typeof previousRaw === 'string' ? previousRaw : '', 'utf8');
    renameWithRetry(temporary, ledgerFile);
  } finally {
    if (descriptor !== null) { try { fs.closeSync(descriptor); } catch { /* closed */ } }
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* best effort */ }
  }
  return { raw: serialized, data };
}

/* True only when the ledger on disk is still exactly what `document` read:
   absent if it was absent, the same text if not. A read that fails is not
   proof, so it answers false. */
function documentUnchanged(ledgerFile, document) {
  try {
    return document.exists ? fs.readFileSync(ledgerFile, 'utf8') === document.raw : !fs.existsSync(ledgerFile);
  } catch {
    return false;
  }
}

function finalize(data, nextRequests, now) {
  return {
    ...data,
    schemaVersion: SCHEMA_VERSION,
    revision: Number.isInteger(data.revision) ? data.revision + 1 : 1,
    updatedAt: todayString(now),
    statusVocabulary: { ...STATUS_VOCABULARY, ...(plain(data.statusVocabulary) ? data.statusVocabulary : {}) },
    requests: nextRequests
  };
}

// ---------------------------------------------------------------------------
// The history chain
// ---------------------------------------------------------------------------

/* THE CORE THE CHAIN SPEAKS FOR: identity, placement, status, the words, who
   filed, whose word it is (provenance class and recorder) and how many
   decisions the person has taken on it. Gates and their evidence stay out --
   older ledgers carry gate evidence written without a chain event. Reading
   that legacy evidence does not change the request. */
function coreOf(entry) {
  const provenance = plain(entry.provenance) ? entry.provenance : {};
  const core = {
    id: entry.id,
    parentId: typeof entry.parentId === 'string' && entry.parentId ? entry.parentId : parentIdOf(entry.id),
    scope: SCOPES.includes(entry.scope) ? entry.scope : 'global',
    scopeKey: typeof entry.scopeKey === 'string' && entry.scopeKey ? entry.scopeKey : null,
    status: typeof entry.status === 'string' ? entry.status : '',
    verbatim: typeof entry.verbatim === 'string' ? entry.verbatim : '',
    filedBy: typeof entry.filedBy === 'string' && entry.filedBy ? entry.filedBy : null,
    provenanceClass: typeof provenance.class === 'string' ? provenance.class : null,
    provenanceRecordedBy: typeof provenance.recordedBy === 'string' ? provenance.recordedBy : null,
    decisions: Array.isArray(entry.decisions) ? entry.decisions.length : 0,
    removedAt: typeof entry.removedAt === 'string' ? entry.removedAt : null
  };
  if (recordKindOf(entry) === 'T' && Object.prototype.hasOwnProperty.call(entry, 'waitingFor')) {
    core.waitingFor = readWaitingFor(entry.waitingFor);
  }
  Object.assign(core, taskDifficultyFields(entry));
  return core;
}

function coreSha256(entry) {
  return sha256(canonical(coreOf(entry)));
}

/* Every line of the chain, checked as it is read. A break is reported with its
   line, never thrown: verifyHistory is a read and a broken file is an answer. */
function readChain(historyFile) {
  let raw;
  try { raw = fs.readFileSync(historyFile, 'utf8'); }
  catch (error) {
    if (error && error.code === 'ENOENT') return { exists: false, events: [], head: GENESIS_SHA256, broken: null };
    throw error;
  }
  return parseChain(raw);
}

function parseChain(raw) {
  const lines = raw.split('\n').filter(line => line.trim().length > 0);
  const events = [];
  let previous = GENESIS_SHA256;
  if (lines.length > MAX_EVENTS) return { exists: true, events, head: previous, broken: { line: MAX_EVENTS + 1, reason: 'too many events' } };
  for (let index = 0; index < lines.length; index += 1) {
    const where = index + 1;
    let event;
    // A byte-order mark an editor put at the head of a line is not a change to the event.
    const line = lines[index].startsWith(BOM) ? lines[index].slice(BOM.length) : lines[index];
    try { event = JSON.parse(line); } catch { return { exists: true, events, head: previous, broken: { line: where, reason: 'not JSON' } }; }
    if (!plain(event) || event.seq !== where || event.prevSha256 !== previous
        || typeof event.eventSha256 !== 'string' || event.eventSha256 !== chainHash(previous, event)
        || !EVENT_KINDS.includes(event.kind) || typeof event.requestId !== 'string') {
      return { exists: true, events, head: previous, broken: { line: where, reason: 'hash mismatch' } };
    }
    events.push(event);
    previous = event.eventSha256;
  }
  return { exists: true, events, head: previous, broken: null };
}

// Basic writes need the journal's allocation and append position, not a claim
// that its historical contents were authenticated. Keep one compact projection,
// invalidated by every external file change or unconfirmed append. A cold read
// still scans the journal to retain IDs missing from the current document.
// Reconciliation must retain known identities even when a changed file or an
// unconfirmed write makes the cached projection unusable.
const operationalHistories = new Map();

function historyStamp(historyFile, descriptor = null) {
  let stat;
  try { stat = descriptor === null ? fs.statSync(historyFile, { bigint: true }) : fs.fstatSync(descriptor, { bigint: true }); }
  catch (error) { if (descriptor === null && error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile()) fail('R_LEDGER_CHAIN_UNAVAILABLE', 'The task history is not a regular file.');
  const size = Number(stat.size);
  return { size, key: [stat.dev, stat.ino, stat.size, stat.mtimeNs ?? stat.mtimeMs, stat.ctimeNs ?? stat.ctimeMs].map(String).join(':') };
}

function sameHistoryStamp(left, right) {
  return left === null ? right === null : right !== null && left.key === right.key;
}

function operationalEventSummary(event) {
  return {
    requestId: event.requestId,
    kind: event.kind,
    seq: event.seq,
    eventSha256: event.eventSha256,
    coreSha256: event.coreSha256
  };
}
function operationalEvents(events) {
  const latest = new Map();
  for (const event of events) {
    if (event.kind === 'drift-observed' && latest.has(event.requestId)) continue;
    latest.set(event.requestId, operationalEventSummary(event));
  }
  return [...latest.values()];
}

function isHistoryRequestId(id) {
  return idKind(id) !== null;
}

function currentHistoryReferences(data) {
  const references = [];
  for (const entry of data.requests) {
    if (!plain(entry) || !idKind(entry.id)) continue;
    const row = Array.isArray(entry.history) ? entry.history.at(-1) : null;
    if (typeof row?.eventSha256 === 'string' && row.eventSha256) {
      references.push({ requestId: entry.id, seq: row.seq, eventSha256: row.eventSha256 });
    }
  }
  return references;
}

function referenceEvents(events, references) {
  const wanted = new Set(references.map(row => row.seq));
  return new Map(events.filter(event => wanted.has(event.seq)).map(event => [event.seq, {
    requestId: event.requestId, seq: event.seq, eventSha256: event.eventSha256
  }]));
}

function hasCurrentReferences(chain, references) {
  return references.every(row => {
    const event = chain.references.get(row.seq);
    return Number.isSafeInteger(row.seq) && row.seq > 0 && event?.requestId === row.requestId
      && event.eventSha256 === row.eventSha256;
  });
}

function requireKnownReservations(historyFile, events) {
  const known = operationalHistories.get(historyFile);
  if (!known) return;
  const present = new Set(events.map(event => event.requestId));
  if ([...known.reservedIds].some(id => !present.has(id))) {
    fail('R_LEDGER_CHAIN_UNAVAILABLE', 'The task history lost a known record identity. Restore it before filing another record.');
  }
}

function reconcileOperationalHistory(historyFile, chain) {
  const known = operationalHistories.get(historyFile)?.chain;
  if (known && (chain.sequence < known.sequence || chain.priorHead !== known.head)) {
    fail('R_LEDGER_CHAIN_UNAVAILABLE', 'The task history lost or replaced a known append. Restore it before filing another record.');
  }
  requireKnownReservations(historyFile, chain.events);
}

function rememberOperationalHistory(historyFile, chain) {
  const known = operationalHistories.get(historyFile) || { reservedIds: new Set() };
  for (const event of chain.events) known.reservedIds.add(event.requestId);
  known.chain = { ...chain, events: operationalEvents(chain.events), priorHead: chain.head, checked: false };
  known.reusable = true;
  operationalHistories.set(historyFile, known);
}

function readOperationalHistory(historyFile, references) {
  const stamp = historyStamp(historyFile);
  const known = operationalHistories.get(historyFile);
  if (known?.reusable && sameHistoryStamp(known.chain.stamp, stamp) && hasCurrentReferences(known.chain, references)) return known.chain;
  const raw = stamp === null ? '' : fs.readFileSync(historyFile, 'utf8');
  if (!sameHistoryStamp(stamp, historyStamp(historyFile))) fail('R_LEDGER_CHAIN_UNAVAILABLE', 'The task history changed while it was being read. Try again.');
  const rows = raw.split('\n').filter(line => line.trim().length > 0);
  const latest = new Map(), foundReferences = new Map();
  const wanted = new Set(references.map(row => row.seq));
  let previous = GENESIS_SHA256, priorHead = GENESIS_SHA256;
  const broken = (line, reason) => ({ exists: stamp !== null, events: [], head: previous, broken: { line, reason }, stamp });
  if (rows.length > MAX_EVENTS) return broken(MAX_EVENTS + 1, 'too many events');
  if (rows.length && !raw.endsWith('\n')) return broken(rows.length, 'the last append is incomplete');
  for (let index = 0; index < rows.length; index += 1) {
    let event;
    const line = rows[index].startsWith(BOM) ? rows[index].slice(BOM.length) : rows[index];
    try { event = JSON.parse(line); } catch { return broken(index + 1, 'not JSON'); }
    if (!plain(event) || event.seq !== index + 1 || event.prevSha256 !== previous
        || !/^[a-f0-9]{64}$/.test(event.eventSha256 || '') || !/^[a-f0-9]{64}$/.test(event.coreSha256 || '')
        || !EVENT_KINDS.includes(event.kind) || !isHistoryRequestId(event.requestId)) return broken(index + 1, 'invalid append position or record identity');
    if (event.kind !== 'drift-observed' || !latest.has(event.requestId)) {
      latest.set(event.requestId, operationalEventSummary(event));
    }
    if (wanted.has(event.seq)) foundReferences.set(event.seq, {
      requestId: event.requestId, seq: event.seq, eventSha256: event.eventSha256
    });
    if (event.seq === known?.chain.sequence) priorHead = event.eventSha256;
    previous = event.eventSha256;
  }
  return { exists: stamp !== null, events: [...latest.values()], head: previous,
    sequence: rows.length, broken: null, stamp, checked: false, priorHead, references: foundReferences };
}

function readTransactionHistory(historyFile, document, options) {
  const policy = require('./runtime-policy').runtimePolicy(options);
  const references = currentHistoryReferences(document.data);
  let chain;
  // With history verification on, or no readable policy, a write recomputes
  // every hash (readChain); otherwise the fast path checks the declared hash
  // shape and append position (readOperationalHistory).
  if (policy.verifyHistory || !policy.configurationAvailable) {
    const stamp = historyStamp(historyFile);
    chain = { ...readChain(historyFile), stamp };
    if (!sameHistoryStamp(stamp, historyStamp(historyFile))) fail('R_LEDGER_CHAIN_UNAVAILABLE', 'The task history changed while it was being checked. Try again.');
    const knownSequence = operationalHistories.get(historyFile)?.chain.sequence || 0;
    chain.sequence = chain.events.length;
    chain.priorHead = knownSequence ? chain.events[knownSequence - 1]?.eventSha256 : GENESIS_SHA256;
    chain.references = referenceEvents(chain.events, references);
  } else chain = readOperationalHistory(historyFile, references);
  if (chain.broken) fail('R_LEDGER_CHAIN_BROKEN', `The history at line ${chain.broken.line} cannot be used for a new append (${chain.broken.reason}). Check it before writing again.`);
  // Checking a current append's declared identity is separate from optional
  // historical content verification. A matching count cannot settle custody.
  reconcileOperationalHistory(historyFile, chain);
  if (!hasCurrentReferences(chain, references)) {
    fail('R_LEDGER_CHAIN_APPEND_UNCONFIRMED', 'A saved Ledger change has no confirmed history append. Check or recover its history before writing again. If that history is gone, only the person can adopt the Ledger as it stands; ask them. This write was not saved; everything already on file is kept.');
  }
  rememberOperationalHistory(historyFile, chain);
  return chain;
}

function appendChainLine(historyFile, event, expectedStamp) {
  const line = `${JSON.stringify(event)}\n`;
  const bytes = Buffer.byteLength(line, 'utf8');
  if (bytes > MAX_EVENT_BYTES) fail('R_LEDGER_CHAIN_APPEND_FAILED', 'a history event is too large to record.');
  fs.mkdirSync(path.dirname(historyFile), { recursive: true });
  let lastError = null;
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    let descriptor = null, writeAttempted = false, cleanupFailed = false;
    try {
      descriptor = fs.openSync(historyFile, 'a', 0o600);
      const before = historyStamp(historyFile, descriptor);
      if (expectedStamp === null ? before.size !== 0 : !sameHistoryStamp(expectedStamp, before)) {
        fail('R_LEDGER_CHAIN_APPEND_FAILED', 'The history changed before this append could begin.');
      }
      writeAttempted = true;
      const written = fs.writeSync(descriptor, line, null, 'utf8');
      if (written !== bytes) fail('R_LEDGER_CHAIN_APPEND_FAILED', 'The history append was only partly written.');
      fs.fsyncSync(descriptor);
      const after = historyStamp(historyFile, descriptor);
      if (after.size !== before.size + bytes) fail('R_LEDGER_CHAIN_APPEND_FAILED', 'The history append size could not be confirmed.');
      fs.closeSync(descriptor); descriptor = null;
      if (!sameHistoryStamp(after, historyStamp(historyFile))) fail('R_LEDGER_CHAIN_APPEND_FAILED', 'The appended history file was replaced before confirmation.');
      return after;
    } catch (error) {
      lastError = error;
      if (descriptor !== null) { try { fs.closeSync(descriptor); } catch { cleanupFailed = true; } }
      // Once writeSync was entered, a rejection may still have appended bytes.
      // Retrying that same line would manufacture another operation.
      if (writeAttempted || cleanupFailed || !TRANSIENT_WRITE_CODES.has(error && error.code) || attempt + 1 >= WRITE_ATTEMPTS) break;
      waitSync(25 * (attempt + 1));
    }
  }
  const failure = new OwnerRequestStoreError('R_LEDGER_CHAIN_APPEND_FAILED',
    'The request was saved but its history append could not be confirmed. Check or recover its history before relying on it.');
  failure.cause = lastError;
  throw failure;
}

/* The chain's last word on every record: the newest event per id that is not
   an observation. */
function lastCoreByRequest(events) {
  const latest = new Map();
  for (const event of events) if (event.kind !== 'drift-observed') latest.set(event.requestId, event);
  return latest;
}

/* One transaction: lock, read, mutate, finalize, write, append every event.
   `mutate(document, at, chain)` returns { requests, events } where each event
   names the record it is about and the record's history row that must carry
   the hash.

   A RECORD THAT DIFFERS FROM ITS HISTORY IS RECORDED, NOT REFUSED. Before the
   mutation's own event is chained, every record it touches is compared, as it
   was on disk, with the chain's last word on it. When they differ the person
   is never locked out of their own ledger: a 'drift-observed' event goes on
   the chain first, carrying the hash the chain expected and the hash the file
   held, and then the mutation's event as usual. The write re-baselines the
   record honestly -- the observation is on the record for ever. */
function transact(options, now, mutate) {
  const { ledgerFile, historyFile } = filesFor(options);
  const clock = clockOf(now);
  const lock = acquireLock(ledgerFile);
  try {
    const document = readDocumentForWrite(ledgerFile);
    if (options.expectedRevision !== undefined && document.data.revision !== options.expectedRevision) {
      fail('LEDGER_PAGE_CHANGED', 'The ledger changed. Reload and confirm the action again.');
    }
    const chain = readTransactionHistory(historyFile, document, options);
    const expected = lastCoreByRequest(chain.events);
    const onDisk = new Map();
    // Any kind this store manages, not R alone: a T/A write deserves the
    // same "your hand change is observed before it's overwritten" protection
    // an R write already has. Widened here only -- everything else about the
    // drift-observed mechanics below (chainEvent, coreSha256, the event
    // shape) is unchanged.
    for (const entry of document.data.requests) if (plain(entry) && typeof entry.id === 'string' && idKind(entry.id)) onDisk.set(entry.id, normalizeRecord(entry));
    const at = clock().toISOString();
    const outcome = mutate(document, at, chain);
    const recordEvents = Array.isArray(outcome.events) ? outcome.events : [];
    if (recordEvents.length === 0) {
      return { ledgerFile, historyFile, revision: document.data.revision, at, outcome };
    }
    const nextData = finalize(document.data, outcome.requests, clock());
    let previous = chain.head;
    let seq = chain.sequence ?? chain.events.length;
    const lines = [];
    const chainEvent = (fields) => {
      seq += 1;
      const event = { schemaVersion: SCHEMA_VERSION, eventId: crypto.randomUUID(), seq, at, ...fields, ledgerRevision: nextData.revision, prevSha256: previous };
      event.eventSha256 = chainHash(previous, event);
      previous = event.eventSha256;
      lines.push(event);
      return event;
    };
    const observed = new Set();
    for (const pending of recordEvents) {
      const id = pending.record.id;
      const before = onDisk.get(id);
      const last = expected.get(id);
      if (before && last && !observed.has(id)) {
        const observedSha256 = coreSha256(before);
        if (observedSha256 !== last.coreSha256) {
          observed.add(id);
          chainEvent({
            actor: pending.actor,
            kind: 'drift-observed',
            requestId: id,
            scope: before.scope,
            scopeKey: before.scopeKey,
            statusAfter: before.status,
            coreSha256: observedSha256,
            expectedSha256: last.coreSha256,
            observedSha256
          });
        }
      }
      const event = chainEvent({
        actor: pending.actor,
        kind: pending.kind,
        requestId: id,
        scope: pending.record.scope,
        scopeKey: pending.record.scopeKey,
        statusAfter: pending.record.status,
        coreSha256: coreSha256(pending.record)
      });
      pending.historyRow.seq = event.seq;
      pending.historyRow.eventSha256 = event.eventSha256;
    }
    if (seq > MAX_EVENTS) fail('R_LEDGER_CHAIN_APPEND_FAILED', 'The history has reached its supported event count. Archive it before adding more.');
    if (!sameHistoryStamp(chain.stamp, historyStamp(historyFile))) fail('R_LEDGER_CHAIN_UNAVAILABLE', 'The task history changed before the write. Try again.');
    const events = operationalEvents([...chain.events, ...lines]);
    if (!operationalHistories.has(historyFile)) rememberOperationalHistory(historyFile, chain);
    const known = operationalHistories.get(historyFile);
    known.reusable = false;
    // A publication error may occur after the document reached disk. Retain
    // these reservations until readback or explicit recovery settles it.
    const reserved = new Set(lines.map(event => event.requestId).filter(id => !known.reservedIds.has(id)));
    for (const id of reserved) known.reservedIds.add(id);
    try {
      atomicWrite(ledgerFile, document.raw, nextData);
    } catch (error) {
      // Readback settles it when the document still holds exactly what this
      // write read under the lock: nothing was saved, so the numbers it would
      // have used are on no file. Keeping them reserved refused every later
      // filing in this process until a restart. Any other outcome keeps them.
      if (documentUnchanged(ledgerFile, document)) for (const id of reserved) known.reservedIds.delete(id);
      throw error;
    }
    let stamp = chain.stamp;
    for (const event of lines) stamp = appendChainLine(historyFile, event, stamp);
    const references = referenceEvents([...chain.references.values(), ...lines], currentHistoryReferences(nextData));
    rememberOperationalHistory(historyFile, { exists: true, events,
      sequence: seq, head: previous, broken: null, stamp, checked: false, references });
    return { ledgerFile, historyFile, revision: nextData.revision, at, outcome };
  } finally {
    lock.release();
  }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * File one standing rule in the person's own words; it lands 'open' at once.
 * Only the person files standing rules: an agent's filing is refused here as
 * well as at r_ledger.file.
 */
function fileRequest({ scope, key, words, filedBy, scopeLabel = null, source = null, why = null, now } = {}, options = {}) {
  assertScope(scope);
  const layerKey = assertKey(scope, key, { strict: true });
  const text = normalizeWords(words);
  const who = normalizeFiledBy(filedBy);
  const label = normalizeLabel(scopeLabel);
  const note = normalizeReason(why);
  if (who !== PERSON) fail('R_LEDGER_PERSON_REQUIRED', `Only the person adds standing rules. Ask them to add it ${require('./ledger-place').ledgerPlace()}.`);
  const result = transact(options, now, (document, at, chain) => {
    const records = document.data.requests.filter(isStoreRecordId).map(normalizeRecord);
    const id = `R${highestRootNumber(records, chain) + 1}`;
    const citation = typeof source === 'string' && source.trim().length >= 8
      ? source.trim().slice(0, 400)
      : 'typed by the person with /tefleet ledger';
    const provenance = normalizeProvenance({
      class: 'owner-stated',
      recordedBy: who,
      recordedAt: at,
      source: citation,
      ...(note ? { note } : {})
    });
    const historyRow = { seq: 0, kind: 'file', at, actor: who, eventSha256: '' };
    const record = {
      id,
      kind: 'R',
      parentId: null,
      scope,
      scopeKey: layerKey,
      scopeLabel: label,
      threadId: scope === 'thread' ? layerKey : null,
      verbatim: text,
      request: `(interpretation) ${text.slice(0, 4000)}`,
      status: 'open',
      filedBy: who,
      filedAt: at,
      gates: [],
      provenance,
      captureLog: [{ at, actor: who, mode: 'new', gatesAdded: 0, source: citation }],
      decisions: [],
      history: [historyRow],
      removedAt: null,
      removedBy: null
    };
    return { requests: [...document.data.requests, record], events: [{ kind: 'file', actor: who, record, historyRow }], record };
  });
  const record = result.outcome.record;
  return Object.freeze({
    id: record.id,
    parentId: record.parentId,
    scope,
    key: layerKey,
    path: result.ledgerFile,
    stamp: record.filedAt,
    filedBy: who,
    words: text,
    status: record.status,
    awaitingApproval: false,
    revision: result.revision
  });
}

function locateForRewrite(document, id) {
  const index = document.data.requests.findIndex(entry => plain(entry) && entry.id === id);
  if (index === -1) fail('R_LEDGER_ENTRY_UNKNOWN', `${id} is not in the ledger (deleted, or never filed).`);
  const entry = document.data.requests[index];
  const record = normalizeRecord(entry);
  return { index, entry, record };
}

/** The person deletes one request and every refinement under it; all stay on file as 'removed'. */
function removeRequest({ id, actor, now } = {}, options = {}) {
  assertPerson(actor);
  assertId(id);
  const result = transact(options, now, (document, at) => {
    const { record } = locateForRewrite(document, id);
    if (record.status === 'removed') fail('R_LEDGER_ENTRY_UNKNOWN', `${id} was already deleted.`);
    const requests = [...document.data.requests];
    const events = [];
    const removed = [];
    for (let index = 0; index < requests.length; index += 1) {
      const entry = requests[index];
      if (!plain(entry) || typeof entry.id !== 'string') continue;
      if (entry.id !== id && !entry.id.startsWith(`${id}.`)) continue;
      const current = normalizeRecord(entry);
      if (current.status === 'removed') continue;
      const historyRow = { seq: 0, kind: 'remove', at, actor: PERSON, statusBefore: current.status, eventSha256: '' };
      const next = {
        ...entry,
        scope: current.scope,
        scopeKey: current.scopeKey,
        parentId: current.parentId,
        filedBy: current.filedBy || PERSON,
        status: 'removed',
        removedAt: at,
        removedBy: PERSON,
        history: [...current.history, historyRow]
      };
      requests[index] = next;
      events.push({ kind: 'remove', actor: PERSON, record: next, historyRow });
      removed.push(next.id);
    }
    return { requests, events, record, removed };
  });
  const record = result.outcome.record;
  return Object.freeze({ id, status: 'removed', scope: record.scope, key: record.scopeKey, path: result.ledgerFile, removed: Object.freeze(result.outcome.removed), backup: `${result.ledgerFile}.bak`, revision: result.revision });
}

/** The person declines one standing or suggested rule, and every refinement
 * under it that still stands: it stops applying and stays on file as
 * 'declined'. The reason is optional. */
function declineRequest({ id, reason, actor, now } = {}, options = {}) {
  assertPerson(actor);
  assertId(id);
  const note = normalizeReason(reason);
  const result = transact(options, now, (document, at) => {
    const { record } = locateForRewrite(document, id);
    if (!DECLINABLE_RULE_STATUSES.has(record.status)) {
      fail('R_LEDGER_STATUS_INVALID', `${id} is ${record.status || 'without a status'}; only a standing or suggested rule can be declined.`);
    }
    const requests = [...document.data.requests];
    const events = [];
    const declined = [];
    for (let index = 0; index < requests.length; index += 1) {
      const entry = requests[index];
      if (!plain(entry) || typeof entry.id !== 'string') continue;
      if (entry.id !== id && !entry.id.startsWith(`${id}.`)) continue;
      const current = normalizeRecord(entry);
      if (!DECLINABLE_RULE_STATUSES.has(current.status)) continue;
      const historyRow = { seq: 0, kind: 'decline', at, actor: PERSON, statusBefore: current.status, eventSha256: '' };
      const next = {
        ...entry,
        scope: current.scope,
        scopeKey: current.scopeKey,
        parentId: current.parentId,
        filedBy: current.filedBy || PERSON,
        status: 'declined',
        decisions: [...current.decisions, { at, actor: PERSON, decision: 'decline', reason: note }],
        history: [...current.history, historyRow]
      };
      requests[index] = next;
      events.push({ kind: 'decline', actor: PERSON, record: next, historyRow });
      declined.push(next.id);
    }
    return { requests, events, record, declined };
  });
  const record = result.outcome.record;
  return Object.freeze({ id, status: 'declined', scope: record.scope, key: record.scopeKey, path: result.ledgerFile, declined: Object.freeze(result.outcome.declined), revision: result.revision });
}

/* The Fleet node of the subagent whose server is filing, or null for the person
   and the lead session. Tests pass `filingNode` in the options. */
function filingNode(options) {
  const opts = plain(options) ? options : {};
  const value = Object.prototype.hasOwnProperty.call(opts, 'filingNode') ? opts.filingNode : process.env.TOOLSENABLED_HOST_NODE;
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !SAFE_KEY.test(value)) fail('T_LEDGER_FILER_INVALID', 'This subagent\'s Fleet identity is not valid, so nothing was filed.');
  return value;
}

function assertFilingRoom(document, node) {
  const mine = document.data.requests.filter(entry => plain(entry) && entry.filedByNode === node
    && typeof entry.id === 'string' && (KIND_ID_RE.T.test(entry.id) || KIND_ID_RE.A.test(entry.id)));
  if (mine.length >= SUBAGENT_TOTAL_FILINGS) {
    fail('T_LEDGER_FILING_LIMIT', `This subagent has filed ${mine.length} tasks and questions, the most one subagent may file. Nothing was filed; put the rest in your report instead.`);
  }
  const open = mine.filter(entry => !CLOSED_FILING_STATUSES.has(entry.status)).length;
  if (open >= SUBAGENT_OPEN_FILINGS) {
    fail('T_LEDGER_FILING_LIMIT', `This subagent already has ${open} open tasks and questions on the ledger, the most one subagent may have open. Nothing was filed; complete its tasks or put the rest in your report instead.`);
  }
}

// ---------------------------------------------------------------------------
// T and A writes share the same lock, atomic write and hash-chained history
// as R records. Scope uses the same four tiers. Agents may file tasks and
// asks, complete tasks, and answer or decline asks. Removing an ask remains
// restricted to the person.
// ---------------------------------------------------------------------------

/* One filed record, T/A alike: a per-kind flat id (never a dotted
   refinement, unlike R), the same scope handling fileRequest gives R, the
   kind's own starting status and whatever kind-specific fields the caller
   seeds (recurrence for T, answer:null for A). */
function fileMinor(kind, startStatus, extra, { scope, key, words, filedBy, scopeLabel = null, why = null, now } = {}, options = {}) {
  assertScope(scope);
  const layerKey = assertKey(scope, key, { strict: true });
  const text = normalizeWords(words);
  const who = normalizeFiledBy(filedBy);
  const label = normalizeLabel(scopeLabel);
  const note = normalizeReason(why);
  const byPerson = who === PERSON;
  const node = byPerson ? null : filingNode(options);
  const result = transact(options, now, (document, at, chain) => {
    if (node) assertFilingRoom(document, node);
    const id = `${kind}${nextKindNumber(kind, document, chain)}`;
    const citation = byPerson ? 'typed by the person with /tefleet ledger' : `filed by agent ${who}`;
    const provenance = normalizeProvenance({
      class: byPerson ? 'owner-stated' : 'agent-inferred',
      recordedBy: who,
      recordedAt: at,
      source: citation,
      ...(note ? { note } : {})
    });
    const historyRow = { seq: 0, kind: 'file', at, actor: who, eventSha256: '' };
    const record = {
      id,
      kind,
      parentId: null,
      scope,
      scopeKey: layerKey,
      scopeLabel: label,
      threadId: scope === 'thread' ? layerKey : null,
      verbatim: text,
      request: `(interpretation) ${text.slice(0, 4000)}`,
      status: startStatus,
      filedBy: who,
      filedAt: at,
      gates: [],
      provenance,
      captureLog: [{ at, actor: who, mode: 'new', gatesAdded: 0, source: citation }],
      decisions: [],
      history: [historyRow],
      removedAt: null,
      removedBy: null,
      ...(node ? { filedByNode: node } : {}),
      ...(typeof extra === 'function' ? extra() : extra)
    };
    return { requests: [...document.data.requests, record], events: [{ kind: 'file', actor: who, record, historyRow }], record };
  });
  const record = result.outcome.record;
  return Object.freeze({
    id: record.id,
    kind,
    scope,
    key: layerKey,
    status: record.status,
    filedBy: who,
    words: text,
    path: result.ledgerFile,
    stamp: record.filedAt,
    revision: result.revision,
    ...taskDifficultyFields(record)
  });
}

/** File one task. Any actor may; recurrence null lands 'open' (one-shot), an object lands 'recurring'. */
function fileTask({ scope, key, words, filedBy, scopeLabel, why, now, difficulty, recurrence = null } = {}, options = {}) {
  const normalizedRecurrence = plain(recurrence) ? { interval: recurrence.interval, completions: [] } : null;
  return fileMinor('T', normalizedRecurrence ? 'recurring' : 'open',
    () => ({ recurrence: normalizedRecurrence, completedAt: null, completedBy: null,
      ...newTaskDifficultyFields({ difficulty, enabled: taskDifficultyEnabled(options) }) }),
    { scope, key, words, filedBy, scopeLabel, why, now }, options);
}

/** File one ask. Any actor may; it lands 'open', waiting for the person to answer or decline it. */
function fileAsk({ scope, key, words, filedBy, scopeLabel, why, now } = {}, options = {}) {
  return fileMinor('A', 'open', { answer: null }, { scope, key, words, filedBy, scopeLabel, why, now }, options);
}

/** Record a task checkpoint without completing or reviving terminal work. */
function progressTask(args = {}, options = {}) {
  const { id, status, reason, actor, now } = args;
  const hasWaitingFor = Object.prototype.hasOwnProperty.call(args, 'waitingFor');
  assertKindId('T', id);
  const who = normalizeFiledBy(actor);
  if (!['open', 'in-progress', 'blocked-external'].includes(status)) fail('R_LEDGER_STATUS_INVALID', 'Task progress must be open, in-progress or blocked-external.');
  const text = normalizeReason(reason);
  if (!text) fail('R_LEDGER_WORDS_INVALID', 'Task progress needs a concrete progress or blocker reason.');
  const result = transact(options, now, (document, at) => {
    const { index, entry, record } = locateForRewrite(document, id);
    if (!['open', 'in-progress', 'blocked-external'].includes(record.status)) fail('R_LEDGER_STATUS_INVALID', `${id} is ${record.status}; terminal and recurring tasks cannot be rewritten as one-shot work.`);
    const normalizedWaitingFor = hasWaitingFor
      ? assertTaskDependencies(id, args.waitingFor, document.data.requests.map(normalizeRecord))
      : null;
    const previous = record.decisions.at(-1);
    const existingWaitingFor = Object.prototype.hasOwnProperty.call(record, 'waitingFor')
      ? readWaitingFor(record.waitingFor)
      : null;
    const waitingForUnchanged = !hasWaitingFor
      || (existingWaitingFor !== null && JSON.stringify(existingWaitingFor) === JSON.stringify(normalizedWaitingFor));
    if (record.status === status && previous?.decision === 'progress' && previous.reason === text && waitingForUnchanged) {
      return { requests: document.data.requests, events: [], record: entry };
    }
    const historyRow = { seq: 0, kind: 'resolve', at, actor: who, statusBefore: record.status, eventSha256: '' };
    const next = { ...entry, status,
      decisions: [...record.decisions, { at, actor: who, decision: 'progress', status, reason: text }],
      history: [...record.history, historyRow] };
    if (hasWaitingFor) next.waitingFor = normalizedWaitingFor;
    const requests = [...document.data.requests]; requests[index] = next;
    return { requests, events: [{ kind: 'resolve', actor: who, record: next, historyRow }], record: next };
  });
  return Object.freeze({ id, status: result.outcome.record.status, revision: result.revision, recordedAt: result.at });
}

/** Complete one task: open -> done; recurring logs a completion and stays recurring. Any other status refuses. */
function completeTask({ id, actor, now } = {}, options = {}) {
  assertKindId('T', id);
  const who = normalizeFiledBy(actor);
  const result = transact(options, now, (document, at) => {
    const { index, entry, record } = locateForRewrite(document, id);
    if (!TASK_COMPLETABLE_STATUSES.has(record.status)) {
      fail('R_LEDGER_STATUS_INVALID', `${id} is ${record.status || 'without a status'}; only an open or recurring task can be completed.`);
    }
    const recurring = record.status === 'recurring';
    const priorCompletions = Array.isArray(record.recurrence && record.recurrence.completions) ? record.recurrence.completions : [];
    const nextRecurrence = recurring ? { ...record.recurrence, completions: [...priorCompletions, { at, actor: who }] } : record.recurrence;
    const historyRow = { seq: 0, kind: 'complete', at, actor: who, statusBefore: record.status, eventSha256: '' };
    const next = {
      ...entry,
      kind: record.kind || 'T',
      scope: record.scope,
      scopeKey: record.scopeKey,
      parentId: record.parentId,
      filedBy: record.filedBy || who,
      status: recurring ? 'recurring' : 'done',
      recurrence: nextRecurrence,
      completedAt: at,
      completedBy: who,
      history: [...record.history, historyRow]
    };
    const requests = [...document.data.requests];
    requests[index] = next;
    return { requests, events: [{ kind: 'complete', actor: who, record: next, historyRow }], record: next };
  });
  const record = result.outcome.record;
  return Object.freeze({ id, status: record.status, revision: result.revision, recordedAt: result.at });
}

/** Remove one task: a tombstone, like R's remove but for a flat id with no refinements. Any actor may. */
function removeTask({ id, actor, now } = {}, options = {}) {
  return removeMinor('T', { id, actor, now }, options);
}

/** The person answers one ask: open -> answered, carrying the person's own words. */
// Any actor may answer an ask; only the person may remove one
// (closable, not removable -- removal is the person's, as for R; agent
// removal applies only to T). `actor` is validated and
// normalized the same way filedBy already is, never assumed to be the person.
function answerAsk({ id, answer, actor, now } = {}, options = {}) {
  assertKindId('A', id);
  const who = normalizeFiledBy(actor);
  const text = normalizeWords(answer);
  const result = transact(options, now, (document, at) => {
    const { index, entry, record } = locateForRewrite(document, id);
    if (!ASK_ANSWERABLE_STATUSES.has(record.status)) {
      fail('R_LEDGER_STATUS_INVALID', `${id} is ${record.status || 'without a status'}; only an open ask can be answered.`);
    }
    const historyRow = { seq: 0, kind: 'answer', at, actor: who, statusBefore: record.status, eventSha256: '' };
    const next = {
      ...entry,
      kind: record.kind || 'A',
      scope: record.scope,
      scopeKey: record.scopeKey,
      parentId: record.parentId,
      filedBy: record.filedBy || PERSON,
      status: 'answered',
      answer: { words: text, at },
      history: [...record.history, historyRow]
    };
    const requests = [...document.data.requests];
    requests[index] = next;
    return { requests, events: [{ kind: 'answer', actor: who, record: next, historyRow }], record: next };
  });
  const record = result.outcome.record;
  return Object.freeze({ id, status: record.status, revision: result.revision, recordedAt: result.at });
}

/** The person declines to answer one ask: open -> declined. */
// Any actor may decline an ask; only the person may remove one.
function declineAsk({ id, reason, actor, now } = {}, options = {}) {
  assertKindId('A', id);
  const who = normalizeFiledBy(actor);
  const text = normalizeReason(reason);
  const result = transact(options, now, (document, at) => {
    const { index, entry, record } = locateForRewrite(document, id);
    if (!ASK_DECLINABLE_STATUSES.has(record.status)) {
      fail('R_LEDGER_STATUS_INVALID', `${id} is ${record.status || 'without a status'}; only an open ask can be declined.`);
    }
    const historyRow = { seq: 0, kind: 'decline', at, actor: who, statusBefore: record.status, eventSha256: '' };
    const next = {
      ...entry,
      kind: record.kind || 'A',
      scope: record.scope,
      scopeKey: record.scopeKey,
      parentId: record.parentId,
      filedBy: record.filedBy || PERSON,
      status: 'declined',
      decisions: [...record.decisions, { at, actor: who, decision: 'decline', reason: text }],
      history: [...record.history, historyRow]
    };
    const requests = [...document.data.requests];
    requests[index] = next;
    return { requests, events: [{ kind: 'decline', actor: who, record: next, historyRow }], record: next };
  });
  const record = result.outcome.record;
  return Object.freeze({ id, status: record.status, revision: result.revision, recordedAt: result.at });
}

/** The person removes one ask: a tombstone, the person's only, like R's remove. */
function removeAsk({ id, actor, now } = {}, options = {}) {
  assertPerson(actor);
  return removeMinor('A', { id, actor, now }, options);
}

/* Shared tombstone for T/A: any status but 'removed' -> 'removed'. The
   caller has already applied whatever actor gate its kind requires (T: none;
   A: assertPerson) before reaching here. */
function removeMinor(kind, { id, actor, now } = {}, options = {}) {
  assertKindId(kind, id);
  const who = normalizeFiledBy(actor);
  const result = transact(options, now, (document, at) => {
    const { index, entry, record } = locateForRewrite(document, id);
    if (record.status === 'removed') fail('R_LEDGER_ENTRY_UNKNOWN', `${id} was already deleted.`);
    const historyRow = { seq: 0, kind: 'remove', at, actor: who, statusBefore: record.status, eventSha256: '' };
    const next = {
      ...entry,
      kind: record.kind || kind,
      scope: record.scope,
      scopeKey: record.scopeKey,
      parentId: record.parentId,
      filedBy: record.filedBy || who,
      status: 'removed',
      removedAt: at,
      removedBy: who,
      history: [...record.history, historyRow]
    };
    const requests = [...document.data.requests];
    requests[index] = next;
    return { requests, events: [{ kind: 'remove', actor: who, record: next, historyRow }], record: next };
  });
  const record = result.outcome.record;
  return Object.freeze({ id, status: record.status, path: result.ledgerFile, backup: `${result.ledgerFile}.bak`, revision: result.revision });
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/* A row this store chained carries the hash in its history; a row the CLI
   wrote carries no history at all. */
function carriesChainHash(record) {
  return record.history.some(row => plain(row) && typeof row.eventSha256 === 'string' && row.eventSha256 !== '');
}

/**
 * Walk the chain and compare its last word on every record with the record as
 * it is now. Never creates a file.
 *   drift      records whose core differs from the chain's last word on them,
 *              and records that carry a chain hash in their history but have
 *              no chain event (a history line that never landed is drift, not
 *              a CLI row);
 *   missing    ids the chain names that are no longer in the ledger at all --
 *              spliced out by hand; a tombstone would still be there;
 *   unchained  rows with no history and no chain event: older tools wrote
 *              them; informational.
 * A 'drift-observed' event is informational and never the chain's last word.
 * @returns {{ok:boolean, events:number, head:string, drift:string[], missing:string[], unchained:string[], code?:string, message?:string}}
 */
function verifyHistory(options = {}) {
  const { ledgerFile, historyFile } = filesFor(options);
  const chain = readChain(historyFile);
  if (chain.broken) {
    return Object.freeze({
      ok: false, events: chain.events.length, head: chain.head, drift: Object.freeze([]), missing: Object.freeze([]), unchained: Object.freeze([]),
      code: 'R_LEDGER_CHAIN_BROKEN', message: `The history breaks at line ${chain.broken.line}; it was edited in place. Restore it from a backup before trusting it.`
    });
  }
  const latest = lastCoreByRequest(chain.events);
  const document = readDocument(ledgerFile);
  const drift = [];
  const unchained = [];
  const present = new Set();
  for (const entry of document.data.requests) {
    // Verification covers the whole shared journal. R-only filtering belongs
    // to the standing-rules reader, not the integrity check for T/A writes.
    if (!plain(entry) || !idKind(entry.id)) continue;
    const record = normalizeRecord(entry);
    present.add(record.id);
    const last = latest.get(record.id);
    if (!last) { (carriesChainHash(record) ? drift : unchained).push(record.id); continue; }
    if (last.coreSha256 !== coreSha256(record)) drift.push(record.id);
  }
  const missing = [...new Set(chain.events.map(event => event.requestId))]
    .filter(id => idKind(id) && !present.has(id));
  const ok = drift.length === 0 && missing.length === 0;
  const one = list => list.length === 1;
  const driftNote = drift.length
    ? `${one(drift) ? 'One request differs' : `${drift.length} requests differ`} from the last history line about ${one(drift) ? 'it' : 'them'}. Check ${drift.join(', ')} before relying on ${one(drift) ? 'it' : 'them'}.`
    : '';
  const missingNote = missing.length
    ? `${one(missing) ? 'One request the history names is' : `${missing.length} requests the history names are`} no longer in the ledger: ${missing.join(', ')}. ${one(missing) ? 'It' : 'They'} left without a tombstone; restore ${one(missing) ? 'it' : 'them'} from the .bak or the history before relying on the ledger.`
    : '';
  return Object.freeze({
    ok, events: chain.events.length, head: chain.head, drift: Object.freeze(drift), missing: Object.freeze(missing), unchained: Object.freeze(unchained),
    ...(ok ? {} : { code: drift.length ? 'R_LEDGER_CHAIN_DRIFT' : 'R_LEDGER_CHAIN_MISSING', message: [driftNote, missingNote].filter(Boolean).join(' ') })
  });
}

module.exports = Object.freeze({
  LEDGER_FILE,
  HISTORY_FILE,
  LOCK_SUFFIX,
  SCOPES,
  SCOPE_WORD,
  SAFE_KEY,
  MAX_WORDS_BYTES,
  MAX_FILED_BY_CHARS,
  MAX_LABEL_CHARS,
  STATUS_VOCABULARY,
  ACTIVE_STATUSES,
  GENESIS_SHA256,
  KIND_LABEL,
  TASK_STATUS_VOCABULARY,
  ASK_STATUS_VOCABULARY,
  OwnerRequestStoreError,
  canonical,
  chainHash,
  coreSha256,
  idKind,
  KIND_ID_RE,
  assertKindId,
  readAll,
  collectStack,
  nestEntries,
  fileRequest,
  removeRequest,
  declineRequest,
  SUBAGENT_OPEN_FILINGS,
  SUBAGENT_TOTAL_FILINGS,
  fileTask,
  completeTask,
  progressTask,
  removeTask,
  fileAsk,
  answerAsk,
  declineAsk,
  removeAsk,
  verifyHistory
});
