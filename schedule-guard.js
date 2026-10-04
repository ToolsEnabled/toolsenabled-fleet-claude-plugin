#!/usr/bin/env node
'use strict';
// Fleet's guard on the tools that carry a prompt to run later or in another
// session: CronCreate, CronUpdate, ScheduleWakeup, RemoteTrigger and
// SendMessage (hooks.json names them; no other tool call starts this script).
// When such a prompt arrives, Claude Code's prompt hooks cannot tell it from
// one the person typed, so a /tefleet command in it could pass for the person's
// own. Fleet refuses any such call whose input carries a /tefleet command, in
// any spelling Claude Code could turn back into one. Every other call passes
// untouched, and nothing is kept. Node.js built-ins only, so the check is quick.
const MAX_INPUT = 8 * 1024 * 1024;
const MAX_DEPTH = 64;
// "/tefleet" and "/toolsenabled-fleet:tefleet", after cleaning.
const MARK = /[/:]tefleet/;
const REASON = 'Fleet refused this: a scheduled, delayed or forwarded prompt may not carry a /tefleet command. '
  + 'Only the person types /tefleet commands, at Claude Code\'s prompt. Leave the /tefleet command out, '
  + 'or ask the person to type it themselves.';
const UNREADABLE = 'Fleet refused this: it could not read the tool call to check it for a /tefleet command.';

// Text as Claude Code could read it back: compatibility forms folded (a
// full-width slash becomes "/"), and control, format and zero-width characters,
// line and paragraph separators and combining marks removed.
function clean(text) {
  return String(text).normalize('NFKC').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{M}]/gu, '').toLowerCase();
}
// Whether any key or string in the tool input carries a /tefleet command.
function carriesCommand(value, depth = 0) {
  if (typeof value === 'string') return MARK.test(clean(value));
  if (depth > MAX_DEPTH) return true;
  if (Array.isArray(value)) return value.some(item => carriesCommand(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([key, item]) => MARK.test(clean(key)) || carriesCommand(item, depth + 1));
  }
  return false;
}
function deny(reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }) + '\n');
}
// The decision for one PreToolUse payload: a reason to deny, or null to stay silent.
function decide(input) {
  let event;
  try { event = JSON.parse(input); } catch { return UNREADABLE; }
  if (!event || typeof event !== 'object') return UNREADABLE;
  return carriesCommand(event.tool_input) ? REASON : null;
}

if (require.main === module) {
  let input = '';
  let tooLarge = false;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    if (tooLarge) return;
    input += chunk;
    if (input.length > MAX_INPUT) { tooLarge = true; input = ''; }
  });
  process.stdin.on('end', () => {
    const reason = tooLarge ? UNREADABLE : decide(input);
    if (reason) deny(reason);
  });
}
module.exports = { decide, carriesCommand, clean, REASON };
