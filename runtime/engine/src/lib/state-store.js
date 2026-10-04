'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { ensureDir, rootPath } = require('./runtime');
const { plaintextCredentialOutsideGeneratedIds, plaintextCredentialPattern } = require('./secret-patterns');

// Node 22 still labels only node:sqlite as experimental. Suppress that one
// exact load-time warning without muting unrelated process warnings.
function loadDatabaseSync() {
  const original = process.emitWarning;
  process.emitWarning = function emitWarning(warning, ...args) {
    const message = warning instanceof Error ? warning.message : String(warning);
    const type = warning instanceof Error ? warning.name : args[0];
    if (type === 'ExperimentalWarning' && message === 'SQLite is an experimental feature and might change at any time') return;
    return Reflect.apply(original, this, [warning, ...args]);
  };
  try {
    return require('node:sqlite').DatabaseSync;
  } finally {
    process.emitWarning = original;
  }
}

const DatabaseSync = loadDatabaseSync();

/* Case-insensitive search text for any script: compatibility forms unified
   (NFKC), then upper- and lower-cased so that forms like "ß"/"SS" and final
   sigma meet. Used on both sides of memory search. */
function foldSearchText(text) {
  return String(text).normalize('NFKC').toUpperCase().toLowerCase();
}
const SCHEMA_VERSION = 25;
const APPLICATION_ID = 0x54454e42; // "TENB" (ToolsEnabled broker)
const DEFAULT_STATE_PATH = rootPath('state', 'toolsenabled.sqlite3');
// `DatabaseSync#isOpen` was added after the Node 22 experimental SQLite
// surface used by this host. StateStore owns the connection lifetime, clears
// `_db` after a successful close, and retains an unconfirmed close for cleanup.
// Treat an older connection object as open while it is retained. Keep the newer
// accessor when present, but do not let its absence recurse `_open()` through
// schema migration.
function databaseIsOpen(database) {
  if (!database) return false;
  try {
    if (typeof database.isOpen === 'boolean') return database.isOpen;
  } catch (error) {
    throw stateError('STATE_CONNECTION_STATUS_UNAVAILABLE', 'The durable state database connection status could not be read.', {}, error);
  }
  return true;
}

function databaseIsTransaction(database) {
  if (!database) return false;
  try {
    return typeof database.isTransaction === 'boolean' && database.isTransaction;
  } catch (error) {
    throw stateError('STATE_TRANSACTION_STATUS_UNAVAILABLE', 'The durable state database transaction status could not be read.', {}, error);
  }
}

const MAX_JSON_BYTES = 1024 * 1024;
const MAX_TASK_PAYLOAD_BYTES = 64 * 1024;
const MAX_TASK_CHECKPOINT_BYTES = 256 * 1024;
const MAX_TASK_CHECKPOINTS = 1000;
const MAX_ACTIVE_TASKS_PER_QUEUE = 10000;
const DEFAULT_TASK_LEASE_MS = 5 * 60 * 1000;
const MAX_MEMORY_VALUE_BYTES = 32 * 1024;
const MAX_MEMORY_NOTE_CHARS = 8 * 1024;
/* A STORED MEMORY ROW IS VERIFIED ONCE PER STORED VALUE, NOT ONCE PER READ.
 *
 * _memoryRow re-serializes the value canonically, re-hashes it and scans it for
 * plaintext credentials. Every one of those checks is a pure function of four
 * stored strings: value_json, value_hash, tags_json and note. The agent courier
 * reads every circle's whole 32 KiB inbox stream through this path every 1.2 s,
 * so with 45 circles the same unchanged bytes would be verified about 37 times a
 * minute each, on the main thread, and this re-verification would be most of
 * the time a round spends in getMemory.
 *
 * So a row whose four strings are exactly the ones already verified on this
 * store is not verified again. The comparison is exact string equality, so any
 * change to any of them -- a new write, a tampered value, a hash edited to
 * match, a secret smuggled in with a recomputed hash -- misses and is verified
 * in full, and a failure still throws. Only successes are remembered.
 *
 * BOUNDED: the oldest remembered rows are forgotten first, by count and by
 * stored characters, so the memo cannot grow with the memory table. */
const MEMORY_VERIFIED_MAX_ROWS = 1024;
const MEMORY_VERIFIED_MAX_CHARS = 8 * 1024 * 1024;
const MAX_MEMORY_TAGS = 32;
const MAX_MEMORY_TAG_CHARS = 64;
const MEMORY_NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const MEMORY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const MEMORY_TAG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TASK_STATES = new Set(['queued', 'leased', 'running', 'retry_wait', 'succeeded', 'failed', 'uncertain', 'cancelled']);
// Expired is a read-time lease projection, never a persisted lifecycle state.
const TASK_READ_STATES = new Set([...TASK_STATES, 'expired']);
const STARTUP_WAIT = new Int32Array(new SharedArrayBuffer(4));
// The four tables this build keeps, with their exact column order: the durable
// task queue and the memory store. They have these columns at schema 24 too.
const REQUIRED_SCHEMA = Object.freeze({
  tasks: ['id', 'queue_name', 'task_type', 'idempotency_key', 'input_hash', 'body_json', 'status', 'priority', 'available_at_ms',
    'max_attempts', 'attempt', 'retry_backoff_ms', 'max_retry_backoff_ms', 'expiry_policy', 'fence', 'lease_worker_label',
    'lease_token_hash', 'lease_expires_at_ms', 'checkpoint_revision', 'checkpoint_key', 'checkpoint_json', 'checkpoint_hash',
    'result_json', 'result_hash', 'error_code', 'error_message', 'cancel_requested_at_ms', 'cancel_reason', 'created_at_ms',
    'updated_at_ms', 'completed_at_ms'],
  task_attempts: ['task_id', 'fence', 'execution_attempt', 'worker_label', 'token_hash', 'status', 'lease_expires_at_ms',
    'claimed_at_ms', 'started_at_ms', 'updated_at_ms', 'ended_at_ms', 'outcome_hash', 'error_code', 'error_message'],
  task_checkpoints: ['task_id', 'revision', 'fence', 'execution_attempt', 'checkpoint_key', 'previous_hash', 'checkpoint_json',
    'checkpoint_hash', 'created_at_ms'],
  memory_entries: ['namespace', 'entry_key', 'value_json', 'value_hash', 'note', 'tags_json', 'revision', 'created_at_ms', 'updated_at_ms']
});

class StateStoreError extends Error {
  constructor(code, message, details = {}, options = {}) {
    super(message, options);
    this.name = 'StateStoreError';
    this.code = code;
    this.details = details;
  }
}

function stateError(code, message, details, cause) {
  return new StateStoreError(code, message, details || {}, cause ? { cause } : {});
}

function translateError(error) {
  if (error instanceof StateStoreError) return error;
  if (error && error.code === 'ERR_SQLITE_ERROR') {
    const base = Number(error.errcode) & 0xff;
    if (base === 5 || base === 6) {
      return stateError('STATE_BUSY', 'The durable state database is busy.', { sqliteCode: error.errcode }, error);
    }
    if (base === 19) {
      return stateError('STATE_CONSTRAINT', 'A durable state constraint was violated.', { sqliteCode: error.errcode }, error);
    }
    return stateError('STATE_SQLITE_ERROR', 'The durable state database rejected an operation.', { sqliteCode: error.errcode }, error);
  }
  return error;
}

function isBusyError(error) {
  if (error instanceof StateStoreError) return error.code === 'STATE_BUSY';
  return Boolean(error && error.code === 'ERR_SQLITE_ERROR' && ([5, 6].includes(Number(error.errcode) & 0xff)));
}

function waitSynchronously(milliseconds) {
  if (milliseconds > 0) Atomics.wait(STARTUP_WAIT, 0, 0, milliseconds);
}

function hasTransactionControl(sql) {
  if (typeof sql !== 'string') return false;
  let visible = '';
  for (let index = 0; index < sql.length;) {
    const char = sql[index];
    const next = sql[index + 1];
    if (char === '-' && next === '-') {
      index += 2;
      while (index < sql.length && sql[index] !== '\n') index += 1;
      visible += '\n';
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      while (index < sql.length && !(sql[index] === '*' && sql[index + 1] === '/')) index += 1;
      index = Math.min(sql.length, index + 2);
      visible += ' ';
      continue;
    }
    if (char === "'" || char === '"' || char === '`' || char === '[') {
      const closing = char === '[' ? ']' : char;
      index += 1;
      while (index < sql.length) {
        if (sql[index] === closing) {
          if (closing !== ']' && sql[index + 1] === closing) { index += 2; continue; }
          index += 1;
          break;
        }
        index += 1;
      }
      visible += ' ';
      continue;
    }
    visible += char;
    index += 1;
  }
  // SQLite trigger bodies are syntactically delimited by BEGIN/END but cannot
  // contain transaction control.  Remove complete CREATE TRIGGER bodies before
  // enforcing the callback ban so schema migrations can still use immutable
  // append-only guards without granting callers COMMIT/ROLLBACK access.
  const withoutTriggers = visible.replace(/CREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\b[\s\S]*?\bBEGIN\b[\s\S]*?\bEND\s*;/gi, ' ');
  return /(?:^|;)\s*(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(withoutTriggers);
}

  function transactionView(database, gate) {
  function assertOpen() {
    if (!gate.active) throw stateError('STATE_TRANSACTION_CLOSED', 'The transaction-scoped database handle is no longer active.');
  }
  function statementView(statement) {
    const view = {
      all(...args) { assertOpen(); return statement.all(...args); },
      columns() { assertOpen(); return statement.columns(); },
      get(...args) { assertOpen(); return statement.get(...args); },
      run(...args) { assertOpen(); return statement.run(...args); },
      setAllowBareNamedParameters(value) { assertOpen(); statement.setAllowBareNamedParameters(value); return view; },
      setAllowUnknownNamedParameters(value) { assertOpen(); statement.setAllowUnknownNamedParameters(value); return view; },
      setReadBigInts(value) { assertOpen(); statement.setReadBigInts(value); return view; },
      setReturnArrays(value) { assertOpen(); statement.setReturnArrays(value); return view; },
      iterate(...args) {
        assertOpen();
        const iterator = statement.iterate(...args);
        return {
          next() { assertOpen(); return iterator.next(); },
          return(value) { assertOpen(); return iterator.return ? iterator.return(value) : { done: true, value }; },
          [Symbol.iterator]() { return this; }
        };
      }
    };
    Object.defineProperties(view, {
      expandedSQL: { enumerable: true, get() { assertOpen(); return statement.expandedSQL; } },
      sourceSQL: { enumerable: true, get() { assertOpen(); return statement.sourceSQL; } }
    });
    return Object.freeze(view);
  }
  const view = {
    exec(sql) {
      assertOpen();
      if (hasTransactionControl(sql)) throw stateError('STATE_TRANSACTION_CONTROL', 'Transaction callbacks may not execute transaction-control SQL.');
      return database.exec(sql);
    },
    prepare(sql) {
      assertOpen();
      if (hasTransactionControl(sql)) throw stateError('STATE_TRANSACTION_CONTROL', 'Transaction callbacks may not prepare transaction-control SQL.');
      return statementView(database.prepare(sql));
    }
  };
  Object.defineProperties(view, {
    isOpen: { enumerable: true, get() { assertOpen(); return databaseIsOpen(database); } },
    isTransaction: { enumerable: true, get() { assertOpen(); return true; } }
  });
  return Object.freeze(view);
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw stateError('STATE_INVALID_ARGUMENT', `${label} must be a plain object.`, { field: label });
  }
  return value;
}

function assertString(value, label, { min = 1, max = 500, pattern } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max || (pattern && !pattern.test(value))) {
    throw stateError('STATE_INVALID_ARGUMENT', `${label} is invalid.`, { field: label });
  }
  return value;
}

function assertInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw stateError('STATE_INVALID_ARGUMENT', `${label} must be an integer from ${min} through ${max}.`, { field: label });
  }
  return value;
}

function assertMemoryTags(value, label = 'tags') {
  if (!Array.isArray(value) || value.length > MAX_MEMORY_TAGS) {
    throw stateError('MEMORY_TAGS_INVALID', `${label} must be an array of at most ${MAX_MEMORY_TAGS} tags.`, { field: label });
  }
  const tags = value.map((tag, index) => assertString(tag, `${label}[${index}]`, {
    max: MAX_MEMORY_TAG_CHARS, pattern: MEMORY_TAG_PATTERN
  }));
  if (new Set(tags).size !== tags.length) {
    throw stateError('MEMORY_TAGS_INVALID', `${label} must not contain duplicate tags.`, { field: label });
  }
  return tags;
}

function canonicalJson(value) {
  const seen = new Set();
  function encode(entry, inArray = false, depth = 0) {
    if (depth > 64) throw stateError('STATE_JSON_DEPTH', 'JSON nesting exceeds the durable-state depth limit.');
    if (entry === null) return 'null';
    if (entry === undefined) return inArray ? 'null' : undefined;
    if (typeof entry === 'string' || typeof entry === 'boolean') return JSON.stringify(entry);
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) throw stateError('STATE_JSON_INVALID', 'JSON values must contain only finite numbers.');
      return JSON.stringify(entry);
    }
    if (typeof entry !== 'object' || typeof entry.toJSON === 'function') {
      throw stateError('STATE_JSON_INVALID', 'Only JSON-compatible values may be persisted or hashed.');
    }
    if (seen.has(entry)) throw stateError('STATE_JSON_INVALID', 'Circular JSON values are not supported.');
    seen.add(entry);
    let output;
    if (Array.isArray(entry)) {
      output = `[${Array.from({ length: entry.length }, (_, index) => encode(entry[index], true, depth + 1)).join(',')}]`;
    } else {
      if (Object.getPrototypeOf(entry) !== Object.prototype) {
        seen.delete(entry);
        throw stateError('STATE_JSON_INVALID', 'Only plain JSON objects may be persisted or hashed.');
      }
      output = `{${Object.keys(entry).sort().flatMap(key => {
        const encoded = encode(entry[key], false, depth + 1);
        return encoded === undefined ? [] : [`${JSON.stringify(key)}:${encoded}`];
      }).join(',')}}`;
    }
    seen.delete(entry);
    return output;
  }
  const result = encode(value, false, 0);
  if (result === undefined) throw stateError('STATE_JSON_INVALID', 'The root JSON value may not be undefined.');
  return result;
}

function boundedTaskJson(value, label, maximumBytes, code) {
  const json = canonicalJson(value);
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > maximumBytes) {
    throw stateError(code, `${label} exceeds the durable task size limit.`, { field: label, maximumBytes });
  }
  return json;
}

function equalHash(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

const SENSITIVE_RESULT_KEY = /(?:^(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key|authorization|password|cookie|cvc|cvv|security[_-]?code|securityCode|number|card[_-]?number|private[_-]?key|privateKey|credential|credentials|session|session[_-]?id|stripe_(?:secret|restricted)_key)$|(?:^|[_-])(?:token|secret|credential|session)(?:$|[_-])|(?:token|secret|credential|session|privateKey)$)/i;
const PLAINTEXT_SECRET = plaintextCredentialPattern();

function assertNoPlaintextTaskSecrets(value, label = 'value', depth = 0, seen = new Set()) {
  if (depth > 32) throw stateError('STATE_JSON_DEPTH', `${label} nesting exceeds the safe persistence limit.`, { field: label });
  if (typeof value === 'string') {
    if (PLAINTEXT_SECRET.test(value)) throw stateError('TASK_SECRET_REJECTED', `${label} appears to contain a plaintext credential; keep credentials out of Fleet tasks.`, { field: label });
    return;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) value.forEach((entry, index) => assertNoPlaintextTaskSecrets(entry, `${label}[${index}]`, depth + 1, seen));
  else Object.entries(value).forEach(([key, entry]) => {
    if (SENSITIVE_RESULT_KEY.test(key)) throw stateError('TASK_SECRET_REJECTED', `${label} contains a sensitive field; keep credentials out of Fleet tasks.`, { field: `${label}.${key}` });
    assertNoPlaintextTaskSecrets(entry, `${label}.${key}`, depth + 1, seen);
  });
  seen.delete(value);
}

function assertNoPlaintextMemorySecrets(value, label = 'memory value', depth = 0, seen = new Set()) {
  if (depth > 32) throw stateError('MEMORY_VALUE_INVALID', `${label} nesting exceeds the safe memory limit.`, { field: label });
  if (typeof value === 'string') {
    // A circle id or inbox id the product minted is not a credential, even when
    // its hex begins `eaa`; any other match in the same text still refuses.
    if (PLAINTEXT_SECRET.test(value) && plaintextCredentialOutsideGeneratedIds(value)) {
      throw stateError('MEMORY_SECRET_REJECTED', `${label} appears to contain a plaintext credential; keep credentials out of Fleet memory.`, { field: label });
    }
    return;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoPlaintextMemorySecrets(entry, `${label}[${index}]`, depth + 1, seen));
  } else {
    Object.entries(value).forEach(([key, entry]) => {
      if (SENSITIVE_RESULT_KEY.test(key)) {
        throw stateError('MEMORY_SECRET_REJECTED', `${label} contains a sensitive field; keep credentials out of Fleet memory.`, { field: `${label}.${key}` });
      }
      assertNoPlaintextMemorySecrets(entry, `${label}.${key}`, depth + 1, seen);
    });
  }
  seen.delete(value);
}

function hashText(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashInput(value) {
  return hashText(canonicalJson(value));
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw stateError('STATE_CORRUPT_JSON', `Stored ${label} JSON is malformed.`, { field: label }, error);
  }
}

function iso(ms) {
  return new Date(ms).toISOString();
}

// SCHEMA 25 HOLDS ONLY WHAT THE PLUGIN USES: the durable task queue and the
// memory store. A fresh database is created directly at 25.
//
// Every table and index below is, statement for statement, the DDL that schema 2
// (tasks, task_attempts, task_checkpoints) and schema 5 (memory_entries) created,
// and nothing after them altered those four tables. So a schema 24 database
// already stores exactly this DDL for them, MIGRATION_V25 only has to drop what
// the plugin does not use, and an upgraded database and a fresh one have one
// fingerprint. Changing a constraint here means the upgrade must rebuild the
// table instead.
const SCHEMA_V25 = `
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 500),
    queue_name TEXT NOT NULL CHECK(length(queue_name) BETWEEN 1 AND 64),
    task_type TEXT NOT NULL CHECK(length(task_type) BETWEEN 1 AND 64),
    idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 200),
    input_hash TEXT NOT NULL CHECK(length(input_hash) = 64 AND input_hash NOT GLOB '*[^0-9a-f]*'),
    body_json TEXT NOT NULL CHECK(json_valid(body_json) AND length(CAST(body_json AS BLOB)) BETWEEN 1 AND ${MAX_TASK_PAYLOAD_BYTES}),
    status TEXT NOT NULL CHECK(status IN ('queued','leased','running','retry_wait','succeeded','failed','uncertain','cancelled')),
    priority INTEGER NOT NULL CHECK(priority BETWEEN -100 AND 100),
    available_at_ms INTEGER NOT NULL CHECK(available_at_ms >= 0),
    max_attempts INTEGER NOT NULL CHECK(max_attempts BETWEEN 1 AND 10),
    attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt BETWEEN 0 AND max_attempts),
    retry_backoff_ms INTEGER NOT NULL CHECK(retry_backoff_ms BETWEEN 0 AND 86400000),
    max_retry_backoff_ms INTEGER NOT NULL CHECK(max_retry_backoff_ms BETWEEN 0 AND 604800000),
    expiry_policy TEXT NOT NULL CHECK(expiry_policy IN ('uncertain','retry')),
    fence INTEGER NOT NULL DEFAULT 0 CHECK(fence >= 0),
    lease_worker_label TEXT CHECK(lease_worker_label IS NULL OR length(lease_worker_label) BETWEEN 1 AND 100),
    lease_token_hash TEXT CHECK(lease_token_hash IS NULL OR (length(lease_token_hash) = 64 AND lease_token_hash NOT GLOB '*[^0-9a-f]*')),
    lease_expires_at_ms INTEGER CHECK(lease_expires_at_ms IS NULL OR lease_expires_at_ms >= 0),
    checkpoint_revision INTEGER NOT NULL DEFAULT 0 CHECK(checkpoint_revision BETWEEN 0 AND ${MAX_TASK_CHECKPOINTS}),
    checkpoint_key TEXT CHECK(checkpoint_key IS NULL OR length(checkpoint_key) BETWEEN 8 AND 200),
    checkpoint_json TEXT CHECK(checkpoint_json IS NULL OR (json_valid(checkpoint_json) AND length(CAST(checkpoint_json AS BLOB)) BETWEEN 1 AND ${MAX_TASK_CHECKPOINT_BYTES})),
    checkpoint_hash TEXT CHECK(checkpoint_hash IS NULL OR (length(checkpoint_hash) = 64 AND checkpoint_hash NOT GLOB '*[^0-9a-f]*')),
    result_json TEXT CHECK(result_json IS NULL OR (json_valid(result_json) AND length(CAST(result_json AS BLOB)) BETWEEN 1 AND ${MAX_JSON_BYTES})),
    result_hash TEXT CHECK(result_hash IS NULL OR (length(result_hash) = 64 AND result_hash NOT GLOB '*[^0-9a-f]*')),
    error_code TEXT CHECK(error_code IS NULL OR length(error_code) BETWEEN 1 AND 200),
    error_message TEXT CHECK(error_message IS NULL OR length(error_message) <= 1000),
    cancel_requested_at_ms INTEGER CHECK(cancel_requested_at_ms IS NULL OR cancel_requested_at_ms >= 0),
    cancel_reason TEXT CHECK(cancel_reason IS NULL OR length(cancel_reason) <= 1000),
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms),
    completed_at_ms INTEGER CHECK(completed_at_ms IS NULL OR completed_at_ms >= created_at_ms),
    UNIQUE(queue_name, idempotency_key),
    CHECK(retry_backoff_ms <= max_retry_backoff_ms),
    CHECK((status IN ('leased','running') AND lease_worker_label IS NOT NULL AND lease_token_hash IS NOT NULL AND lease_expires_at_ms IS NOT NULL) OR
      (status NOT IN ('leased','running') AND lease_worker_label IS NULL AND lease_token_hash IS NULL AND lease_expires_at_ms IS NULL)),
    CHECK((checkpoint_revision = 0 AND checkpoint_key IS NULL AND checkpoint_json IS NULL AND checkpoint_hash IS NULL) OR
      (checkpoint_revision > 0 AND checkpoint_key IS NOT NULL AND checkpoint_json IS NOT NULL AND checkpoint_hash IS NOT NULL)),
    CHECK((result_json IS NULL AND result_hash IS NULL) OR (result_json IS NOT NULL AND result_hash IS NOT NULL)),
    CHECK(cancel_reason IS NULL OR cancel_requested_at_ms IS NOT NULL),
    CHECK((status IN ('succeeded','failed','uncertain','cancelled') AND completed_at_ms IS NOT NULL) OR
      (status NOT IN ('succeeded','failed','uncertain','cancelled') AND completed_at_ms IS NULL)),
    CHECK((status = 'succeeded' AND result_json IS NOT NULL) OR (status <> 'succeeded' AND result_json IS NULL)),
    CHECK((status IN ('retry_wait','failed','uncertain') AND error_code IS NOT NULL AND error_message IS NOT NULL) OR
      (status NOT IN ('retry_wait','failed','uncertain') AND error_code IS NULL AND error_message IS NULL))
  ) STRICT;
  CREATE INDEX tasks_claim_idx ON tasks(queue_name, status, available_at_ms, priority DESC, created_at_ms, id);
  CREATE INDEX tasks_expiry_idx ON tasks(status, lease_expires_at_ms);
  CREATE INDEX tasks_updated_idx ON tasks(updated_at_ms DESC, id DESC);

  CREATE TABLE task_attempts (
    task_id TEXT NOT NULL,
    fence INTEGER NOT NULL CHECK(fence >= 1),
    execution_attempt INTEGER NOT NULL CHECK(execution_attempt BETWEEN 1 AND 10),
    worker_label TEXT NOT NULL CHECK(length(worker_label) BETWEEN 1 AND 100),
    token_hash TEXT NOT NULL CHECK(length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
    status TEXT NOT NULL CHECK(status IN ('leased','running','succeeded','retryable_failed','failed','cancelled','lease_expired','uncertain')),
    lease_expires_at_ms INTEGER NOT NULL CHECK(lease_expires_at_ms >= 0),
    claimed_at_ms INTEGER NOT NULL CHECK(claimed_at_ms >= 0),
    started_at_ms INTEGER CHECK(started_at_ms IS NULL OR started_at_ms >= claimed_at_ms),
    updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= claimed_at_ms),
    ended_at_ms INTEGER CHECK(ended_at_ms IS NULL OR ended_at_ms >= claimed_at_ms),
    outcome_hash TEXT CHECK(outcome_hash IS NULL OR (length(outcome_hash) = 64 AND outcome_hash NOT GLOB '*[^0-9a-f]*')),
    error_code TEXT CHECK(error_code IS NULL OR length(error_code) BETWEEN 1 AND 200),
    error_message TEXT CHECK(error_message IS NULL OR length(error_message) <= 1000),
    PRIMARY KEY(task_id, fence),
    FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    CHECK((status IN ('leased','running') AND ended_at_ms IS NULL AND outcome_hash IS NULL) OR
      (status NOT IN ('leased','running') AND ended_at_ms IS NOT NULL AND outcome_hash IS NOT NULL)),
    CHECK(status NOT IN ('running','succeeded','uncertain') OR started_at_ms IS NOT NULL)
  ) STRICT;
  CREATE INDEX task_attempts_status_idx ON task_attempts(status, updated_at_ms);

  CREATE TABLE task_checkpoints (
    task_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND ${MAX_TASK_CHECKPOINTS}),
    fence INTEGER NOT NULL CHECK(fence >= 1),
    execution_attempt INTEGER NOT NULL CHECK(execution_attempt >= 1),
    checkpoint_key TEXT NOT NULL CHECK(length(checkpoint_key) BETWEEN 8 AND 200),
    previous_hash TEXT CHECK(previous_hash IS NULL OR (length(previous_hash) = 64 AND previous_hash NOT GLOB '*[^0-9a-f]*')),
    checkpoint_json TEXT NOT NULL CHECK(json_valid(checkpoint_json) AND length(CAST(checkpoint_json AS BLOB)) BETWEEN 1 AND ${MAX_TASK_CHECKPOINT_BYTES}),
    checkpoint_hash TEXT NOT NULL CHECK(length(checkpoint_hash) = 64 AND checkpoint_hash NOT GLOB '*[^0-9a-f]*'),
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
    PRIMARY KEY(task_id, revision),
    UNIQUE(task_id, fence, checkpoint_key),
    FOREIGN KEY(task_id, fence) REFERENCES task_attempts(task_id, fence) ON DELETE CASCADE
  ) STRICT;
  CREATE INDEX task_checkpoints_attempt_idx ON task_checkpoints(task_id, execution_attempt, revision);

  CREATE TABLE memory_entries (
    namespace TEXT NOT NULL CHECK(length(namespace) BETWEEN 1 AND 100),
    entry_key TEXT NOT NULL CHECK(length(entry_key) BETWEEN 1 AND 200),
    value_json TEXT NOT NULL CHECK(json_valid(value_json) AND length(CAST(value_json AS BLOB)) BETWEEN 1 AND ${MAX_MEMORY_VALUE_BYTES}),
    value_hash TEXT NOT NULL CHECK(length(value_hash) = 64 AND value_hash NOT GLOB '*[^0-9a-f]*'),
    note TEXT CHECK(note IS NULL OR length(note) <= ${MAX_MEMORY_NOTE_CHARS}),
    tags_json TEXT NOT NULL CHECK(json_valid(tags_json) AND length(CAST(tags_json AS BLOB)) BETWEEN 2 AND 4096),
    revision INTEGER NOT NULL CHECK(revision >= 1),
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms),
    PRIMARY KEY(namespace, entry_key)
  ) STRICT;
  CREATE INDEX memory_entries_search_idx ON memory_entries(namespace, updated_at_ms DESC, entry_key ASC);

  PRAGMA application_id = ${APPLICATION_ID};
  PRAGMA user_version = 25;
`;

// SCHEMA 24 -> 25 DROPS EVERY TABLE THE PLUGIN DOES NOT USE.
//
// Every ToolsEnabled Fleet release before this one wrote schema 24, the
// schema it shared with the desktop edition. These 37 tables served that
// edition: its scheduler, connectors, research projects, model and search
// metering, capability profiles, approvals and coordinator workflows. Nothing in
// the plugin writes them, so on a plugin database they are empty apart from the
// scheduler installation singleton that schema 3 inserted for itself. Rows in
// the four kept tables are not touched.
//
// ORDER IS CHILD-FIRST. DROP TABLE performs an implicit row delete that still
// honours foreign keys, so no table goes before one that references it. A
// table's indexes and immutability triggers are dropped with it, before that
// implicit delete, so no trigger fires.
const MIGRATION_V25 = `
  DROP TABLE scoped_approval_events;
  DROP TABLE scoped_approval_grants;
  DROP TABLE scoped_approval_actions;
  DROP TABLE scoped_approval_provenance;
  DROP TABLE policy_dispatch_consumptions;
  DROP TABLE policy_dispatch_authorizations;
  DROP TABLE capability_profile_revocations;
  DROP TABLE capability_profile_requests;
  DROP TABLE capability_profile_bindings;
  DROP TABLE capability_profile_versions;
  DROP TABLE coordinator_workflow_acceptances;
  DROP TABLE coordinator_workflow_outbox;
  DROP TABLE coordinator_workflow_events;
  DROP TABLE coordinator_broker_verifications;
  DROP TABLE coordinator_workflow_missions;
  DROP TABLE coordinator_phase_states;
  DROP TABLE coordinator_missions;
  DROP TABLE research_results;
  DROP TABLE research_runs;
  DROP TABLE research_findings;
  DROP TABLE research_project_sessions;
  DROP TABLE research_experiments;
  DROP TABLE research_projects;
  DROP TABLE scheduler_attempts;
  DROP TABLE scheduler_outbox;
  DROP TABLE scheduler_runs;
  DROP TABLE scheduler_registrations;
  DROP TABLE scheduler_jobs;
  DROP TABLE scheduler_legacy_import;
  DROP TABLE scheduler_installation;
  DROP TABLE approval_grants;
  DROP TABLE remote_asks;
  DROP TABLE model_usage_daily;
  DROP TABLE tavily_usage_monthly;
  DROP TABLE spend_entries;
  DROP TABLE operations;
  DROP TABLE legacy_imports;
  PRAGMA user_version = 25;
`;

// THE SCHEMA 24 FINGERPRINT IS RECORDED, NOT RECOMPUTED. ToolsEnabled Fleet
// 1.6.10 computed it as expectedSchemaFingerprint(24): its whole migration ladder
// (SCHEMA_V1 through MIGRATION_V24, removed from this file) applied to an empty
// in-memory database, then databaseSchemaFingerprint below.
// tests/fixtures/plugin-state-v24-builder.js reads the same value out of that
// release's own module into the fixture's provenance file, and the upgrade test
// holds this constant to it. Only a database at 24 that matches it exactly is
// upgraded.
const SCHEMA_V24_FINGERPRINT = '8b64707db4b16d3c2bc81a0a4c3a60499a1ced56561b4e0e63316800606c540e';

const expectedFingerprints = new Map();
function databaseSchemaFingerprint(db) {
  const rows = db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_schema
    WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type, name`).all();
  // ALTER TABLE ... RENAME rewrites the stored DDL with the new name in double
  // quotes -- `CREATE TABLE "coordinator_missions"`, and every FOREIGN KEY
  // that referenced it likewise -- while DDL that was created under that name
  // carries no quotes. The two describe one schema, so quoting around a bare
  // identifier is not part of the fingerprint. Schema 24 databases carry such
  // renamed DDL, and SCHEMA_V24_FINGERPRINT was computed with exactly this
  // normalization, so it cannot change without refusing every one of them.
  const normalized = rows.map(row => [
    row.type,
    row.name,
    row.tbl_name,
    String(row.sql).replace(/"([A-Za-z_][A-Za-z0-9_]*)"/g, '$1').replace(/\s+/g, ' ').trim()
  ]);
  return hashText(JSON.stringify(normalized));
}

function expectedSchemaFingerprint(version = SCHEMA_VERSION) {
  if (version === 24) return SCHEMA_V24_FINGERPRINT;
  if (version !== SCHEMA_VERSION) throw stateError('STATE_SCHEMA_UNSUPPORTED', `State schema ${version} is not supported.`, { version, supported: SCHEMA_VERSION });
  if (expectedFingerprints.has(version)) return expectedFingerprints.get(version);
  const db = new DatabaseSync(':memory:', { allowExtension: false, enableForeignKeyConstraints: true });
  try {
    db.exec(SCHEMA_V25);
    const fingerprint = databaseSchemaFingerprint(db);
    expectedFingerprints.set(version, fingerprint);
    return fingerprint;
  } finally {
    db.close();
  }
}

class StateStore {
  constructor(options = {}) {
    assertPlainObject(options, 'options');
    const environmentPath = typeof process.env.TOOLSENABLED_STATE_PATH === 'string' && process.env.TOOLSENABLED_STATE_PATH.trim()
      ? process.env.TOOLSENABLED_STATE_PATH.trim()
      : undefined;
    const selectedFile = options.file === undefined ? (environmentPath || DEFAULT_STATE_PATH) : options.file;
    this.file = assertString(selectedFile, 'file', { max: 4096 });
    this.file = this.file === ':memory:' ? this.file : path.resolve(this.file);
    this.clock = options.clock || (() => Date.now());
    if (typeof this.clock !== 'function') throw stateError('STATE_INVALID_ARGUMENT', 'clock must be a function.', { field: 'clock' });
    this.idFactory = options.idFactory || (prefix => `${prefix}-${crypto.randomUUID()}`);
    if (typeof this.idFactory !== 'function') throw stateError('STATE_INVALID_ARGUMENT', 'idFactory must be a function.', { field: 'idFactory' });
    this.busyTimeoutMs = assertInteger(options.busyTimeoutMs === undefined ? 5000 : options.busyTimeoutMs, 'busyTimeoutMs', { min: 1, max: 60000 });
    this.ownerId = options.ownerId === undefined ? this._newId('worker') : assertString(options.ownerId, 'ownerId', { max: 200 });
    this._db = null;
    this._transactionActive = false;
    this._verifiedMemoryRows = new Map();
    this._verifiedMemoryChars = 0;
  }

  _newId(prefix) {
    const value = this.idFactory(prefix);
    return assertString(value, `${prefix} id`, { max: 500 });
  }

  _now() {
    const raw = this.clock();
    const value = raw instanceof Date ? raw.getTime() : Number(raw);
    return assertInteger(value, 'clock result', { min: 0 });
  }

  _open() {
    if (databaseIsOpen(this._db)) return this._db;
    if (this.file !== ':memory:') ensureDir(path.dirname(this.file));
    // A group of fresh broker processes can all race through journal-mode and
    // schema initialization before SQLite's connection busy handler is fully
    // applicable. Retry the complete open sequence with bounded jitter, always
    // closing a partial handle before starting over.
    const deadline = Date.now() + (this.busyTimeoutMs * 2);
    let attempt = 0;
    while (true) {
      let db;
      try {
        db = new DatabaseSync(this.file, {
          timeout: this.busyTimeoutMs,
          allowExtension: false,
          enableForeignKeyConstraints: true,
          enableDoubleQuotedStringLiterals: false,
          readBigInts: false,
          returnArrays: false,
          allowBareNamedParameters: true,
          allowUnknownNamedParameters: false
        });
        this._db = db;
        const mode = db.prepare('PRAGMA journal_mode=WAL').get().journal_mode;
        if (this.file !== ':memory:' && mode !== 'wal') {
          throw stateError('STATE_WAL_UNAVAILABLE', 'The durable state database could not enable WAL mode.', { journalMode: mode });
        }
        db.exec(`PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=${this.busyTimeoutMs};`);
        // SQLite's NOCASE folds ASCII only, so memory search found "café" but
        // not "CAFÉ". te_fold() folds any script the way foldSearchText does.
        this._unicodeFold = typeof db.function === 'function';
        if (this._unicodeFold) db.function('te_fold', { deterministic: true }, value => (value === null || value === undefined ? value : foldSearchText(String(value))));
        this._migrate();
        return db;
      } catch (error) {
        if (databaseIsOpen(db)) {
          try { db.close(); } catch { /* retain the original failure */ }
        }
        this._db = null;
        attempt += 1;
        const remaining = deadline - Date.now();
        if (isBusyError(error) && attempt < 10 && remaining > 0) {
          const backoff = Math.min(250, 10 * (2 ** Math.min(attempt - 1, 5))) + (process.pid % 17);
          waitSynchronously(Math.min(backoff, remaining));
          continue;
        }
        throw translateError(error);
      }
    }
  }

  _migrate() {
    this.transaction(db => {
      let version = db.prepare('PRAGMA user_version').get().user_version;
      let applicationId = db.prepare('PRAGMA application_id').get().application_id;
      if (applicationId !== 0 && applicationId !== APPLICATION_ID) {
        throw stateError('STATE_DATABASE_IDENTITY', 'The configured state path belongs to a different SQLite application.', { applicationId, expected: APPLICATION_ID });
      }
      if (version > SCHEMA_VERSION) {
        throw stateError('STATE_SCHEMA_TOO_NEW', `State schema ${version} is newer than supported schema ${SCHEMA_VERSION}.`, { version, supported: SCHEMA_VERSION });
      }
      if (version === 0) {
        db.exec(SCHEMA_V25);
        version = SCHEMA_VERSION;
        applicationId = APPLICATION_ID;
      } else {
        // Never apply an upgrade over a database whose existing version does
        // not exactly match the schema that version promised. Schema 24, which
        // every earlier plugin release wrote, is the only one that upgrades;
        // anything older is refused as unsupported.
        this._validateSchema(db, version);
      }
      if (version === 24) {
        db.exec(MIGRATION_V25);
        version = 25;
      }
      const migrated = db.prepare('PRAGMA user_version').get().user_version;
      if (migrated !== SCHEMA_VERSION) {
        throw stateError('STATE_SCHEMA_UNSUPPORTED', `State schema ${migrated} cannot be upgraded by this build.`, { version: migrated, supported: SCHEMA_VERSION });
      }
      this._validateSchema(db, migrated);
      const foreignKeyFailures = db.prepare('PRAGMA foreign_key_check').all();
      if (foreignKeyFailures.length) {
        throw stateError('STATE_SCHEMA_INVALID', 'The durable state database contains invalid foreign-key references.', { violations: foreignKeyFailures.length });
      }
      if (applicationId === 0) db.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
      const migratedApplicationId = db.prepare('PRAGMA application_id').get().application_id;
      if (migratedApplicationId !== APPLICATION_ID) {
        throw stateError('STATE_DATABASE_IDENTITY', 'The state database application identity could not be established.', { applicationId: migratedApplicationId, expected: APPLICATION_ID });
      }
    });
  }

  _validateSchema(db, version = SCHEMA_VERSION) {
    if (version !== 24 && version !== SCHEMA_VERSION) throw stateError('STATE_SCHEMA_UNSUPPORTED', `State schema ${version} is not supported.`, { version, supported: SCHEMA_VERSION });
    const tables = new Map(db.prepare('PRAGMA table_list').all().map(row => [row.name, row]));
    for (const [name, expectedColumns] of Object.entries(REQUIRED_SCHEMA)) {
      const table = tables.get(name);
      if (!table || table.type !== 'table' || table.strict !== 1) {
        throw stateError('STATE_SCHEMA_INVALID', `Required STRICT state table '${name}' is missing or invalid.`, { table: name });
      }
      const actualColumns = db.prepare(`PRAGMA table_info(${name})`).all().map(row => row.name);
      if (actualColumns.length !== expectedColumns.length || actualColumns.some((column, index) => column !== expectedColumns[index])) {
        throw stateError('STATE_SCHEMA_INVALID', `State table '${name}' has an unexpected column layout.`, { table: name, expectedColumns, actualColumns });
      }
    }
    const expected = expectedSchemaFingerprint(version);
    const actual = databaseSchemaFingerprint(db);
    if (actual !== expected) {
      throw stateError('STATE_SCHEMA_INVALID', 'The durable state DDL fingerprint does not match this schema version.', { expectedFingerprint: expected, actualFingerprint: actual });
    }
  }

  close() {
    this._verifiedMemoryRows?.clear();
    this._verifiedMemoryChars = 0;
    if (!databaseIsOpen(this._db)) {
      this._db = null;
      return false;
    }
    const db = this._db;
    let failure;
    try {
      if (this._transactionActive || databaseIsTransaction(db)) db.exec('ROLLBACK');
    } catch (error) {
      failure = error;
    }
    try {
      db.close();
      this._db = null;
    } catch (error) {
      if (!failure) failure = error;
      // A failed native close can leave the file locked on Windows. Retain the
      // actual connection so a later cleanup can still release it.
    }
    if (failure) throw translateError(failure);
    return true;
  }

  transaction(callback) {
    if (typeof callback !== 'function') throw stateError('STATE_INVALID_ARGUMENT', 'transaction callback must be a function.', { field: 'callback' });
    if (callback.constructor && callback.constructor.name === 'AsyncFunction') {
      throw stateError('STATE_TRANSACTION_ASYNC', 'Durable-state transactions must be synchronous and may not use an async callback.');
    }
    const db = databaseIsOpen(this._db) ? this._db : this._open();
    if (this._transactionActive || databaseIsTransaction(db)) {
      throw stateError('STATE_TRANSACTION_NESTED', 'Nested durable-state transactions are not supported.');
    }
    const gate = { active: true };
    let transactionStarted = false;
    this._transactionActive = true;
    try {
      db.exec('BEGIN IMMEDIATE');
      transactionStarted = true;
      const result = callback(transactionView(db, gate));
      if (result && typeof result.then === 'function') {
        if (typeof result.catch === 'function') result.catch(() => {});
        throw stateError('STATE_TRANSACTION_ASYNC', 'Durable-state transactions must be synchronous and may not return a Promise.');
      }
      gate.active = false;
      db.exec('COMMIT');
      return result;
    } catch (error) {
      gate.active = false;
      if (transactionStarted || databaseIsTransaction(db)) {
        try { db.exec('ROLLBACK'); } catch { /* preserve the initiating error */ }
      }
      throw translateError(error);
    } finally {
      this._transactionActive = false;
    }
  }

  _read(callback) {
    try {
      return callback(this._open());
    } catch (error) {
      throw translateError(error);
    }
  }

  _prepareMemoryEntry(input) {
    const source = assertPlainObject(input, 'memory');
    const namespace = assertString(source.namespace, 'namespace', { max: 100, pattern: MEMORY_NAMESPACE_PATTERN });
    const key = assertString(source.key, 'key', { max: 200, pattern: MEMORY_KEY_PATTERN });
    if (!Object.prototype.hasOwnProperty.call(source, 'value')) {
      throw stateError('MEMORY_VALUE_REQUIRED', 'value is required for a memory entry.', { field: 'value' });
    }
    assertNoPlaintextMemorySecrets(source.value, 'value');
    const valueJson = canonicalJson(source.value);
    if (Buffer.byteLength(valueJson, 'utf8') > MAX_MEMORY_VALUE_BYTES) {
      throw stateError('MEMORY_VALUE_TOO_LARGE', `value exceeds the ${MAX_MEMORY_VALUE_BYTES}-byte memory limit.`, {
        field: 'value', maximumBytes: MAX_MEMORY_VALUE_BYTES
      });
    }
    const note = source.note === undefined ? null : assertString(source.note, 'note', { min: 0, max: MAX_MEMORY_NOTE_CHARS });
    if (note !== null) assertNoPlaintextMemorySecrets(note, 'note');
    const tags = assertMemoryTags(source.tags === undefined ? [] : source.tags);
    const tagsJson = canonicalJson(tags);
    const expectedRevision = source.expectedRevision === undefined
      ? undefined : assertInteger(source.expectedRevision, 'expectedRevision', { min: 0 });
    return {
      namespace, key, valueJson, valueHash: hashText(valueJson), note, tagsJson,
      expectedRevision
    };
  }

  _memoryRowVerifiedBefore(row) {
    const known = this._verifiedMemoryRows?.get(`${row.namespace}\u0000${row.entry_key}`);
    return Boolean(known)
      && known.valueJson === row.value_json
      && known.valueHash === row.value_hash
      && known.tagsJson === row.tags_json
      && known.note === row.note;
  }

  _rememberVerifiedMemoryRow(row) {
    if (!this._verifiedMemoryRows) {
      this._verifiedMemoryRows = new Map();
      this._verifiedMemoryChars = 0;
    }
    const key = `${row.namespace}\u0000${row.entry_key}`;
    const prior = this._verifiedMemoryRows.get(key);
    if (prior) {
      this._verifiedMemoryRows.delete(key);
      this._verifiedMemoryChars -= prior.chars;
    }
    const chars = key.length + row.value_json.length + row.value_hash.length + row.tags_json.length
      + (row.note === null ? 0 : row.note.length);
    this._verifiedMemoryRows.set(key, {
      valueJson: row.value_json, valueHash: row.value_hash, tagsJson: row.tags_json, note: row.note, chars
    });
    this._verifiedMemoryChars += chars;
    while (this._verifiedMemoryRows.size > MEMORY_VERIFIED_MAX_ROWS || this._verifiedMemoryChars > MEMORY_VERIFIED_MAX_CHARS) {
      const [oldestKey, oldest] = this._verifiedMemoryRows.entries().next().value;
      this._verifiedMemoryRows.delete(oldestKey);
      this._verifiedMemoryChars -= oldest.chars;
    }
  }

  _memoryRow(row) {
    if (!row) return null;
    const value = parseJson(row.value_json, 'memory value');
    let tags;
    if (this._memoryRowVerifiedBefore(row)) {
      tags = parseJson(row.tags_json, 'memory tags');
    } else {
      const valueJson = canonicalJson(value);
      if (valueJson !== row.value_json || hashText(valueJson) !== row.value_hash) {
        throw stateError('MEMORY_ENTRY_INVALID', 'A stored memory value failed its canonical integrity check.', {
          namespace: row.namespace, key: row.entry_key
        });
      }
      assertNoPlaintextMemorySecrets(value, 'stored memory value');
      tags = parseJson(row.tags_json, 'memory tags');
      const tagsJson = canonicalJson(assertMemoryTags(tags, 'stored memory tags'));
      if (tagsJson !== row.tags_json) {
        throw stateError('MEMORY_ENTRY_INVALID', 'A stored memory tag set is not canonical.', {
          namespace: row.namespace, key: row.entry_key
        });
      }
      if (row.note !== null) {
        assertString(row.note, 'stored memory note', { min: 0, max: MAX_MEMORY_NOTE_CHARS });
        assertNoPlaintextMemorySecrets(row.note, 'stored memory note');
      }
      this._rememberVerifiedMemoryRow(row);
    }
    return {
      namespace: row.namespace,
      key: row.entry_key,
      value,
      valueHash: row.value_hash,
      note: row.note,
      tags,
      revision: row.revision,
      createdAt: iso(row.created_at_ms),
      createdAtMs: row.created_at_ms,
      updatedAt: iso(row.updated_at_ms),
      updatedAtMs: row.updated_at_ms
    };
  }

  /* EVERY ROW IN ONE NAMESPACE, REMOVED, AND THE COUNT RETURNED.
   *
   * Recovery only. An installation that ran a release where the public memory
   * tools could reach Fleet's reserved namespaces may hold a row an agent wrote,
   * and a forged row is indistinguishable from a legitimate one after the fact --
   * so the only honest repair is to reset the namespace, which is a decision for
   * the person, taken with Fleet stopped. recover-state.js is the only caller.
   *
   * This is NOT reachable from the memory tools: those expose get, set and search
   * and refuse these namespaces outright. Adding it here does not widen them. */
  clearMemoryNamespace({ namespace } = {}) {
    const checked = assertString(namespace, 'namespace', { max: 100, pattern: MEMORY_NAMESPACE_PATTERN });
    return this.transaction(db => db.prepare('DELETE FROM memory_entries WHERE namespace = ?').run(checked).changes);
  }

  setMemory(input) {
    const entry = this._prepareMemoryEntry(input);
    return this.transaction(db => {
      const now = this._now();
      const prior = db.prepare('SELECT * FROM memory_entries WHERE namespace = ? AND entry_key = ?').get(entry.namespace, entry.key);
      if (entry.expectedRevision !== undefined) {
        const actualRevision = prior ? prior.revision : 0;
        if (actualRevision !== entry.expectedRevision) {
          throw stateError('MEMORY_REVISION_CONFLICT', 'The memory entry changed before this write could be applied.', {
            namespace: entry.namespace, key: entry.key, expectedRevision: entry.expectedRevision, actualRevision
          });
        }
      }
      if (prior && prior.value_json === entry.valueJson && prior.note === entry.note && prior.tags_json === entry.tagsJson) {
        return { entry: this._memoryRow(prior), created: false, replayed: true };
      }
      if (prior) {
        db.prepare(`UPDATE memory_entries SET value_json = ?, value_hash = ?, note = ?, tags_json = ?, revision = revision + 1,
          updated_at_ms = ? WHERE namespace = ? AND entry_key = ?`).run(
          entry.valueJson, entry.valueHash, entry.note, entry.tagsJson, now, entry.namespace, entry.key
        );
      } else {
        db.prepare(`INSERT INTO memory_entries(namespace, entry_key, value_json, value_hash, note, tags_json, revision, created_at_ms, updated_at_ms)
          VALUES(?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(
          entry.namespace, entry.key, entry.valueJson, entry.valueHash, entry.note, entry.tagsJson, now, now
        );
      }
      const saved = db.prepare('SELECT * FROM memory_entries WHERE namespace = ? AND entry_key = ?').get(entry.namespace, entry.key);
      return { entry: this._memoryRow(saved), created: !prior, replayed: false };
    });
  }

  getMemory(input) {
    const source = assertPlainObject(input, 'memory selector');
    const namespace = assertString(source.namespace, 'namespace', { max: 100, pattern: MEMORY_NAMESPACE_PATTERN });
    const key = assertString(source.key, 'key', { max: 200, pattern: MEMORY_KEY_PATTERN });
    return this._read(db => this._memoryRow(db.prepare('SELECT * FROM memory_entries WHERE namespace = ? AND entry_key = ?').get(namespace, key)));
  }

  /* THE KEYS IN ONE NAMESPACE, AND NOTHING ELSE.
   *
   * system.doctor has to say whether Fleet's own reserved namespaces hold rows
   * and whether the modules that own them can still parse those rows. It must do
   * that without putting retained message bodies in front of anyone, so this
   * returns keys only and never a value. Read-only, and not reachable from the
   * public memory tools, which refuse these namespaces outright. */
  memoryKeys({ namespace } = {}) {
    const checked = assertString(namespace, 'namespace', { max: 100, pattern: MEMORY_NAMESPACE_PATTERN });
    return this._read(db => db.prepare('SELECT entry_key FROM memory_entries WHERE namespace = ? ORDER BY entry_key ASC')
      .all(checked).map(row => row.entry_key));
  }

  searchMemory(input = {}) {
    const source = assertPlainObject(input, 'memory search');
    const query = assertString(source.query, 'query', { max: 256 });
    if (!query.trim()) throw stateError('STATE_INVALID_ARGUMENT', 'query must contain at least one non-whitespace character.', { field: 'query' });
    const namespace = source.namespace === undefined
      ? undefined : assertString(source.namespace, 'namespace', { max: 100, pattern: MEMORY_NAMESPACE_PATTERN });
    const limit = assertInteger(source.limit === undefined ? 10 : source.limit, 'limit', { min: 1, max: 20 });
    /* Namespaces this caller may not see. providers/memory.js passes its own
     * internal set so the exclusion lands in SQL, BEFORE the row limit:
     * filtering the returned page instead would hand back a short or empty page
     * whenever excluded rows sorted first, which reads as "no matches". */
    const exclude = source.excludeNamespaces === undefined ? [] : (() => {
      if (!Array.isArray(source.excludeNamespaces)) {
        throw stateError('STATE_INVALID_ARGUMENT', 'excludeNamespaces must be an array of namespaces.', { field: 'excludeNamespaces' });
      }
      if (source.excludeNamespaces.length > 32) {
        throw stateError('STATE_INVALID_ARGUMENT', 'excludeNamespaces exceeds 32 entries.', { field: 'excludeNamespaces' });
      }
      return source.excludeNamespaces.map((value, index) =>
        assertString(value, `excludeNamespaces[${index}]`, { max: 100, pattern: MEMORY_NAMESPACE_PATTERN }));
    })();
    return this._read(db => {
      // Fold the query before escaping it: folding can turn a compatibility
      // character (a full-width percent sign, say) into a wildcard, and the
      // query stays a literal substring either way.
      const folded = this._unicodeFold ? foldSearchText(query) : query;
      const pattern = `%${folded.replace(/[\\%_]/g, character => `\\${character}`)}%`;
      const column = name => (this._unicodeFold ? `te_fold(${name}) LIKE ? ESCAPE '\\'` : `${name} LIKE ? ESCAPE '\\' COLLATE NOCASE`);
      const where = `(${column('namespace')} OR ${column('entry_key')} OR ${column('note')} OR ${column('tags_json')} OR ${column('value_json')})`;
      const skip = exclude.length ? ` AND namespace NOT IN (${exclude.map(() => '?').join(', ')})` : '';
      const rows = namespace === undefined
        ? db.prepare(`SELECT * FROM memory_entries WHERE ${where}${skip}
          ORDER BY updated_at_ms DESC, namespace ASC, entry_key ASC LIMIT ?`).all(pattern, pattern, pattern, pattern, pattern, ...exclude, limit)
        : db.prepare(`SELECT * FROM memory_entries WHERE namespace = ? AND ${where}${skip}
          ORDER BY updated_at_ms DESC, entry_key ASC LIMIT ?`).all(namespace, pattern, pattern, pattern, pattern, pattern, ...exclude, limit);
      return rows.map(row => this._memoryRow(row));
    });
  }

  _approvalGrantInput(input) {
    const source = assertPlainObject(input, 'approval grant');
    const action = assertString(source.action, 'action', { max: 200, pattern: /^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/ });
    const inputHash = assertString(source.inputHash, 'inputHash', { min: 64, max: 64, pattern: /^[a-f0-9]{64}$/ });
    const tokenHash = assertString(source.tokenHash, 'tokenHash', { min: 64, max: 64, pattern: /^[a-f0-9]{64}$/ });
    return { action, inputHash, tokenHash };
  }

  // NOTHING IN THIS BUILD CAN CREATE AN APPROVAL GRANT, so no token can name one
  // and every well-formed request ends in the refusal an unknown token always
  // received. The request is still checked field by field, and the same write
  // transaction still runs first, so a malformed request, an unusable database
  // or a bad clock fails exactly as it did before.
  consumeApprovalGrant(input) {
    this._approvalGrantInput(input);
    this.transaction(() => { this._now(); });
    throw stateError('APPROVAL_NOT_FOUND', 'The approval token is unknown.');
  }

  // Only a controller-created scoped approval can authorize this dispatch, and
  // this build has no controller that creates one. The request is still checked
  // field by field inside the same write transaction, and the answer is the
  // refusal a dispatch without a scoped approval always received.
  consumeScopedApprovalDispatch(input) {
    const source = assertPlainObject(input, 'scoped approval dispatch consumption');
    if (Object.keys(source).some(key => !['authorizationId', 'toolName', 'argsHash', 'tokenHash'].includes(key))) throw stateError('STATE_INVALID_ARGUMENT', 'Scoped approval dispatch consumption has unsupported fields.', { field: 'scoped approval dispatch consumption' });
    const authorizationId = assertString(source.authorizationId, 'authorizationId', { min: 8, max: 200, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/ });
    assertString(source.toolName, 'toolName', { min: 3, max: 200, pattern: /^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/ });
    assertString(source.argsHash, 'argsHash', { min: 64, max: 64, pattern: /^[a-f0-9]{64}$/ });
    assertString(source.tokenHash, 'tokenHash', { min: 64, max: 64, pattern: /^[a-f0-9]{64}$/ });
    return this.transaction(() => {
      this._now();
      throw stateError('APPROVAL_REQUIRED', 'The policy action has no controller-created scoped approval.', { authorizationId });
    });
  }

  _leaseMs(value, label = 'leaseMs') {
    return assertInteger(value, label, { min: 1000, max: 24 * 60 * 60 * 1000 });
  }

  // A policy dispatch authorization is prepared only by a controller this build
  // does not have, so none can exist. The request is still checked field by
  // field inside the same write transaction, and the answer is the refusal a
  // missing authorization always received.
  consumePolicyDispatchAuthorization(input) {
    const source = assertPlainObject(input, 'Policy dispatch consumption');
    if (Object.keys(source).some(key => !['authorizationId', 'toolName', 'argsHash', 'approvalId', 'approvalInputHash'].includes(key))) throw stateError('STATE_INVALID_ARGUMENT', 'Policy dispatch consumption contains unsupported fields.', { field: 'Policy dispatch consumption' });
    const authorizationId = assertString(source.authorizationId, 'authorizationId', { min: 8, max: 200, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/ });
    assertString(source.toolName, 'toolName', { min: 3, max: 200, pattern: /^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/ });
    assertString(source.argsHash, 'argsHash', { min: 64, max: 64, pattern: /^[a-f0-9]{64}$/ });
    const approvalId = source.approvalId === undefined || source.approvalId === null ? null : assertString(source.approvalId, 'approvalId', { min: 8, max: 200 });
    const approvalInputHash = source.approvalInputHash === undefined || source.approvalInputHash === null ? null : assertString(source.approvalInputHash, 'approvalInputHash', { min: 64, max: 64, pattern: /^[a-f0-9]{64}$/ });
    if ((approvalId === null) !== (approvalInputHash === null)) throw stateError('STATE_INVALID_ARGUMENT', 'Policy approval evidence must include both ID and input hash.', { field: 'approval evidence' });
    return this.transaction(() => {
      this._now();
      throw stateError('POLICY_AUTHORIZATION_MISSING', 'The policy dispatch authorization was not found.', { authorizationId });
    });
  }

  _taskIdentifier(value, label) {
    return assertString(value, label, { max: 64, pattern: /^[a-z0-9][a-z0-9._-]{0,63}$/ });
  }

  _taskKey(value, label) {
    return assertString(value, label, { min: 8, max: 200, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/ });
  }

  _taskPayload(value) {
    const body = assertPlainObject(value, 'payload');
    const unknown = Object.keys(body).filter(key => !['title', 'objective', 'context'].includes(key));
    if (unknown.length) throw stateError('STATE_INVALID_ARGUMENT', 'payload contains unsupported fields.', { field: 'payload', fields: unknown });
    const normalized = {
      title: assertString(body.title, 'payload.title', { max: 200 }),
      objective: assertString(body.objective, 'payload.objective', { max: 16000 })
    };
    if (body.context !== undefined) normalized.context = assertString(body.context, 'payload.context', { min: 0, max: 32000 });
    assertNoPlaintextTaskSecrets(normalized, 'payload');
    return normalized;
  }

  // `now` is only supplied by read-only entry points (getTask/listTasks). When
  // present, a 'leased'/'running' row whose lease already expired is reported
  // as 'expired'/'uncertain' instead of echoing the stale stored status --
  // reaping is otherwise lazy (only runs opportunistically inside claimTask),
  // so an unclaimed queue can leave a task reported "running" long after its
  // lease lapsed. This is read-time derivation only: it never mutates the row,
  // and internal transition code always reads the raw column directly, so it
  // cannot affect claim/start/heartbeat/checkpoint fencing.
  _taskRow(row, { includePayload = true, includeCheckpoint = true, includeResult = true, includeError = true, now = null } = {}) {
    if (!row) return null;
    const leaseExpired = now !== null && (row.status === 'leased' || row.status === 'running')
      && row.lease_expires_at_ms !== null && row.lease_expires_at_ms <= now;
    const reportedStatus = leaseExpired ? (row.status === 'leased' ? 'expired' : 'uncertain') : row.status;
    const task = {
      id: row.id,
      queue: row.queue_name,
      type: row.task_type,
      status: reportedStatus,
      storedStatus: row.status,
      leaseExpired,
      priority: row.priority,
      availableAt: iso(row.available_at_ms),
      availableAtMs: row.available_at_ms,
      maxAttempts: row.max_attempts,
      attempt: row.attempt,
      retryBackoffMs: row.retry_backoff_ms,
      maxRetryBackoffMs: row.max_retry_backoff_ms,
      expiryPolicy: row.expiry_policy,
      fence: row.fence,
      workerLabel: row.lease_worker_label,
      leaseExpiresAtMs: row.lease_expires_at_ms,
      checkpointRevision: row.checkpoint_revision,
      latestCheckpoint: row.checkpoint_revision === 0 ? null : {
        revision: row.checkpoint_revision,
        checkpointKey: row.checkpoint_key,
        hash: row.checkpoint_hash
      },
      cancellation: row.cancel_requested_at_ms === null ? null : {
        requestedAt: iso(row.cancel_requested_at_ms),
        requestedAtMs: row.cancel_requested_at_ms,
        reason: row.cancel_reason || ''
      },
      createdAt: iso(row.created_at_ms),
      createdAtMs: row.created_at_ms,
      updatedAt: iso(row.updated_at_ms),
      updatedAtMs: row.updated_at_ms,
      completedAt: row.completed_at_ms === null ? null : iso(row.completed_at_ms),
      completedAtMs: row.completed_at_ms
    };
    task.cancelRequested = row.cancel_requested_at_ms !== null;
    task.cancellationRequested = task.cancelRequested;
    if (row.status === 'retry_wait') {
      task.retryAt = iso(row.available_at_ms);
      task.retryAtMs = row.available_at_ms;
    }
    if (includePayload) {
      task.payload = parseJson(row.body_json, 'task payload');
    }
    if (includeCheckpoint && task.latestCheckpoint) task.latestCheckpoint.checkpoint = parseJson(row.checkpoint_json, 'task checkpoint');
    if (includeResult) task.result = row.result_json === null ? null : parseJson(row.result_json, 'task result');
    if (includeError) {
      task.error = row.error_code === null ? null : { code: row.error_code, message: row.error_message || '' };
      task.errorCode = row.error_code;
      task.errorMessage = row.error_message;
    }
    return task;
  }

  _validateTaskHandle(handle) {
    const value = assertPlainObject(handle, 'handle');
    return {
      taskId: assertString(value.taskId, 'handle.taskId', { max: 500 }),
      attempt: assertInteger(value.attempt, 'handle.attempt', { min: 1, max: 10 }),
      workerLabel: assertString(value.workerLabel, 'handle.workerLabel', { max: 100, pattern: /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,99}$/ }),
      claimToken: assertString(value.claimToken, 'handle.claimToken', { min: 43, max: 43, pattern: /^[A-Za-z0-9_-]{43}$/ }),
      fence: assertInteger(value.fence, 'handle.fence', { min: 1 })
    };
  }

  _taskAttempt(db, handle) {
    const row = db.prepare('SELECT * FROM task_attempts WHERE task_id = ? AND fence = ?').get(handle.taskId, handle.fence);
    const tokenHash = hashText(handle.claimToken);
    if (!row || row.execution_attempt !== handle.attempt || row.worker_label !== handle.workerLabel || !equalHash(row.token_hash, tokenHash)) {
      throw stateError('TASK_FENCE_LOST', 'The task claim handle is stale or invalid.', { taskId: handle.taskId, fence: handle.fence });
    }
    return row;
  }

  _currentTaskClaim(db, handle, now, allowedStates, { allowExpired = false } = {}) {
    const attempt = this._taskAttempt(db, handle);
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(handle.taskId);
    const tokenHash = hashText(handle.claimToken);
    if (!task || task.fence !== handle.fence || task.lease_worker_label !== handle.workerLabel || !equalHash(task.lease_token_hash, tokenHash)) {
      throw stateError('TASK_FENCE_LOST', 'The task claim no longer owns the current fence.', { taskId: handle.taskId, fence: handle.fence });
    }
    if (!allowedStates.includes(task.status) || !allowedStates.includes(attempt.status)) {
      throw stateError('TASK_INVALID_TRANSITION', `Task state '${task.status}' does not allow this transition.`, { taskId: task.id, status: task.status, allowedStates });
    }
    if (!allowExpired && task.lease_expires_at_ms <= now) {
      throw stateError('TASK_LEASE_EXPIRED', 'The task claim lease expired before the transition.', { taskId: task.id, fence: task.fence, expiresAtMs: task.lease_expires_at_ms });
    }
    return { task, attempt };
  }

  _taskBackoff(row, now) {
    const exponent = Math.max(0, Math.min(30, row.attempt - 1));
    const delay = Math.min(row.max_retry_backoff_ms, row.retry_backoff_ms * (2 ** exponent));
    return now + Math.trunc(delay);
  }

  _reapExpiredTasks(db, now, { queue, limit = 1000 } = {}) {
    const rows = queue === undefined
      ? db.prepare("SELECT * FROM tasks WHERE status IN ('leased','running') AND lease_expires_at_ms <= ? ORDER BY lease_expires_at_ms, id LIMIT ?").all(now, limit)
      : db.prepare("SELECT * FROM tasks WHERE queue_name = ? AND status IN ('leased','running') AND lease_expires_at_ms <= ? ORDER BY lease_expires_at_ms, id LIMIT ?").all(queue, now, limit);
    let reclaimed = 0;
    let uncertain = 0;
    let cancelled = 0;
    for (const row of rows) {
      const wasLeased = row.status === 'leased';
      const cancellationRequested = row.cancel_requested_at_ms !== null;
      let status;
      let attemptStatus;
      let errorCode;
      let errorMessage;
      let availableAtMs = row.available_at_ms;
      let completedAtMs = null;
      if (wasLeased && cancellationRequested) {
        status = 'cancelled'; attemptStatus = 'cancelled'; cancelled += 1; completedAtMs = now;
      } else if (wasLeased) {
        status = 'retry_wait'; attemptStatus = 'lease_expired'; reclaimed += 1;
        errorCode = 'TASK_LEASE_EXPIRED'; errorMessage = 'The claim expired before execution started.'; availableAtMs = now;
      } else if (!cancellationRequested && row.expiry_policy === 'retry' && row.attempt < row.max_attempts) {
        status = 'retry_wait'; attemptStatus = 'retryable_failed'; reclaimed += 1;
        errorCode = 'TASK_LEASE_EXPIRED'; errorMessage = 'The running task lease expired and is eligible for safe retry.';
        availableAtMs = this._taskBackoff(row, now);
      } else {
        status = 'uncertain'; attemptStatus = 'uncertain'; uncertain += 1; completedAtMs = now;
        errorCode = 'TASK_LEASE_EXPIRED'; errorMessage = 'The running task outcome is uncertain after its lease expired.';
      }
      const outcomeHash = hashInput({ status: attemptStatus, errorCode: errorCode || null, atMs: now });
      db.prepare(`UPDATE task_attempts SET status = ?, updated_at_ms = ?, ended_at_ms = ?, outcome_hash = ?, error_code = ?, error_message = ?
        WHERE task_id = ? AND fence = ? AND status = ?`).run(
        attemptStatus, now, now, outcomeHash, errorCode || null, errorMessage || null, row.id, row.fence, row.status
      );
      db.prepare(`UPDATE tasks SET status = ?, available_at_ms = ?, lease_worker_label = NULL, lease_token_hash = NULL,
        lease_expires_at_ms = NULL, error_code = ?, error_message = ?, completed_at_ms = ?, updated_at_ms = ?
        WHERE id = ? AND fence = ? AND status = ?`).run(
        status, availableAtMs, errorCode || null, errorMessage || null, completedAtMs, now, row.id, row.fence, row.status
      );
    }
    return { examined: rows.length, reclaimed, uncertain, cancelled };
  }

  _prepareTaskSubmission(input) {
    const source = assertPlainObject(input, 'task');
    const queue = this._taskIdentifier(source.queue, 'queue');
    const type = this._taskIdentifier(source.type, 'type');
    const idempotencyKey = this._taskKey(source.idempotencyKey, 'idempotencyKey');
    const payload = this._taskPayload(source.payload);
    const bodyJson = boundedTaskJson(payload, 'payload', MAX_TASK_PAYLOAD_BYTES, 'TASK_PAYLOAD_TOO_LARGE');
    const priority = assertInteger(source.priority === undefined ? 0 : source.priority, 'priority', { min: -100, max: 100 });
    const maxAttempts = assertInteger(source.maxAttempts === undefined ? 3 : source.maxAttempts, 'maxAttempts', { min: 1, max: 10 });
    const retryBackoffMs = assertInteger(source.retryBackoffMs === undefined ? 1000 : source.retryBackoffMs, 'retryBackoffMs', { min: 0, max: 86400000 });
    const maxRetryBackoffMs = assertInteger(source.maxRetryBackoffMs === undefined ? 3600000 : source.maxRetryBackoffMs, 'maxRetryBackoffMs', { min: 0, max: 604800000 });
    if (retryBackoffMs > maxRetryBackoffMs) throw stateError('STATE_INVALID_ARGUMENT', 'retryBackoffMs may not exceed maxRetryBackoffMs.', { field: 'retryBackoffMs' });
    const expiryPolicy = source.expiryPolicy === undefined ? 'uncertain' : source.expiryPolicy;
    if (!['uncertain', 'retry'].includes(expiryPolicy)) throw stateError('STATE_INVALID_ARGUMENT', "expiryPolicy must be 'uncertain' or 'retry'.", { field: 'expiryPolicy' });
    const requestedAvailableAtMs = source.availableAtMs === undefined ? null : assertInteger(source.availableAtMs, 'availableAtMs');
    const inputHash = hashInput({ queue, type, payload, priority, availableAtMs: requestedAvailableAtMs, maxAttempts, retryBackoffMs, maxRetryBackoffMs, expiryPolicy });
    return { queue, type, idempotencyKey, payload, bodyJson, priority, maxAttempts, retryBackoffMs, maxRetryBackoffMs, expiryPolicy, requestedAvailableAtMs, inputHash };
  }

  _submitPreparedTask(db, definition, now, { maxActiveTasks = MAX_ACTIVE_TASKS_PER_QUEUE } = {}) {
    const existing = db.prepare('SELECT * FROM tasks WHERE queue_name = ? AND idempotency_key = ?').get(definition.queue, definition.idempotencyKey);
    if (existing) {
      if (existing.input_hash !== definition.inputHash) {
        throw stateError('TASK_IDEMPOTENCY_CONFLICT', 'The task idempotency key was already used with a different definition.', {
          queue: definition.queue, idempotencyKey: definition.idempotencyKey
        });
      }
      return { disposition: 'replay', task: this._taskRow(existing) };
    }
    const active = db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE queue_name = ? AND status IN ('queued','leased','running','retry_wait','uncertain')").get(definition.queue).count;
    if (active >= maxActiveTasks) throw stateError('TASK_QUEUE_FULL', 'The task queue reached its active-task limit.', { queue: definition.queue, maximum: maxActiveTasks });
    const id = this._newId('task');
    const availableAtMs = definition.requestedAvailableAtMs === null ? now : definition.requestedAvailableAtMs;
    db.prepare(`INSERT INTO tasks(id, queue_name, task_type, idempotency_key, input_hash, body_json, status, priority, available_at_ms,
      max_attempts, attempt, retry_backoff_ms, max_retry_backoff_ms, expiry_policy, fence, created_at_ms, updated_at_ms)
      VALUES(?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, 0, ?, ?, ?, 0, ?, ?)`).run(
      id, definition.queue, definition.type, definition.idempotencyKey, definition.inputHash, definition.bodyJson,
      definition.priority, availableAtMs, definition.maxAttempts, definition.retryBackoffMs,
      definition.maxRetryBackoffMs, definition.expiryPolicy, now, now
    );
    return { disposition: 'submitted', task: this._taskRow(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)) };
  }

  submitTask(input) {
    const definition = this._prepareTaskSubmission(input);
    return this.transaction(db => this._submitPreparedTask(db, definition, this._now()));
  }

  claimTask(input) {
    const source = assertPlainObject(input, 'claim');
    const queue = this._taskIdentifier(source.queue, 'queue');
    const workerLabel = assertString(source.workerLabel === undefined ? this.ownerId : source.workerLabel,
      'workerLabel', { max: 100, pattern: /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,99}$/ });
    const leaseMs = this._leaseMs(source.leaseMs === undefined ? DEFAULT_TASK_LEASE_MS : source.leaseMs, 'leaseMs');
    let types;
    if (source.types !== undefined) {
      if (!Array.isArray(source.types) || source.types.length < 1 || source.types.length > 100) {
        throw stateError('STATE_INVALID_ARGUMENT', 'types must contain from 1 through 100 task type identifiers.', { field: 'types' });
      }
      types = [...new Set(source.types.map((type, index) => this._taskIdentifier(type, `types[${index}]`)))];
    }
    return this.transaction(db => {
      const now = this._now();
      this._reapExpiredTasks(db, now, { queue });
      const typeClause = types ? ` AND task_type IN (${types.map(() => '?').join(',')})` : '';
      const values = [queue, now, ...(types || [])];
      const row = db.prepare(`SELECT * FROM tasks WHERE queue_name = ? AND status IN ('queued','retry_wait')
        AND available_at_ms <= ? AND cancel_requested_at_ms IS NULL AND attempt < max_attempts${typeClause}
        ORDER BY priority DESC, available_at_ms, created_at_ms, id LIMIT 1`).get(...values);
      if (!row) return null;
      const fence = row.fence + 1;
      const attempt = row.attempt + 1;
      const claimToken = crypto.randomBytes(32).toString('base64url');
      const tokenHash = hashText(claimToken);
      const leaseExpiresAtMs = now + leaseMs;
      const changed = db.prepare(`UPDATE tasks SET status = 'leased', fence = ?, lease_worker_label = ?, lease_token_hash = ?,
        lease_expires_at_ms = ?, error_code = NULL, error_message = NULL, completed_at_ms = NULL, updated_at_ms = ?
        WHERE id = ? AND fence = ? AND status IN ('queued','retry_wait')`).run(
        fence, workerLabel, tokenHash, leaseExpiresAtMs, now, row.id, row.fence
      );
      if (changed.changes !== 1) throw stateError('TASK_FENCE_LOST', 'The task changed before its claim could be recorded.', { taskId: row.id, fence });
      db.prepare(`INSERT INTO task_attempts(task_id, fence, execution_attempt, worker_label, token_hash, status,
        lease_expires_at_ms, claimed_at_ms, updated_at_ms) VALUES(?, ?, ?, ?, ?, 'leased', ?, ?, ?)`).run(
        row.id, fence, attempt, workerLabel, tokenHash, leaseExpiresAtMs, now, now
      );
      const handle = { taskId: row.id, attempt, workerLabel, claimToken, fence };
      return {
        task: this._taskRow(db.prepare('SELECT * FROM tasks WHERE id = ?').get(row.id)),
        handle,
        leaseExpiresAtMs
      };
    });
  }

  startTask(handle, options = {}) {
    const claim = this._validateTaskHandle(handle);
    const source = assertPlainObject(options, 'options');
    const leaseMs = this._leaseMs(source.leaseMs === undefined ? DEFAULT_TASK_LEASE_MS : source.leaseMs, 'leaseMs');
    return this.transaction(db => {
      const now = this._now();
      const attempt = this._taskAttempt(db, claim);
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(claim.taskId);
      if (attempt.status === 'running' && task && task.status === 'running' && task.fence === claim.fence) {
        const current = this._currentTaskClaim(db, claim, now, ['running']);
        const leaseExpiresAtMs = Math.max(current.task.lease_expires_at_ms, now + leaseMs);
        db.prepare('UPDATE tasks SET lease_expires_at_ms = ?, updated_at_ms = ? WHERE id = ? AND fence = ?').run(leaseExpiresAtMs, now, task.id, claim.fence);
        db.prepare('UPDATE task_attempts SET lease_expires_at_ms = ?, updated_at_ms = ? WHERE task_id = ? AND fence = ?').run(leaseExpiresAtMs, now, task.id, claim.fence);
        return { replayed: true, task: this._taskRow(db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id)), handle: claim, leaseExpiresAtMs };
      }
      const current = this._currentTaskClaim(db, claim, now, ['leased']);
      if (current.task.cancel_requested_at_ms !== null) {
        throw stateError('TASK_CANCEL_REQUESTED', 'Cancellation was requested before task execution started.', { taskId: current.task.id });
      }
      if (current.task.attempt + 1 !== claim.attempt || claim.attempt > current.task.max_attempts) {
        throw stateError('TASK_INVALID_TRANSITION', 'The claimed execution attempt is no longer eligible to start.', { taskId: current.task.id, attempt: claim.attempt });
      }
      const leaseExpiresAtMs = Math.max(current.task.lease_expires_at_ms, now + leaseMs);
      const changed = db.prepare(`UPDATE tasks SET status = 'running', attempt = ?, lease_expires_at_ms = ?, updated_at_ms = ?
        WHERE id = ? AND fence = ? AND status = 'leased' AND lease_expires_at_ms > ?`).run(
        claim.attempt, leaseExpiresAtMs, now, claim.taskId, claim.fence, now
      );
      if (changed.changes !== 1) throw stateError('TASK_FENCE_LOST', 'The task claim changed before execution could start.', { taskId: claim.taskId, fence: claim.fence });
      db.prepare(`UPDATE task_attempts SET status = 'running', lease_expires_at_ms = ?, started_at_ms = ?, updated_at_ms = ?
        WHERE task_id = ? AND fence = ? AND status = 'leased'`).run(leaseExpiresAtMs, now, now, claim.taskId, claim.fence);
      return {
        replayed: false,
        task: this._taskRow(db.prepare('SELECT * FROM tasks WHERE id = ?').get(claim.taskId)),
        handle: claim,
        leaseExpiresAtMs
      };
    });
  }

  heartbeatTask(handle, options = {}) {
    const claim = this._validateTaskHandle(handle);
    const source = assertPlainObject(options, 'options');
    const leaseMs = this._leaseMs(source.leaseMs === undefined ? DEFAULT_TASK_LEASE_MS : source.leaseMs, 'leaseMs');
    return this.transaction(db => {
      const now = this._now();
      const current = this._currentTaskClaim(db, claim, now, ['running']);
      const leaseExpiresAtMs = Math.max(current.task.lease_expires_at_ms, now + leaseMs);
      const changed = db.prepare(`UPDATE tasks SET lease_expires_at_ms = ?, updated_at_ms = ?
        WHERE id = ? AND fence = ? AND status = 'running' AND lease_expires_at_ms > ?`).run(
        leaseExpiresAtMs, now, claim.taskId, claim.fence, now
      );
      if (changed.changes !== 1) throw stateError('TASK_FENCE_LOST', 'The task claim changed before its heartbeat.', { taskId: claim.taskId, fence: claim.fence });
      db.prepare(`UPDATE task_attempts SET lease_expires_at_ms = ?, updated_at_ms = ?
        WHERE task_id = ? AND fence = ? AND status = 'running'`).run(leaseExpiresAtMs, now, claim.taskId, claim.fence);
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(claim.taskId);
      return { task: this._taskRow(task), handle: claim, leaseExpiresAtMs, cancelRequested: task.cancel_requested_at_ms !== null };
    });
  }

  inspectTaskClaim(handle) {
    const claim = this._validateTaskHandle(handle);
    return this.transaction(db => {
      const now = this._now();
      const current = this._currentTaskClaim(db, claim, now, ['running']);
      return {
        task: this._taskRow(current.task),
        handle: claim,
        leaseExpiresAtMs: current.task.lease_expires_at_ms,
        cancelRequested: current.task.cancel_requested_at_ms !== null
      };
    });
  }

  _taskCheckpoint(value) {
    const checkpoint = assertPlainObject(value, 'checkpoint');
    assertNoPlaintextTaskSecrets(checkpoint, 'checkpoint');
    return checkpoint;
  }

  _checkpointRow(row) {
    if (!row) return null;
    return {
      revision: row.revision,
      checkpointKey: row.checkpoint_key,
      checkpoint: parseJson(row.checkpoint_json, 'task checkpoint'),
      hash: row.checkpoint_hash,
      previousHash: row.previous_hash,
      createdAt: iso(row.created_at_ms),
      createdAtMs: row.created_at_ms
    };
  }

  checkpointTask(handle, options = {}) {
    const claim = this._validateTaskHandle(handle);
    const source = assertPlainObject(options, 'options');
    const checkpointKey = this._taskKey(source.checkpointKey, 'checkpointKey');
    const expectedRevision = assertInteger(source.expectedRevision, 'expectedRevision', { min: 0, max: MAX_TASK_CHECKPOINTS });
    const checkpoint = this._taskCheckpoint(source.checkpoint);
    const checkpointJson = boundedTaskJson(checkpoint, 'checkpoint', MAX_TASK_CHECKPOINT_BYTES, 'TASK_CHECKPOINT_TOO_LARGE');
    const leaseMs = source.leaseMs === undefined ? null : this._leaseMs(source.leaseMs, 'leaseMs');
    return this.transaction(db => {
      const now = this._now();
      const attempt = this._taskAttempt(db, claim);
      const prior = db.prepare('SELECT * FROM task_checkpoints WHERE task_id = ? AND fence = ? AND checkpoint_key = ?').get(
        claim.taskId, claim.fence, checkpointKey
      );
      if (prior) {
        if (prior.checkpoint_json !== checkpointJson) {
          throw stateError('TASK_CHECKPOINT_CONFLICT', 'The checkpoint key was already used with different content.', { taskId: claim.taskId, checkpointKey });
        }
        return {
          replayed: true,
          task: this._taskRow(db.prepare('SELECT * FROM tasks WHERE id = ?').get(claim.taskId)),
          handle: claim,
          savedCheckpoint: this._checkpointRow(prior),
          leaseExpiresAtMs: attempt.lease_expires_at_ms
        };
      }
      const current = this._currentTaskClaim(db, claim, now, ['running']);
      if (current.task.cancel_requested_at_ms !== null) {
        throw stateError('TASK_CANCEL_REQUESTED', 'Cancellation was requested before this checkpoint could be saved.', { taskId: claim.taskId });
      }
      if (current.task.checkpoint_revision !== expectedRevision) {
        throw stateError('TASK_CHECKPOINT_REVISION_CONFLICT', 'The checkpoint revision changed before this update.', {
          taskId: claim.taskId, expectedRevision, actualRevision: current.task.checkpoint_revision
        });
      }
      if (current.task.checkpoint_revision >= MAX_TASK_CHECKPOINTS) {
        throw stateError('TASK_CHECKPOINT_LIMIT', 'The task reached its checkpoint limit.', { taskId: claim.taskId, maximum: MAX_TASK_CHECKPOINTS });
      }
      const revision = current.task.checkpoint_revision + 1;
      const previousHash = current.task.checkpoint_hash;
      const checkpointHash = hashInput({ taskId: claim.taskId, revision, fence: claim.fence, attempt: claim.attempt, checkpointKey, previousHash, checkpoint });
      db.prepare(`INSERT INTO task_checkpoints(task_id, revision, fence, execution_attempt, checkpoint_key, previous_hash,
        checkpoint_json, checkpoint_hash, created_at_ms) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        claim.taskId, revision, claim.fence, claim.attempt, checkpointKey, previousHash, checkpointJson, checkpointHash, now
      );
      const leaseExpiresAtMs = leaseMs === null ? current.task.lease_expires_at_ms : Math.max(current.task.lease_expires_at_ms, now + leaseMs);
      const changed = db.prepare(`UPDATE tasks SET checkpoint_revision = ?, checkpoint_key = ?, checkpoint_json = ?, checkpoint_hash = ?,
        lease_expires_at_ms = ?, updated_at_ms = ? WHERE id = ? AND fence = ? AND status = 'running'
        AND checkpoint_revision = ? AND lease_expires_at_ms > ?`).run(
        revision, checkpointKey, checkpointJson, checkpointHash, leaseExpiresAtMs, now,
        claim.taskId, claim.fence, expectedRevision, now
      );
      if (changed.changes !== 1) throw stateError('TASK_FENCE_LOST', 'The task claim changed before its checkpoint could commit.', { taskId: claim.taskId, fence: claim.fence });
      if (leaseMs !== null) db.prepare('UPDATE task_attempts SET lease_expires_at_ms = ?, updated_at_ms = ? WHERE task_id = ? AND fence = ? AND status = \'running\'').run(
        leaseExpiresAtMs, now, claim.taskId, claim.fence
      );
      const saved = db.prepare('SELECT * FROM task_checkpoints WHERE task_id = ? AND revision = ?').get(claim.taskId, revision);
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(claim.taskId);
      return {
        replayed: false,
        task: this._taskRow(task),
        handle: claim,
        savedCheckpoint: this._checkpointRow(saved),
        leaseExpiresAtMs,
        cancelRequested: task.cancel_requested_at_ms !== null
      };
    });
  }

  _taskResult(value) {
    const result = assertPlainObject(value, 'result');
    assertNoPlaintextTaskSecrets(result, 'result');
    return result;
  }

  completeTask(handle, options = {}) {
    const claim = this._validateTaskHandle(handle);
    const source = assertPlainObject(options, 'options');
    return this.transaction(db => this._completeTask(db, claim, source.result));
  }

  // Runs inside the caller's transaction. No nested transaction is permitted.
  _completeTask(db, claim, value) {
    const result = this._taskResult(value);
    const resultJson = boundedTaskJson(result, 'result', MAX_JSON_BYTES, 'TASK_RESULT_TOO_LARGE');
    const resultHash = hashText(resultJson);
    const outcomeHash = hashInput({ disposition: 'succeeded', result });
    const now = this._now();
    const attempt = this._taskAttempt(db, claim);
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(claim.taskId);
    if (attempt.status === 'succeeded') {
      if (!equalHash(attempt.outcome_hash, outcomeHash) || !task || task.status !== 'succeeded'
          || task.result_hash !== resultHash || task.result_json !== resultJson) {
        throw stateError('TASK_OUTCOME_CONFLICT', 'The task attempt already recorded a different terminal outcome.', { taskId: claim.taskId, fence: claim.fence });
      }
      return { replayed: true, task: this._taskRow(task), result };
    }
    if (task && task.cancel_requested_at_ms !== null) {
      throw stateError('TASK_CANCEL_REQUESTED', 'Cancellation was requested before task completion could be recorded.', { taskId: claim.taskId });
    }
    if (!task || task.fence !== claim.fence || task.attempt !== claim.attempt || !['running', 'uncertain'].includes(task.status)
      || !['running', 'uncertain'].includes(attempt.status)) {
      throw stateError('TASK_FENCE_LOST', 'The task attempt no longer owns the completion fence.', { taskId: claim.taskId, fence: claim.fence });
    }
    const attemptChanged = db.prepare(`UPDATE task_attempts SET status = 'succeeded', updated_at_ms = ?, ended_at_ms = ?, outcome_hash = ?,
      error_code = NULL, error_message = NULL WHERE task_id = ? AND fence = ? AND status IN ('running','uncertain')`).run(
      now, now, outcomeHash, claim.taskId, claim.fence
    );
    if (attemptChanged.changes !== 1) throw stateError('TASK_FENCE_LOST', 'The task attempt changed before completion could commit.', { taskId: claim.taskId, fence: claim.fence });
    const changed = db.prepare(`UPDATE tasks SET status = 'succeeded', result_json = ?, result_hash = ?, error_code = NULL,
      error_message = NULL, lease_worker_label = NULL, lease_token_hash = NULL, lease_expires_at_ms = NULL,
      completed_at_ms = ?, updated_at_ms = ? WHERE id = ? AND fence = ? AND status IN ('running','uncertain')`).run(
      resultJson, resultHash, now, now, claim.taskId, claim.fence
    );
    if (changed.changes !== 1) throw stateError('TASK_FENCE_LOST', 'The task changed before completion could commit.', { taskId: claim.taskId, fence: claim.fence });
    return { replayed: false, task: this._taskRow(db.prepare('SELECT * FROM tasks WHERE id = ?').get(claim.taskId)), result };
  }

  failTask(handle, options = {}) {
    const claim = this._validateTaskHandle(handle);
    const source = assertPlainObject(options, 'options');
    const disposition = source.disposition;
    if (!['retry', 'failed', 'uncertain', 'cancelled'].includes(disposition)) {
      throw stateError('STATE_INVALID_ARGUMENT', 'disposition must be retry, failed, uncertain, or cancelled.', { field: 'disposition' });
    }
    const code = assertString(source.code, 'code', { max: 100, pattern: /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/ });
    const message = assertString(source.message === undefined ? '' : source.message, 'message', { min: 0, max: 1000 });
    const retryDelayMs = source.retryDelayMs === undefined ? null : assertInteger(source.retryDelayMs, 'retryDelayMs', { min: 0, max: 3600000 });
    if (retryDelayMs !== null && disposition !== 'retry') throw stateError('STATE_INVALID_ARGUMENT', 'retryDelayMs is valid only for retry disposition.', { field: 'retryDelayMs' });
    assertNoPlaintextTaskSecrets({ code, message }, 'failure');
    const outcomeHash = hashInput({ disposition, code, message, retryDelayMs });
    return this.transaction(db => {
      const now = this._now();
      const attempt = this._taskAttempt(db, claim);
      let task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(claim.taskId);
      if (disposition === 'retry' && task && task.expiry_policy !== 'retry') {
        throw stateError('TASK_RETRY_FORBIDDEN', 'This task was not submitted with a retry-safe expiry policy.', { taskId: claim.taskId });
      }
      const terminalAttemptStates = new Set(['retryable_failed', 'failed', 'cancelled']);
      if (terminalAttemptStates.has(attempt.status)) {
        if (!equalHash(attempt.outcome_hash, outcomeHash)) {
          throw stateError('TASK_OUTCOME_CONFLICT', 'The task attempt already recorded a different terminal outcome.', { taskId: claim.taskId, fence: claim.fence });
        }
        return { replayed: true, task: this._taskRow(task) };
      }
      if (attempt.status === 'uncertain') {
        if (disposition === 'uncertain') {
          if (!equalHash(attempt.outcome_hash, outcomeHash)) throw stateError('TASK_OUTCOME_CONFLICT', 'The task attempt already recorded different uncertainty details.', { taskId: claim.taskId, fence: claim.fence });
          return { replayed: true, task: this._taskRow(task) };
        }
        if (disposition !== 'failed') {
          throw stateError('TASK_UNCERTAIN', 'An uncertain task may only accept a definitive late success or failure from its original claim.', { taskId: claim.taskId, fence: claim.fence });
        }
      }
      if (!task || task.fence !== claim.fence || attempt.execution_attempt !== claim.attempt
        || !['leased', 'running', 'uncertain'].includes(task.status) || !['leased', 'running', 'uncertain'].includes(attempt.status)) {
        throw stateError('TASK_FENCE_LOST', 'The task attempt no longer owns the failure fence.', { taskId: claim.taskId, fence: claim.fence });
      }
      if (['leased', 'running'].includes(task.status)
        && (task.lease_worker_label !== claim.workerLabel || !equalHash(task.lease_token_hash, hashText(claim.claimToken)))) {
        throw stateError('TASK_FENCE_LOST', 'The task claim no longer owns the active failure fence.', { taskId: claim.taskId, fence: claim.fence });
      }
      if (disposition === 'uncertain' && task.status === 'leased') {
        throw stateError('TASK_INVALID_TRANSITION', 'A task that never started cannot have an uncertain execution outcome.', { taskId: task.id, status: task.status });
      }
      if (disposition === 'cancelled' && task.cancel_requested_at_ms === null) {
        throw stateError('TASK_CANCEL_NOT_REQUESTED', 'The worker may acknowledge cancellation only after it was requested.', { taskId: task.id });
      }

      let taskStatus;
      let attemptStatus;
      let errorCode = code;
      let errorMessage = message;
      let availableAtMs = task.available_at_ms;
      let completedAtMs = now;
      // A retry acknowledgement ends this attempt. If cancellation already
      // won, there must be no queued successor: retry_wait with a cancellation
      // flag has neither an eligible claimant nor a lease for the reaper.
      if (disposition === 'cancelled' || (disposition === 'retry' && task.cancel_requested_at_ms !== null)) {
        taskStatus = 'cancelled'; attemptStatus = 'cancelled'; errorCode = null; errorMessage = null;
      } else if (disposition === 'uncertain') {
        taskStatus = 'uncertain'; attemptStatus = 'uncertain';
      } else if (disposition === 'retry' && task.attempt < task.max_attempts) {
        taskStatus = 'retry_wait'; attemptStatus = 'retryable_failed'; completedAtMs = null;
        availableAtMs = retryDelayMs === null ? this._taskBackoff(task, now) : now + retryDelayMs;
      } else {
        taskStatus = 'failed'; attemptStatus = 'failed';
      }
      const attemptChanged = db.prepare(`UPDATE task_attempts SET status = ?, updated_at_ms = ?, ended_at_ms = ?, outcome_hash = ?,
        error_code = ?, error_message = ? WHERE task_id = ? AND fence = ? AND status IN ('leased','running','uncertain')`).run(
        attemptStatus, now, now, outcomeHash, attemptStatus === 'cancelled' ? null : code, attemptStatus === 'cancelled' ? null : message,
        claim.taskId, claim.fence
      );
      if (attemptChanged.changes !== 1) throw stateError('TASK_FENCE_LOST', 'The task attempt changed before its failure outcome could commit.', { taskId: claim.taskId, fence: claim.fence });
      const changed = db.prepare(`UPDATE tasks SET status = ?, available_at_ms = ?, lease_worker_label = NULL, lease_token_hash = NULL,
        lease_expires_at_ms = NULL, error_code = ?, error_message = ?, completed_at_ms = ?, updated_at_ms = ?
        WHERE id = ? AND fence = ? AND status IN ('leased','running','uncertain')`).run(
        taskStatus, availableAtMs, errorCode, errorMessage, completedAtMs, now, claim.taskId, claim.fence
      );
      if (changed.changes !== 1) throw stateError('TASK_FENCE_LOST', 'The task changed before its failure outcome could commit.', { taskId: claim.taskId, fence: claim.fence });
      task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(claim.taskId);
      return { replayed: false, task: this._taskRow(task) };
    });
  }

  cancelTask(input) {
    const source = assertPlainObject(input, 'cancellation');
    const taskId = assertString(source.taskId, 'taskId', { max: 500 });
    const reason = assertString(source.reason === undefined ? '' : source.reason, 'reason', { min: 0, max: 1000 });
    assertNoPlaintextTaskSecrets(reason, 'reason');
    return this.transaction(db => {
      const now = this._now();
      let row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
      if (!row) throw stateError('TASK_NOT_FOUND', 'The durable task was not found.', { taskId });
      if (['succeeded', 'failed', 'cancelled'].includes(row.status)) {
        return { disposition: 'terminal', task: this._taskRow(row) };
      }
      if (row.status === 'uncertain') return { disposition: 'uncertain', task: this._taskRow(row) };
      if (['queued', 'retry_wait'].includes(row.status)) {
        db.prepare(`UPDATE tasks SET status = 'cancelled', cancel_requested_at_ms = COALESCE(cancel_requested_at_ms, ?), cancel_reason = ?,
          error_code = NULL, error_message = NULL, completed_at_ms = ?, updated_at_ms = ? WHERE id = ? AND status IN ('queued','retry_wait')`).run(
          now, reason, now, now, taskId
        );
        row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
        return { disposition: 'cancelled', task: this._taskRow(row) };
      }
      db.prepare(`UPDATE tasks SET cancel_requested_at_ms = COALESCE(cancel_requested_at_ms, ?), cancel_reason = COALESCE(cancel_reason, ?), updated_at_ms = ?
        WHERE id = ? AND status IN ('leased','running')`).run(now, reason, now, taskId);
      row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
      return { disposition: 'requested', task: this._taskRow(row), cancelRequested: true };
    });
  }

  reapExpiredTasks(options = {}) {
    const source = assertPlainObject(options, 'options');
    const queue = source.queue === undefined ? undefined : this._taskIdentifier(source.queue, 'queue');
    const limit = assertInteger(source.limit === undefined ? 1000 : source.limit, 'limit', { min: 1, max: 1000 });
    return this.transaction(db => this._reapExpiredTasks(db, this._now(), { queue, limit }));
  }

  getTask(input) {
    const source = assertPlainObject(input, 'selector');
    const taskId = assertString(source.taskId, 'taskId', { max: 500 });
    const includePayload = source.includePayload === true;
    const includeCheckpoint = source.includeCheckpoint === true;
    const now = this._now();
    return this._read(db => this._taskRow(db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId), { includePayload, includeCheckpoint, now }));
  }

  listTasks(options = {}) {
    const source = assertPlainObject(options, 'options');
    if (source.status !== undefined && source.statuses !== undefined) {
      throw stateError('STATE_INVALID_ARGUMENT', 'Use status or statuses, not both.', { field: 'statuses' });
    }
    const limit = assertInteger(source.limit === undefined ? 100 : source.limit, 'limit', { min: 1, max: 200 });
    const clauses = [];
    const values = [];
    if (source.queue !== undefined) { clauses.push('queue_name = ?'); values.push(this._taskIdentifier(source.queue, 'queue')); }
    if (source.type !== undefined) { clauses.push('task_type = ?'); values.push(this._taskIdentifier(source.type, 'type')); }
    let statuses;
    if (source.status !== undefined) {
      if (!TASK_READ_STATES.has(source.status)) throw stateError('STATE_INVALID_ARGUMENT', 'status is invalid.', { field: 'status' });
      statuses = [source.status];
    }
    if (source.statuses !== undefined) {
      statuses = source.statuses;
      if (!Array.isArray(statuses) || statuses.length < 1 || statuses.length > TASK_READ_STATES.size
          || Array.from(statuses).some(status => !TASK_READ_STATES.has(status))
          || new Set(statuses).size !== statuses.length) {
        throw stateError('STATE_INVALID_ARGUMENT', 'statuses must contain unique valid task states.', { field: 'statuses' });
      }
    }
    const now = this._now();
    if (statuses) {
      // Match _taskRow's reported status before ordering/LIMIT. Filtering raw
      // status (or filtering the limited rows afterward) hides expired work.
      // The same captured clock drives this predicate and the returned rows;
      // no reaper or transition runs on this read path.
      clauses.push(`(CASE WHEN status IN ('leased','running') AND lease_expires_at_ms IS NOT NULL AND lease_expires_at_ms <= ?
        THEN CASE WHEN status = 'leased' THEN 'expired' ELSE 'uncertain' END
        ELSE status END) IN (${statuses.map(() => '?').join(',')})`);
      values.push(now, ...statuses);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    values.push(limit);
    return this._read(db => db.prepare(`SELECT * FROM tasks ${where} ORDER BY updated_at_ms DESC, id DESC LIMIT ?`).all(...values)
      .map(row => this._taskRow(row, { includePayload: false, includeCheckpoint: false, includeResult: false, includeError: false, now })));
  }

  checkIntegrity({ full = false } = {}) {
    if (typeof full !== 'boolean') throw stateError('STATE_INVALID_ARGUMENT', 'full must be a boolean.', { field: 'full' });
    const mode = full ? 'full' : 'quick';
    const pragma = full ? 'PRAGMA integrity_check' : 'PRAGMA quick_check';
    return this._read(db => {
      const rows = db.prepare(pragma).all();
      const result = rows.map(row => Object.values(row)[0]);
      return { ok: result.length === 1 && result[0] === 'ok', mode, result };
    });
  }

  // OPEN AND VALIDATE NOW, RATHER THAN WHENEVER SOMETHING HAPPENS TO ASK.
  //
  // The constructor is deliberately lazy -- it resolves a path and returns --
  // so _open(), and with it _migrate() and the _validateSchema() call that
  // NAMES a missing or altered STRICT table, does not run until some operation
  // needs the database. That laziness lets a damaged store go down quietly:
  // the product starts clean, then every state-backed tool fails separately
  // with its own error, and the only place that names the missing table is a
  // nested field inside system.status. With a required table dropped,
  // getStateStore() still returns a usable handle at once and throws nothing.
  //
  // This method exists so a startup path can pay that cost on purpose. It is
  // about 30 ms on the full 41-table database (10 ms with a warm cache), and it
  // throws exactly the STATE_SCHEMA_INVALID that names the offending table.
  // It returns nothing: the database handle stays private.
  ensureOpen() {
    this._open();
    return true;
  }

  health() {
    return this._read(db => {
      this._validateSchema(db);
      const rows = db.prepare('PRAGMA quick_check').all();
      const result = rows.map(row => Object.values(row)[0]);
      const integrity = { ok: result.length === 1 && result[0] === 'ok', mode: 'quick', result };
      const health = {
        ok: integrity.ok,
        path: this.file,
        schemaVersion: db.prepare('PRAGMA user_version').get().user_version,
        applicationId: db.prepare('PRAGMA application_id').get().application_id,
        journalMode: db.prepare('PRAGMA journal_mode').get().journal_mode,
        synchronous: db.prepare('PRAGMA synchronous').get().synchronous,
        foreignKeys: Boolean(db.prepare('PRAGMA foreign_keys').get().foreign_keys),
        busyTimeoutMs: db.prepare('PRAGMA busy_timeout').get().timeout,
        integrity
      };
      if (!health.ok) throw stateError('STATE_INTEGRITY_FAILED', 'The durable state database failed its integrity check.', { result: integrity.result });
      return health;
    });
  }


}

function createStateStore(options = {}) {
  return new StateStore(options);
}

let singleton;
// Open and validate the durable database before sharing its process-wide
// handle. A missing or altered required table fails at startup.
function getStateStore() {
  if (!singleton) {
    const candidate = createStateStore();
    try {
      candidate.ensureOpen();
      singleton = candidate;
    } catch (error) {
      candidate.close();
      throw error;
    }
  }
  return singleton;
}

function closeStateStore() {
  if (!singleton) return false;
  const closed = singleton.close();
  singleton = undefined;
  return closed;
}

module.exports = {
  APPLICATION_ID,
  DEFAULT_STATE_PATH,
  // The table -> columns map this build actually requires. Exported so a suite
  // can assert the storage it depends on is still present in the CURRENT
  // schema instead of pinning a schema NUMBER, which every additive bump
  // falsifies without breaking anything. Frozen, so a reader cannot mutate it.
  REQUIRED_SCHEMA,
  SCHEMA_VERSION,
  // The schema 24 fingerprint an upgrade must match. Exported so the upgrade
  // test can hold it to the value the 1.6.10 ladder computed.
  SCHEMA_V24_FINGERPRINT,
  StateStore,
  StateStoreError,
  closeStateStore,
  createStateStore,
  getStateStore,
  hashInput
};
