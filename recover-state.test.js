'use strict';

/*
 * Mutation check: each mutation landed and was confirmed in the source before the run.
 *   1. liveSessions stops comparing `started`, so a reused pid counts as live -> RED (1 of 6)
 *   2. backup copies only the main database, not -wal and -shm             -> RED (1 of 6)
 *   3. liveness fails OPEN again -- an unreadable directory or record is
 *      treated as "nothing running"                                       -> RED (2 of 6)
 *   Restored: GREEN (6 of 6).
 *
 * Run with: node --test recover-state.test.js
 */

// THE TWO PARTS OF RECOVERY THAT CAN GO WRONG QUIETLY.
//
// recover-state.js destroys message history, so the guard that keeps it from
// running under a live Fleet and the backup it takes first are the parts worth
// pinning. The clearing itself is StateStore.clearMemoryNamespace, covered by the
// engine's tests/reserved-memory-doctor.test.js.
//
// A STALE BINDING MUST NOT BLOCK RECOVERY FOREVER. A crashed session leaves its
// binding file behind. If liveness were "a file exists", a crash would make the
// repair unreachable, so liveness is the recorded process still being the same
// process -- pid AND start time, because pids are reused.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { liveSessions, backup } = require('./recover-state');
const { identity } = require('./session-binding');

const made = [];
function scratch(name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `recover-${name}-`));
  made.push(directory);
  return directory;
}
test.after(() => { for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

function writeBinding(stateRoot, record) {
  const directory = path.join(stateRoot, 'plugin-session-bindings');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const name = `${record.bridge.pid}-${record.bridge.started}.json`;
  fs.writeFileSync(path.join(directory, name), JSON.stringify(record), { mode: 0o600 });
  return name;
}

test('no bindings at all means nothing is running', () => {
  assert.deepEqual(liveSessions(scratch('empty')), []);
});

test('a binding for this live process counts as running', () => {
  const stateRoot = scratch('live');
  const me = identity(process.pid);
  assert.ok(me, 'this process must be readable');
  const name = writeBinding(stateRoot, { version: 1, engine: 'x', client: me, bridge: me, runtime: me });
  assert.deepEqual(liveSessions(stateRoot), [name]);
});

test('a binding whose process is gone, or whose start time disagrees, does not block recovery', () => {
  const stateRoot = scratch('stale');
  const me = identity(process.pid);
  // Same pid, a start time that is not this process's: a reused pid, not Fleet.
  const reused = { ...me, started: String(Number(me.started) + 1) };
  writeBinding(stateRoot, { version: 1, engine: 'x', client: reused, bridge: reused, runtime: reused });
  // A pid that cannot be a live process at all.
  const gone = { pid: 2147483646, parent: 1, started: '1' };
  writeBinding(stateRoot, { version: 1, engine: 'x', client: gone, bridge: gone, runtime: gone });
  assert.deepEqual(liveSessions(stateRoot), [], 'a crashed session must not make recovery unreachable');
});

test('a session record this cannot read counts as live, never as absent', () => {
  const stateRoot = scratch('unreadable-record');
  const directory = path.join(stateRoot, 'plugin-session-bindings');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  // A correctly named file whose contents are not JSON. Being unable to tell must
  // not read as nothing running: the cost of being wrong this way is a refusal the
  // person clears by closing sessions, and the other way is clearing state under a
  // running Fleet.
  fs.writeFileSync(path.join(directory, '4242-4242.json'), 'not json at all', { mode: 0o600 });
  assert.deepEqual(liveSessions(stateRoot), ['4242-4242.json']);
});

test('a bindings directory that cannot be listed refuses rather than reporting nothing', () => {
  const stateRoot = scratch('unreadable-dir');
  const directory = path.join(stateRoot, 'plugin-session-bindings');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o000);
  try {
    assert.throws(() => liveSessions(stateRoot), /could not be read/);
  } finally { fs.chmodSync(directory, 0o700); }
});

test('the backup takes the whole database, owner-readable only', () => {
  const stateDirectory = scratch('backup');
  for (const name of ['toolsenabled.sqlite3', 'toolsenabled.sqlite3-wal', 'toolsenabled.sqlite3-shm']) {
    fs.writeFileSync(path.join(stateDirectory, name), `contents of ${name}`, { mode: 0o600 });
  }
  const saved = backup(stateDirectory);
  // -wal and -shm are part of the database's current contents; a backup without
  // them is not the database you had.
  assert.deepEqual(saved.copied.sort(), ['toolsenabled.sqlite3', 'toolsenabled.sqlite3-shm', 'toolsenabled.sqlite3-wal']);
  for (const name of saved.copied) {
    const file = path.join(saved.into, name);
    assert.equal(fs.readFileSync(file, 'utf8'), `contents of ${name}`);
    assert.equal(fs.statSync(file).mode & 0o077, 0, `${name} must not be readable by anyone else`);
  }
  assert.throws(() => backup(scratch('backup-empty')), /No state database found/);
});
