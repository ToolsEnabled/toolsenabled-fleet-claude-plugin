'use strict';

// How a finished turn is reported, in one set of words whichever agent CLI ran it. Each CLI words its own
// result differently (Claude Code's is "success" or an "error_..." subtype, others say "completed",
// "failed" or "interrupted"), and a person reading a report should not have to learn which word belongs to
// which CLI. Anything that is not clearly a completion or a stop is a failure, never a completion.
const COMPLETED = Object.freeze(new Set(['completed', 'success']));
const INTERRUPTED = Object.freeze(new Set(['interrupted', 'cancelled']));

function turnStatus(value) {
  const word = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (COMPLETED.has(word)) return 'completed';
  if (INTERRUPTED.has(word)) return 'interrupted';
  return 'failed';
}

module.exports = Object.freeze({ turnStatus });
