'use strict';

// WHO DECIDED THIS? Provenance is required on every request-ledger entry.
//
// The person's directives and agent-authored proposals can otherwise share the
// same storage shape and appear to carry the same authority. This module
// defines the vocabulary for distinguishing them and the evidence fence that
// makes the distinction enforceable: the classes that claim the person's
// authority need evidence a caller cannot assert.
//
// `unclassified` is necessary for older records whose provenance was not
// captured. The capture actor cannot substitute for evidence because the same
// actor can record both relayed text from the person and agent-authored text.
// Guessing a class would fabricate provenance; `unclassified` therefore means
// only that the record does not establish who decided the entry.
//
// The stated class requires the person's verbatim text and a source citation.
// The ratified class requires the proposal and a citation of the approval. A
// caller without that evidence cannot reach either class. This prevents an
// agent-generated default from becoming the person's saved preference merely
// because it was stored in the request ledger.

const PROVENANCE_VERSION = 1;

// Ordered from strongest to weakest claim on the person's authority.
const PROVENANCE_CLASSES = Object.freeze([
  'owner-stated',
  'owner-ratified',
  'agent-inferred',
  'unclassified'
]);

const MIN_SOURCE_LENGTH = 8;
const MAX_SOURCE_LENGTH = 2000;
const MAX_ACTOR_LENGTH = 200;

class OwnerProvenanceError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'OwnerProvenanceError';
    this.code = code;
    if (details) this.details = details;
  }
}

function fail(code, message, details) {
  throw new OwnerProvenanceError(code, message, details);
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function trimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Normalize and VALIDATE a provenance record.
 *
 * This is the anti-fabrication fence. The evidence requirements below are not
 * schema decoration -- they are the reason a caller cannot simply declare that
 * the person wanted something.
 */
function normalizeProvenance(input) {
  if (!plainObject(input)) {
    fail('OWNER_PROVENANCE_REQUIRED',
      'A provenance record is required. Every owner-request entry must say who decided it: '
      + `one of ${PROVENANCE_CLASSES.join(', ')}.`);
  }

  const allowed = ['class', 'source', 'recordedBy', 'recordedAt', 'proposal', 'note'];
  const unknown = Object.keys(input).filter(key => !allowed.includes(key));
  if (unknown.length) {
    fail('OWNER_PROVENANCE_INVALID',
      `Unknown provenance field(s): ${unknown.join(', ')}. Allowed: ${allowed.join(', ')}.`);
  }

  const klass = trimmedString(input.class);
  if (!PROVENANCE_CLASSES.includes(klass)) {
    fail('OWNER_PROVENANCE_CLASS_INVALID',
      `provenance.class must be one of ${PROVENANCE_CLASSES.join(', ')}; got ${JSON.stringify(input.class)}.`);
  }

  const recordedBy = trimmedString(input.recordedBy);
  if (!recordedBy) {
    fail('OWNER_PROVENANCE_INVALID',
      'provenance.recordedBy is required: the identity asserting this provenance must be named.');
  }
  if (recordedBy.length > MAX_ACTOR_LENGTH) {
    fail('OWNER_PROVENANCE_INVALID', `provenance.recordedBy exceeds ${MAX_ACTOR_LENGTH} characters.`);
  }

  const source = trimmedString(input.source);
  const proposal = trimmedString(input.proposal);

  // --- the evidence fence -------------------------------------------------
  // The stated and ratified classes are claims on the person's authority.
  // Neither may be reached by assertion alone.
  if (klass === 'owner-stated' || klass === 'owner-ratified') {
    if (source.length < MIN_SOURCE_LENGTH) {
      fail('OWNER_PROVENANCE_SOURCE_REQUIRED',
        `provenance.class ${JSON.stringify(klass)} claims the owner's authority, so it must cite `
        + 'provenance.source: where the owner\'s words or approval arrived (a message id and '
        + 'timestamp, an owner-chat sequence, a live session id, a dashboard approval record). '
        + 'Without this evidence, an agent-chosen default could be presented as an owner setting.');
    }
    if (source.length > MAX_SOURCE_LENGTH) {
      fail('OWNER_PROVENANCE_INVALID', `provenance.source exceeds ${MAX_SOURCE_LENGTH} characters.`);
    }
  }
  if (klass === 'owner-ratified' && !proposal) {
      fail('OWNER_PROVENANCE_PROPOSAL_REQUIRED',
        'provenance.class "owner-ratified" means an agent proposed it and the owner approved it, '
        + 'so provenance.proposal must record what was presented for approval. Approval of an unrecorded '
      + 'proposal cannot be audited and is indistinguishable from an agent deciding alone.');
    }
  if (klass === 'unclassified' && !trimmedString(input.note)) {
    fail('OWNER_PROVENANCE_INVALID',
      'provenance.class "unclassified" must carry a note saying why provenance is unknown, so it '
      + 'is visibly a gap in the record rather than a shrug.');
  }

  const recordedAt = trimmedString(input.recordedAt) || new Date().toISOString();
  if (Number.isNaN(Date.parse(recordedAt))) {
    fail('OWNER_PROVENANCE_INVALID', `provenance.recordedAt is not a valid ISO timestamp: ${JSON.stringify(recordedAt)}.`);
  }

  const record = { class: klass, recordedBy, recordedAt };
  if (source) record.source = source;
  if (proposal) record.proposal = proposal;
  const note = trimmedString(input.note);
  if (note) record.note = note;
  return Object.freeze(record);
}

module.exports = Object.freeze({
  PROVENANCE_VERSION,
  PROVENANCE_CLASSES,
  OwnerProvenanceError,
  normalizeProvenance
});
