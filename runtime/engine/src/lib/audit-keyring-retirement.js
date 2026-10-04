'use strict';

// MOVING A KEYRING-BOUND AUDIT HISTORY ASIDE FOR A NEW PRIVATE-FILE KEY.
//
// Fleet 1.6 could keep the audit signing key and the protected head record in
// the login keyring. This version never reads the keyring, so that history
// cannot be continued honestly: the old key cannot sign a handover, a new key
// cannot attest what the old one signed, and the head record -- the only
// witness against a truncated tail -- is unreadable. So the first audit use
// with audit on archives that history read-only in the state folder and starts
// a new ledger. Its first event, signed by a new private-file key, says where
// the history went and why. The archive keeps its own signatures and can still
// be checked against the keys recorded inside it.
//
// The steps, in the order that makes an interrupted move safe to repeat:
//   1. The new key is parked in the key store beside the retired selection,
//      so every attempt uses the same key and the same archive folder.
//   2. One ledger write transaction copies the committed ledger (VACUUM INTO)
//      and its projections and sidecars into the archive, empties the ledger
//      and appends the first event. A crash before COMMIT leaves the old ledger
//      in place; the repeat keeps every copy that already exists.
//   3. After COMMIT the archived files are made read-only, and the key store
//      stores the new head and switches to private files. A repeat that finds
//      the committed marker for the parked key only finishes this step.
// Every file is written under a temporary name and renamed into place while
// the ledger's write lock is held, so a kill at any point leaves no second
// link to an archived file. Each attempt first removes the temporary files an
// interrupted attempt left. The archive's folders stay writable (0700), so
// deleting the state folder (rm -rf) also deletes the archive.
// Nothing here reads the keyring or any key it held.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MARKER_KEY = 'keyring-retirement-v1';
const ACTION = 'audit.keyring_history_archived';
const NOTE = 'An earlier Fleet version kept the audit signing key and its head record in the login keyring, which this version does not read. That history was archived read-only and this ledger starts with a new key, which does not attest the archived history.';

// The names this module gives files it is still writing: a ledger copy
// (.copy-<pid>-<uuid>.sqlite3) and any other file (<name>.<pid>.<uuid>.tmp).
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const LEDGER_COPY_TEMPORARY = new RegExp(`^\\.copy-\\d+-${UUID}\\.sqlite3$`);
const FILE_TEMPORARY = new RegExp(`^.+\\.(\\d+)\\.${UUID}\\.tmp$`);

function fsyncFile(file) {
  const fd = fs.openSync(file, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// Moves a complete temporary file to its final name unless that name already
// exists: the first complete copy is the one kept. The caller holds the
// ledger's write lock, so no other attempt writes the archive meanwhile, and a
// rename never leaves the file with a second link.
function placeOnce(temporary, destination) {
  try { fs.lstatSync(destination); return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  fs.renameSync(temporary, destination);
}

// Copies `source` to `destination` unless `destination` already exists. A
// partial copy is never visible under the final name.
function copyOnce(source, destination, fault) {
  let stat;
  try { stat = fs.lstatSync(source); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!stat.isFile()) throw Object.assign(new Error('An audit file to archive is not a regular file.'), { code: 'AUDIT_ARCHIVE_FILE_UNSUPPORTED' });
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
    fsyncFile(temporary);
    fault('file-copy-written');
    placeOnce(temporary, destination);
    fault('file-copy-placed');
  } finally { fs.rmSync(temporary, { force: true }); }
  return true;
}

// Removes what an interrupted attempt was still writing: every temporary file
// in the archive, and a temporary projection file whose writer has exited. A
// projection file of a running process is left alone; the projection writer in
// audit.js uses the same names.
function sweepTemporaries(archive, projections) {
  (function sweep(directory) {
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const item = path.join(directory, entry.name);
      if (entry.isDirectory()) sweep(item);
      else if (entry.isFile() && (LEDGER_COPY_TEMPORARY.test(entry.name) || FILE_TEMPORARY.test(entry.name))) fs.rmSync(item, { force: true });
    }
  })(archive);
  for (const file of projections) {
    let names = [];
    try { names = fs.readdirSync(path.dirname(file)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const name of names) {
      const match = name.startsWith(`${path.basename(file)}.`) ? FILE_TEMPORARY.exec(name) : null;
      if (match && match[1] !== String(process.pid) && !processRunning(Number(match[1]))) {
        fs.rmSync(path.join(path.dirname(file), name), { force: true });
      }
    }
  }
}

function processRunning(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

function writeFileDurably(file, content) {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
}

// The ledger's sidecars that belong to the history being archived: its two
// projections (emptied, since the new ledger starts at genesis) and the spool,
// quarantine, archive-segment and anchor-intent files (moved). The durability
// health record stays where it is; it describes this installation, not a key.
function sidecars(files, stateDirectory) {
  const projections = [files.jsonl, files.text];
  const moved = [];
  const spoolDirectory = path.dirname(files.emergency);
  const spoolName = path.basename(files.emergency);
  const spoolStem = path.basename(files.emergency, path.extname(files.emergency));
  let names = [];
  try { names = fs.readdirSync(spoolDirectory); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const name of names) {
    if (name === spoolName || name.startsWith(`${spoolName}.quarantine-`) || name.startsWith(`${spoolStem}.ingest-`)) {
      moved.push({ file: path.join(spoolDirectory, name), relative: path.join('logs', name) });
    }
  }
  moved.push({ file: path.join(stateDirectory, 'audit-archive.jsonl'), relative: path.join('state', 'audit-archive.jsonl') });
  const intents = path.join(stateDirectory, 'audit-anchor-intents');
  try {
    for (const name of fs.readdirSync(intents)) {
      if (/^\d+\.json$/.test(name)) moved.push({ file: path.join(intents, name), relative: path.join('state', 'audit-anchor-intents', name) });
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { projections, moved };
}

// The archived files become read-only (0400). Their folders stay 0700: a
// folder without write permission would make deleting the state folder fail.
function makeReadOnly(directory) {
  fs.chmodSync(directory, 0o700);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const item = path.join(directory, entry.name);
    if (entry.isDirectory()) makeReadOnly(item);
    else if (entry.isFile()) fs.chmodSync(item, 0o400);
  }
}

// Checks the archived copy only against the keys recorded inside it. That is
// all anyone can check now: its head record stayed in the keyring.
function selfConsistency(archiveFile, stateDirectory, { withReadOnlyLedger, verifiedArchiveBoundary }) {
  try {
    return withReadOnlyLedger(archiveFile, ledger => {
      const stored = ledger.getMetadata('archive-boundary-v1');
      const key = stored && stored.value && typeof stored.value.keyId === 'string' ? ledger.getKey(stored.value.keyId) : null;
      const boundary = key ? verifiedArchiveBoundary(stored.value, { keyId: key.keyId, publicKeyPem: key.publicKeyPem }) : null;
      const checked = ledger.verify(boundary).verification;
      return { selfConsistent: checked.valid === true, reason: checked.valid ? null : checked.reason || 'invalid' };
    }, { scratchRoot: stateDirectory });
  } catch (error) {
    return { selfConsistent: false, reason: typeof error?.code === 'string' ? error.code : 'unreadable' };
  }
}

function retireKeyringHistory({
  keyStore, ledgerFile, files, stateDirectory, createAuditStore, signerFromPrivateKey, makeAnchor,
  eventInput, withReadOnlyLedger, verifiedArchiveBoundary, canonicalJson, report, clock = Date.now,
  fault = () => {}
}) {
  if (!keyStore.retirement.pending()) return null;
  const candidate = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const staged = keyStore.retirement.stage(candidate);
  if (staged === null) return null;
  const signer = signerFromPrivateKey(staged);
  const archiveName = `audit-history-keyring-${signer.keyId.slice(-12)}`;
  const archive = path.join(stateDirectory, archiveName);
  const store = createAuditStore({ file: ledgerFile });
  let head;
  try {
    const outcome = store.withAppendBatch(locked => {
      sweepTemporaries(archive, [files.jsonl, files.text]);
      const marker = locked.getMetadata(MARKER_KEY);
      if (marker && marker.value && marker.value.keyId === signer.keyId) {
        return { resumed: true, archived: Boolean(marker.value.archive) };
      }
      const before = locked.status();
      const now = clock();
      let archived = false;
      let previousHead = null;
      let previousHistoryCheck = null;
      const { projections, moved } = sidecars(files, stateDirectory);
      const pending = moved.filter(item => fs.existsSync(item.file));
      const projected = projections.some(file => { try { return fs.statSync(file).size > 0; } catch { return false; } });
      if (before.headSequence > 0 || pending.length > 0 || projected) {
        archived = true;
        fs.mkdirSync(archive, { recursive: true, mode: 0o700 });
        if (before.headSequence > 0) {
          previousHead = { sequence: before.headSequence, eventHash: before.headHash, keyId: before.headKeyId };
        }
        const ledgerCopy = path.join(archive, `audit-${before.headSequence}-${before.headHash.slice(0, 16)}.sqlite3`);
        if (!fs.existsSync(ledgerCopy)) {
          const temporary = path.join(archive, `.copy-${process.pid}-${crypto.randomUUID()}.sqlite3`);
          try {
            locked.copyCommittedTo(temporary);
            fsyncFile(temporary);
            fault('ledger-copy-written');
            placeOnce(temporary, ledgerCopy);
            fault('ledger-copy-placed');
          } finally { fs.rmSync(temporary, { force: true }); }
        }
        previousHistoryCheck = selfConsistency(ledgerCopy, stateDirectory, { withReadOnlyLedger, verifiedArchiveBoundary });
        for (const file of projections) copyOnce(file, path.join(archive, 'logs', path.basename(file)), fault);
        for (const item of pending) copyOnce(item.file, path.join(archive, item.relative), fault);
        writeFileDurably(path.join(archive, 'manifest.json'), `${canonicalJson({
          version: 1, reason: 'login-keyring-key-retired', note: NOTE, archivedAt: new Date(now).toISOString(),
          ledger: path.basename(ledgerCopy), previousHead, previousHistoryCheck, newKeyId: signer.keyId
        })}\n`);
        fault('copied');
        for (const file of projections) { if (fs.existsSync(file)) writeFileDurably(file, ''); }
        for (const item of pending) fs.rmSync(item.file, { force: true });
      }
      const relativeArchive = archived ? path.relative(path.dirname(stateDirectory), archive) : null;
      locked.restartForNewKey({
        keyId: signer.keyId, publicKeyPem: signer.publicKeyPem, nowMs: now,
        marker: { key: MARKER_KEY, value: { version: 1, keyId: signer.keyId, archive: relativeArchive, previousHead, at: now } }
      });
      locked.appendEvent(eventInput(ACTION, 'audit-ledger', {
        reason: 'login-keyring-key-retired', note: NOTE, archive: relativeArchive, previousHead,
        previousHistorySelfConsistent: previousHistoryCheck ? previousHistoryCheck.selfConsistent : null
      }, { clock: () => now }), signer);
      return { resumed: false, archived };
    });
    fault('committed');
    head = store.getEvent({ sequence: store.status().headSequence });
    if (outcome.archived && fs.existsSync(archive)) makeReadOnly(archive);
    if (!head || head.keyId !== signer.keyId) {
      throw Object.assign(new Error('The restarted audit ledger does not end in an event signed by the new key.'), { code: 'AUDIT_KEYRING_RETIREMENT_INCOMPLETE' });
    }
    const anchor = makeAnchor(head, signer);
    keyStore.retirement.complete(canonicalJson(anchor), anchor.sequence);
    if (!outcome.resumed) {
      report(outcome.archived
        ? `Fleet audit: the earlier audit key was kept in the login keyring, which this version does not read. That history was archived read-only in ${archive} and a new key started.`
        : 'Fleet audit: the earlier audit key was kept in the login keyring, which this version does not read. There was no history to archive; a new key started.');
    }
    return { archive: outcome.archived ? archive : null, keyId: signer.keyId, resumed: outcome.resumed };
  } finally {
    store.close();
  }
}

module.exports = { retireKeyringHistory, MARKER_KEY, ACTION };
