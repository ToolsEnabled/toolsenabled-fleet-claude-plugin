'use strict';

// MAY AN AGENT FILE ONE OF THE PERSON'S STANDING RULES? No. Standing rules
// come only from the person, who adds them by typing /tefleet ledger rule;
// Fleet files those words itself, never through an agent. r_ledger.file stays
// offered so an agent that tries is told plainly where rules come from, and
// the attempt is audited like every other ledger write.
//
// The task and ask handlers (src/lib/minor-ledger-agent-gate.js) share this
// module's judgement of secret-shaped words.

// Said to the AGENT, never to a person.
const REFUSAL_WHEN_OFF = 'Agents may not file standing rules: only the person adds them. Nothing was filed. '
  + 'If the person asked you to record a rule, tell them to type /tefleet ledger rule followed by the rule; it is filed under their name without going through you. '
  + 'Do not suggest rules otherwise. Carry on with the work.';

/* "Looks like a secret" is the audit module's scrubber's call first: if
   scrubbing the words would change them, they carry something shaped like a
   password, key or token, and they are not filed. The scrubber is injectable
   for the tests; the default is audit's, loaded lazily so a reader of this
   module does not pay for it. Two narrow shapes the scrubber lets through are
   added here and nowhere else: a bare "token:" / "secret:" style prefix with a
   value after it (the scrubber wants a word before "token"), and one unbroken
   run of forty or more letters-and-digits, which is a key's shape and not a
   sentence's. */
const BARE_SECRET_PREFIX = /\b(?:token|secret|password|passwd|pwd|passphrase|otp)\s*[=:]\s*\S+/i;
const LONG_TOKEN_RUN = /(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{40,}/;
function looksSecretShaped(words, { scrub } = {}) {
  // The scrubber normalizes lone UTF-16 surrogates (audit projections are
  // UTF-8). Normalize first so only a real secret shape changes the words.
  const text = String(words === undefined || words === null ? '' : words).toWellFormed();
  if (!text) return false;
  const cleaner = typeof scrub === 'function' ? scrub : value => require('./audit').scrubText(value, Math.max(1, value.length));
  return cleaner(text) !== text || BARE_SECRET_PREFIX.test(text) || LONG_TOKEN_RUN.test(text);
}

function ledgerError(code, message) {
  const { OwnerRequestStoreError } = require('./owner-request-store');
  return new OwnerRequestStoreError(code, message);
}

// THE AUTHORITY DOOR: what r_ledger.file runs. Audit intent first (refuse
// unless durably recorded when audit is on), then the refusal. Dependencies
// are injectable so the tests prove the door without a live audit ledger.
class RLedgerAgentControl {
  constructor(dependencies = {}) {
    this.auditRequire = dependencies.auditRequire || ((...args) => require('./audit').requireRecord(...args));
    this.auditEnabled = dependencies.auditEnabled || (() => require('./operation-audit').configured({ loadSettings: dependencies.loadSettings }));
  }

  _audit(action, target, details) {
    if (!this.auditEnabled()) return require('./operation-audit').skippedStatus(action, target);
    const intent = this.auditRequire(action, target, details);
    if (!intent || intent.durable !== true) {
      throw ledgerError('R_LEDGER_AUDIT_REQUIRED', 'The standing rule was not filed because its audit intent was not durably recorded.');
    }
    return intent;
  }

  /** r_ledger.file: always refused. Bounded tokens only in the audit row: the
   *  scope word, whether a key was named and the actor -- never the words
   *  themselves and never the key. */
  file(args) {
    this._audit('r_ledger.file', `r-ledger:${args.scope}`, { actor: args.actor, scope: args.scope, keyed: args.scope !== 'global' });
    throw ledgerError('R_LEDGER_AGENT_FILING_OFF', REFUSAL_WHEN_OFF);
  }
}

module.exports = Object.freeze({
  RLedgerAgentControl,
  REFUSAL_WHEN_OFF,
  looksSecretShaped
});
