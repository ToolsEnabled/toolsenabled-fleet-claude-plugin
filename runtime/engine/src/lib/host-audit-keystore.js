'use strict';

// Host audit's two generated records only, kept as private files in the state
// folder. This never holds a provider credential and never uses the login
// keyring. Private files remain readable by same-user processes and do not
// provide tamper-proof custody against those processes.
const crypto = require('node:crypto');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SIGNING_KEY = 'toolsenabled_audit_signing_key_v1';
const HEAD_KEY = 'toolsenabled_audit_head_v1';
const HELPER = path.join(__dirname, 'host-audit-keystore.py');
const MESSAGES = Object.freeze({
  SECRET_ACCESS_DENIED: 'Only Fleet host audit signing and head records use this store.',
  SECRET_NOT_CONFIGURED: 'The requested host audit record is not configured.',
  SECRET_INPUT_INVALID: 'The host audit storage request is invalid.',
  SECRET_STORE_UNREADABLE: 'The private host audit record is unreadable or invalid; existing state was retained.',
  SECRET_STORE_PATH_UNSAFE: 'Host audit storage requires owned private directories and files without links or unsupported access metadata.',
  SECRET_STORE_LOCK_TIMEOUT: 'The private host audit store is busy; its kernel lock could not be acquired.',
  SECRET_STORE_WRITE_FAILED: 'The private host audit record could not be stored durably.',
  SECRET_MONOTONIC_CONFLICT: 'The host audit head cannot move backward or change at the same sequence.',
  SECRET_HELPER_UNAVAILABLE: 'Private host audit storage requires the installed helper and system Python 3.',
  SECRET_BACKEND_RETIRED: 'An earlier Fleet version kept this state folder\'s audit key in the login keyring, which this version does not read. Fleet archives that history and starts a new key the next time audit is used.'
});
function failure(code) {
  const known = Object.hasOwn(MESSAGES, code) ? code : 'SECRET_STORE_UNREADABLE';
  return Object.assign(new Error(MESSAGES[known]), { code: known });
}
function enabled(env = process.env) {
  return process.platform === 'linux' && env.TOOLSENABLED_RUNTIME_MODE === 'host' && env.OPENSHELL_SANDBOX !== '1';
}

function createHostAuditKeyStore({ env = process.env } = {}) {
  if (!enabled(env)) throw failure('SECRET_ACCESS_DENIED');
  const root = env.TOOLSENABLED_STATE_ROOT;
  if (typeof root !== 'string' || !path.isAbsolute(root) || root === '/' || path.normalize(root) !== root) throw failure('SECRET_STORE_PATH_UNSAFE');
  let selected = null, unavailable = false;

  function helper(request) {
    const result = spawnSync('/usr/bin/python3', ['-I', '-S', '-B', HELPER, root], {
      input: JSON.stringify(request), encoding: 'utf8', timeout: 5000, maxBuffer: 65536,
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'ignore']
    });
    if (result.error || result.signal || result.status !== 0) throw failure('SECRET_HELPER_UNAVAILABLE');
    let response;
    try { response = JSON.parse(result.stdout); } catch { throw failure('SECRET_STORE_UNREADABLE'); }
    if (!response || response.ok !== true) throw failure(response?.code);
    return response.value;
  }
  function checkKey(key) {
    if (![SIGNING_KEY, HEAD_KEY].includes(key)) throw failure('SECRET_ACCESS_DENIED');
  }
  // A state folder an earlier version bound to the login keyring is never read
  // here. Ordinary reads and writes refuse it until the caller has archived
  // that history through the retirement operations below.
  function loadSelection() {
    if (!selected) selected = helper({ operation: 'peek' });
    if (selected !== null && selected !== 'private-file') throw failure('SECRET_BACKEND_RETIRED');
    return selected;
  }
  function getSecret(key) {
    checkKey(key);
    loadSelection();
    const value = helper({ operation: 'get', key });
    if (key === SIGNING_KEY) {
      try {
        if (crypto.createPrivateKey(value).asymmetricKeyType !== 'ed25519') throw new Error();
      } catch { throw failure('SECRET_STORE_UNREADABLE'); }
    }
    return value;
  }
  function getOrCreateSecret(key, value) {
    checkKey(key);
    if (key !== SIGNING_KEY) throw failure('SECRET_ACCESS_DENIED');
    if (!loadSelection()) selected = helper({ operation: 'select', kind: 'private-file' });
    if (selected !== 'private-file') throw failure('SECRET_BACKEND_RETIRED');
    return helper({ operation: 'getOrCreate', key, value });
  }
  function setMonotonicSecret(key, value, sequence) {
    checkKey(key);
    if (key !== HEAD_KEY || !loadSelection()) throw failure('SECRET_ACCESS_DENIED');
    return helper({ operation: 'setMonotonic', key, value, sequence });
  }
  function guard(operation) {
    return (...args) => {
      try { const value = operation(...args); unavailable = false; return value; }
      catch (error) {
        unavailable = !['SECRET_NOT_CONFIGURED', 'SECRET_MONOTONIC_CONFLICT', 'SECRET_ACCESS_DENIED'].includes(error?.code);
        throw error;
      }
    };
  }
  // Moving a keyring-bound state folder to private files, without reading the
  // keyring. pending() says whether the move is still owed; stage(pem) parks
  // the new signing key beside the retired selection, or returns one parked by
  // an earlier attempt, and returns null once another process has finished;
  // complete(head, sequence) stores the new ledger's head and switches the
  // selection to private files.
  function retirementPending() {
    if (!selected) selected = helper({ operation: 'peek' });
    return selected === 'os-keyring';
  }
  function stageRetirementKey(value) {
    const staged = helper({ operation: 'stage', key: SIGNING_KEY, value });
    if (staged !== null) {
      try {
        if (crypto.createPrivateKey(staged).asymmetricKeyType !== 'ed25519') throw new Error();
      } catch { throw failure('SECRET_STORE_UNREADABLE'); }
    }
    return staged;
  }
  function completeRetirement(value, sequence) {
    helper({ operation: 'retire', key: HEAD_KEY, value, sequence });
    selected = 'private-file';
  }
  function status() {
    if (unavailable) return { kind: 'unavailable' };
    return selected === 'private-file' ? { kind: 'private-file', sameUserReadable: true, boundary: false } : { kind: 'unselected' };
  }
  return Object.freeze({ getSecret: guard(getSecret), getOrCreateSecret: guard(getOrCreateSecret),
    setMonotonicSecret: guard(setMonotonicSecret), status,
    retirement: Object.freeze({ pending: guard(retirementPending), stage: guard(stageRetirementKey), complete: guard(completeRetirement) }) });
}

module.exports = { createHostAuditKeyStore, enabled };
