'use strict';

// legacy policy semantic audit adapter.  This module deliberately owns no database,
// signing key, projection, or recovery file: src/lib/audit.js remains the
// only canonical signed ledger authority.

const audit = require('./audit');
const operationAudit = require('./operation-audit');
const { canonicalHash } = require('../../schemas/generated/platform.identity');
const redaction = require('../../schemas/generated/platform.redaction');

const SCHEMA_VERSION = 1;
const HASH = /^[a-f0-9]{64}$/;
const SAFE_CODE = /^[a-z][a-z0-9._-]{0,79}$/;
const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,239}$/;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const CANARY = /(?:TOOLSENABLED_CANARY_|OWNER_PRIVATE_FIXTURE|CUSTOM_FIELD_FIXTURE|FAKEPROVIDERTOKEN|FAKEHEADER|FAKEPAYLOAD|FAKESIGNATURE)/i;

const EVENT_KINDS = Object.freeze([
  'policy.decision',
  'approval.decision',
  'task.transition',
  'memory.mutation'
]);

const SUBJECT_TYPES = Object.freeze(['policy', 'approval', 'task', 'memory']);

const SUMMARY_FIELDS = new Set([
  'operation', 'code', 'state', 'toState', 'effect',
  'fence', 'revision', 'attempt', 'expiresAtMs', 'replayed'
]);

const HASH_FIELDS = new Set(['policyDecision', 'capabilityProfile', 'request', 'memoryValue']);

class CoordinatorAuditEventError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CoordinatorAuditEventError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new CoordinatorAuditEventError(code, message, details);
}

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail('COORDINATOR_AUDIT_EVENT_INVALID', `${label} must be a plain object.`, { field: label });
  }
  return value;
}

function exactKeys(value, allowed, label, { required = [] } = {}) {
  plainObject(value, label);
  const keys = Object.keys(value);
  const unexpected = keys.filter(key => !allowed.includes(key));
  const missing = required.filter(key => !Object.hasOwn(value, key));
  if (unexpected.length || missing.length) {
    fail('COORDINATOR_AUDIT_EVENT_INVALID', `${label} has unsupported or missing fields.`, {
      field: label, unexpected, missing
    });
  }
  return value;
}

function integer(value, label, maximum = MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    fail('COORDINATOR_AUDIT_EVENT_INVALID', `${label} must be a bounded non-negative integer.`, { field: label });
  }
  return value;
}

function booleanValue(value, label) {
  if (typeof value !== 'boolean') {
    fail('COORDINATOR_AUDIT_EVENT_INVALID', `${label} must be boolean.`, { field: label });
  }
  return value;
}

function noSensitiveMaterial(value, label) {
  if (CANARY.test(value)) {
    fail('COORDINATOR_AUDIT_EVENT_SENSITIVE', `${label} contains a test or sensitive-material canary.`, { field: label });
  }
  const scrubbed = audit.scrub({ value });
  if (!scrubbed || scrubbed.value !== value) {
    fail('COORDINATOR_AUDIT_EVENT_SENSITIVE', `${label} resembles credential material.`, { field: label });
  }
  let prepared;
  try { prepared = redaction.prepareEgress('log', { value }); }
  catch (error) {
    fail('COORDINATOR_AUDIT_EVENT_INVALID', `${label} is not safe audit metadata.`, { field: label });
  }
  if (prepared.redactionReport.changed || prepared.redactionReport.canaryDetected) {
    fail('COORDINATOR_AUDIT_EVENT_SENSITIVE', `${label} must be opaque, value-free audit metadata.`, { field: label });
  }
}

function code(value, label) {
  if (typeof value !== 'string' || !SAFE_CODE.test(value)) {
    fail('COORDINATOR_AUDIT_EVENT_INVALID', `${label} must be a lowercase machine code.`, { field: label });
  }
  noSensitiveMaterial(value, label);
  return value;
}

function reference(value, label) {
  if (typeof value !== 'string' || !SAFE_REFERENCE.test(value)) {
    fail('COORDINATOR_AUDIT_EVENT_INVALID', `${label} must be a bounded opaque identifier.`, { field: label });
  }
  noSensitiveMaterial(value, label);
  return value;
}

function digest(value, label) {
  if (typeof value !== 'string' || !HASH.test(value)) {
    fail('COORDINATOR_AUDIT_EVENT_INVALID', `${label} must be a SHA-256 digest.`, { field: label });
  }
  return value;
}

function cloneSummary(input) {
  exactKeys(input, [...SUMMARY_FIELDS], 'summary', { required: ['operation', 'code'] });
  const output = { operation: code(input.operation, 'summary.operation'), code: code(input.code, 'summary.code') };
  for (const key of ['state', 'toState', 'effect']) {
    if (input[key] !== undefined) output[key] = code(input[key], `summary.${key}`);
  }
  for (const key of ['fence', 'revision', 'attempt', 'expiresAtMs']) {
    if (input[key] !== undefined) output[key] = integer(input[key], `summary.${key}`);
  }
  if (input.replayed !== undefined) {
    if (typeof input.replayed !== 'boolean') fail('COORDINATOR_AUDIT_EVENT_INVALID', 'summary.replayed must be boolean.', { field: 'summary.replayed' });
    output.replayed = input.replayed;
  }
  return output;
}

function cloneHashes(input = {}) {
  exactKeys(input, [...HASH_FIELDS], 'hashes');
  const output = {};
  for (const key of Object.keys(input).sort()) output[key] = digest(input[key], `hashes.${key}`);
  return output;
}

function cloneEvidence(input = []) {
  if (!Array.isArray(input) || input.length > 16) {
    fail('COORDINATOR_AUDIT_EVENT_INVALID', 'evidence must contain at most sixteen opaque references.', { field: 'evidence' });
  }
  const output = input.map((item, index) => {
    exactKeys(item, ['referenceId', 'contentHash'], `evidence[${index}]`, { required: ['referenceId', 'contentHash'] });
    return {
      referenceId: digest(item.referenceId, `evidence[${index}].referenceId`),
      contentHash: digest(item.contentHash, `evidence[${index}].contentHash`)
    };
  }).sort((left, right) => {
    const leftKey = `${left.referenceId}\u0000${left.contentHash}`;
    const rightKey = `${right.referenceId}\u0000${right.contentHash}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  if (new Set(output.map(item => `${item.referenceId}\u0000${item.contentHash}`)).size !== output.length) {
    fail('COORDINATOR_AUDIT_EVENT_INVALID', 'evidence references must be unique.', { field: 'evidence' });
  }
  return output;
}

function opaqueReference(subjectType, value) {
  if (!SUBJECT_TYPES.includes(subjectType)) {
    fail('COORDINATOR_AUDIT_EVENT_INVALID', 'subjectType is unsupported.', { field: 'subjectType' });
  }
  return canonicalHash('coordinator.audit.subject.v1', {
    schemaVersion: SCHEMA_VERSION,
    subjectType,
    reference: reference(value, 'subjectReference')
  });
}

function validateEvent(input) {
  exactKeys(input, ['schemaVersion', 'kind', 'subject', 'outcome', 'summary', 'hashes', 'evidence', 'occurredAtMs'], 'event', {
    required: ['schemaVersion', 'kind', 'subject', 'outcome', 'summary', 'hashes', 'evidence', 'occurredAtMs']
  });
  if (input.schemaVersion !== SCHEMA_VERSION) {
    fail('COORDINATOR_AUDIT_EVENT_INVALID', `event.schemaVersion must be ${SCHEMA_VERSION}.`, { field: 'schemaVersion' });
  }
  if (typeof input.kind !== 'string' || !EVENT_KINDS.includes(input.kind)) {
    fail('COORDINATOR_AUDIT_EVENT_INVALID', 'event.kind is unsupported.', { field: 'kind' });
  }
  exactKeys(input.subject, ['type', 'opaqueId'], 'subject', { required: ['type', 'opaqueId'] });
  if (typeof input.subject.type !== 'string' || !SUBJECT_TYPES.includes(input.subject.type)) {
    fail('COORDINATOR_AUDIT_EVENT_INVALID', 'subject.type is unsupported.', { field: 'subject.type' });
  }
  const normalized = {
    schemaVersion: SCHEMA_VERSION,
    kind: input.kind,
    subject: { type: input.subject.type, opaqueId: digest(input.subject.opaqueId, 'subject.opaqueId') },
    outcome: code(input.outcome, 'outcome'),
    summary: cloneSummary(input.summary),
    hashes: cloneHashes(input.hashes),
    evidence: cloneEvidence(input.evidence),
    occurredAtMs: integer(input.occurredAtMs, 'occurredAtMs')
  };
  return Object.freeze({
    ...normalized,
    subject: Object.freeze(normalized.subject),
    summary: Object.freeze(normalized.summary),
    hashes: Object.freeze(normalized.hashes),
    evidence: Object.freeze(normalized.evidence.map(item => Object.freeze(item)))
  });
}

function createEvent(input = {}, dependencies = {}) {
  exactKeys(input, ['kind', 'subjectType', 'subjectReference', 'outcome', 'summary', 'hashes', 'occurredAtMs'], 'event input', {
    required: ['kind', 'subjectType', 'subjectReference', 'outcome', 'summary']
  });
  const now = input.occurredAtMs === undefined ? (dependencies.clock || Date.now)() : input.occurredAtMs;
  return validateEvent({
    schemaVersion: SCHEMA_VERSION,
    kind: input.kind,
    subject: { type: input.subjectType, opaqueId: opaqueReference(input.subjectType, input.subjectReference) },
    outcome: input.outcome,
    summary: input.summary,
    hashes: input.hashes || {},
    evidence: [],
    occurredAtMs: now
  });
}

function eventId(event) {
  const digestValue = canonicalHash('coordinator.audit.event-id.v1', event);
  return `coordinator-audit-${digestValue}`;
}

function eventDetails(event) {
  return {
    schemaVersion: event.schemaVersion,
    kind: event.kind,
    subject: event.subject,
    outcome: event.outcome,
    summary: event.summary,
    hashes: event.hashes,
    evidence: event.evidence
  };
}

function safeWriterStatus(value) {
  if (!value || typeof value !== 'object') return value;
  const boundedInteger = candidate => Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : null;
  const errors = Array.isArray(value.errors) ? value.errors.slice(0, 8).map(item => ({
    sink: item && typeof item.sink === 'string' && SAFE_CODE.test(item.sink) ? item.sink : 'canonical',
    // Never return a provider, filesystem, or input-derived error through the
    // semantic adapter.  Canonical audit diagnostics retain their own bounded
    // recovery path; callers need only know that this write failed.
    message: 'Audit write failed.'
  })) : [];
  return {
    ok: value.ok === true,
    durable: value.durable === true,
    projected: value.projected === true,
    recorded: value.recorded === true,
    partial: value.partial === true,
    anchored: value.anchored === true,
    protectedSequence: boundedInteger(value.protectedSequence),
    disabled: value.disabled === true,
    eventId: typeof value.eventId === 'string' && /^coordinator-audit-[a-f0-9]{64}$/.test(value.eventId) ? value.eventId : null,
    sequence: boundedInteger(value.sequence),
    eventHash: typeof value.eventHash === 'string' && HASH.test(value.eventHash) ? value.eventHash : null,
    sinks: Object.freeze({
      jsonl: Boolean(value.sinks && value.sinks.jsonl),
      text: Boolean(value.sinks && value.sinks.text)
    }),
    pending: boundedInteger(value.pending),
    errors: Object.freeze(errors)
  };
}

function write(input, dependencies = {}) {
  const event = validateEvent(input);
  if (!operationAudit.configured(dependencies)) return operationAudit.skippedStatus(`coordinator.audit.${event.kind}`, event.subject.opaqueId);
  const required = dependencies.required !== false;
  const auditRecord = dependencies.auditRecord || (required ? audit.requireRecord : audit.record);
  if (typeof auditRecord !== 'function') {
    fail('COORDINATOR_AUDIT_EVENT_INVALID', 'auditRecord must be a function.', { field: 'auditRecord' });
  }
  const auditDependencies = {
    ...(dependencies.auditDependencies || {}),
    eventIdFactory: () => eventId(event),
    clock: () => event.occurredAtMs
  };
  try {
    return safeWriterStatus(auditRecord(`coordinator.audit.${event.kind}`, event.subject.opaqueId, eventDetails(event), auditDependencies));
  } catch (error) {
    // Do not carry a raw provider/error string from a downstream audit adapter
    // into a control response.  The caller still gets a fail-closed condition.
    throw new CoordinatorAuditEventError('COORDINATOR_AUDIT_UNAVAILABLE', 'The canonical audit event could not be recorded.');
  }
}

/* THE SAME EVENT, ADMITTED OFF THE CALLER'S THREAD.
 *
 * write() runs the whole synchronous admission on the caller's thread
 * (writer-lock spin, projection digests, redaction and the anchor write for a
 * required event), and it runs for the policy decision of every tool call --
 * dozens a minute with many busy agents. This submits the identical event to
 * the group-commit queue (src/lib/audit-admission.js), which admits it on the
 * worker thread; the event id and time are the ones write() would have used,
 * and a required event is held to the same three refusals
 * (audit.requireDurableStatus). Resolves to the same status shape.
 */
async function writeAsync(input, dependencies = {}) {
  const event = validateEvent(input);
  if (!operationAudit.configured(dependencies)) return operationAudit.skippedStatus(`coordinator.audit.${event.kind}`, event.subject.opaqueId);
  const required = dependencies.required !== false;
  const queue = dependencies.admissionQueue || require('./audit-admission').defaultAdmissionQueue();
  let status;
  try {
    status = await queue.submit({
      action: `coordinator.audit.${event.kind}`,
      target: event.subject.opaqueId,
      details: eventDetails(event),
      anchorRequired: required,
      eventId: eventId(event),
      occurredAtMs: event.occurredAtMs
    });
    if (required) audit.requireDurableStatus(status);
  } catch (error) {
    if (error instanceof audit.AuditRequiredError) throw error;
    throw new CoordinatorAuditEventError('COORDINATOR_AUDIT_UNAVAILABLE', 'The canonical audit event could not be recorded.');
  }
  return safeWriterStatus(status);
}

function capabilityProfileHash(capabilities) {
  if (!Array.isArray(capabilities) || capabilities.length > 500) {
    fail('COORDINATOR_AUDIT_EVENT_INVALID', 'capabilities must be a bounded array.', { field: 'capabilities' });
  }
  const normalized = capabilities.map((item, index) => {
    exactKeys(item, ['name', 'effect', 'approvalEligible'], `capabilities[${index}]`, { required: ['name', 'effect', 'approvalEligible'] });
    if (typeof item.approvalEligible !== 'boolean') {
      fail('COORDINATOR_AUDIT_EVENT_INVALID', 'capability approvalEligible must be boolean.', { field: `capabilities[${index}].approvalEligible` });
    }
    return {
      name: reference(item.name, `capabilities[${index}].name`),
      effect: code(item.effect, `capabilities[${index}].effect`),
      approvalEligible: item.approvalEligible
    };
  }).sort((left, right) => left.name.localeCompare(right.name, 'en'));
  if (new Set(normalized.map(item => item.name)).size !== normalized.length) {
    fail('COORDINATOR_AUDIT_EVENT_INVALID', 'capability names must be unique.', { field: 'capabilities' });
  }
  return canonicalHash('coordinator.audit.capability-profile.v1', { schemaVersion: SCHEMA_VERSION, capabilities: normalized });
}

function policyDecision({ action, effect, approvalRequired, standingAuthorizationId, profileHash, outcome, occurredAtMs } = {}, dependencies = {}) {
  const standing = standingAuthorizationId === undefined || standingAuthorizationId === null
    ? null : reference(standingAuthorizationId, 'standingAuthorizationId');
  const selectedOutcome = outcome === undefined
    ? (standing ? 'standing-authorized' : approvalRequired ? 'approval-required' : 'allowed')
    : code(outcome, 'outcome');
  return createEvent({
    kind: 'policy.decision', subjectType: 'policy', subjectReference: action,
    outcome: selectedOutcome,
    summary: { operation: 'invoke', code: 'policy-evaluated', effect: code(effect, 'effect') },
    hashes: {
      policyDecision: canonicalHash('coordinator.audit.policy-decision.v1', {
        action: reference(action, 'action'), effect: code(effect, 'effect'),
        approvalRequired: approvalRequired === true, standingAuthorizationId: standing
      }),
      capabilityProfile: digest(profileHash, 'profileHash')
    },
    occurredAtMs
  }, dependencies);
}

function approvalDecision({ action, approvalId, outcome, operation = 'request', expiresAtMs, profileHash, occurredAtMs } = {}, dependencies = {}) {
  const summary = { operation: code(operation, 'operation'), code: 'approval-decision' };
  if (expiresAtMs !== undefined && expiresAtMs !== null) summary.expiresAtMs = integer(expiresAtMs, 'expiresAtMs');
  const hashes = {
    request: canonicalHash('coordinator.audit.approval-decision.v1', {
      action: reference(action, 'action'), approvalId: reference(approvalId, 'approvalId'), outcome: code(outcome, 'outcome'), operation: summary.operation
    })
  };
  if (profileHash !== undefined) hashes.capabilityProfile = digest(profileHash, 'profileHash');
  return createEvent({
    kind: 'approval.decision', subjectType: 'approval', subjectReference: approvalId,
    outcome, summary, hashes, occurredAtMs
  }, dependencies);
}

function taskTransition({ taskId, operation, status, attempt, fence, revision, replayed, occurredAtMs } = {}, dependencies = {}) {
  const summary = { operation: code(operation, 'operation'), code: 'task-transition', toState: code(status, 'status') };
  if (attempt !== undefined) summary.attempt = integer(attempt, 'attempt');
  if (fence !== undefined) summary.fence = integer(fence, 'fence');
  if (revision !== undefined) summary.revision = integer(revision, 'revision');
  if (replayed !== undefined) summary.replayed = booleanValue(replayed, 'replayed');
  return createEvent({
    kind: 'task.transition', subjectType: 'task', subjectReference: taskId,
    outcome: code(status, 'status'), summary, occurredAtMs
  }, dependencies);
}

function memoryMutation({ namespace, key, valueHash, revision, created, replayed, occurredAtMs } = {}, dependencies = {}) {
  const state = booleanValue(created, 'created') ? 'created' : 'updated';
  const summary = { operation: 'set', code: 'memory-mutation', state, revision: integer(revision, 'revision') };
  if (replayed !== undefined) summary.replayed = booleanValue(replayed, 'replayed');
  return createEvent({
    kind: 'memory.mutation', subjectType: 'memory', subjectReference: `${reference(namespace, 'namespace')}:${reference(key, 'key')}`,
    outcome: state, summary, hashes: { memoryValue: digest(valueHash, 'valueHash') }, occurredAtMs
  }, dependencies);
}

module.exports = Object.freeze({
  EVENT_KINDS, HASH_FIELDS: Object.freeze([...HASH_FIELDS]), CoordinatorAuditEventError,
  SCHEMA_VERSION, SUBJECT_TYPES, approvalDecision,
  capabilityProfileHash, createEvent, eventDetails, eventId, memoryMutation,
  opaqueReference, policyDecision, safeWriterStatus, taskTransition, validateEvent, write, writeAsync
});
