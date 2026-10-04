'use strict';

// Policy authoritative dispatch adapter. It is deliberately not an MCP tool.
// Registry dispatch consumes a durable authorization exactly once. Raw policy
// facts are never accepted at dispatch time. Fleet has no controller that
// prepares one, so with policy enforcement on, a consequential call without a
// prepared authorization is refused.

const { getStateStore, hashInput } = require('./state-store');
const scopedApprovals = require('./fleet-approval-dispatch');

function error(code, message, details = {}) {
  const value = new Error(message);
  value.name = 'PolicyAuthorizationError';
  value.code = code;
  value.details = details;
  return value;
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exact(value, keys, label) {
  if (!plainObject(value)) throw error('POLICY_AUTHORIZATION_INVALID', `${label} must be a plain object.`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw error('POLICY_AUTHORIZATION_INVALID', `${label} has unsupported or missing fields.`);
  }
  return value;
}

function stateFor(dependencies = {}) { return dependencies.state || getStateStore(); }

function consume(input, dependencies = {}) {
  const keys = plainObject(input) && Object.hasOwn(input, 'approvalEvidence')
    ? ['authorizationId', 'toolName', 'arguments', 'approvalEvidence']
    : ['authorizationId', 'toolName', 'arguments'];
  exact(input, keys, 'Policy dispatch consumption');
  const { authorizationId, toolName, arguments: argumentsValue, approvalEvidence = null } = input;
  if (approvalEvidence !== null) exact(approvalEvidence, ['approvalId'], 'Policy approval evidence');
  return stateFor(dependencies).consumePolicyDispatchAuthorization({
    authorizationId,
    toolName,
    argsHash: hashInput(argumentsValue),
    approvalId: approvalEvidence === null ? null : approvalEvidence.approvalId,
    approvalInputHash: approvalEvidence === null ? null : hashInput({ action: toolName, arguments: argumentsValue })
  });
}

function consumeScoped(input, dependencies = {}) {
  // Scoped approval intentionally accepts only the opaque UI response token.  It never
  // accepts an approval ID, a claimed status, a caller hash, raw provenance,
  // or a constructed preview as dispatch authority.
  exact(input, ['authorizationId', 'toolName', 'arguments', 'approvalToken'], 'scoped approval dispatch');
  const { authorizationId, toolName, arguments: argumentsValue, approvalToken } = input;
  return scopedApprovals.consumeForDispatch({ authorizationId, toolName, arguments: argumentsValue, approvalToken });
}

module.exports = Object.freeze({ consume, consumeScoped });
