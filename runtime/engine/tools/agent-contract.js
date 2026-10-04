'use strict';

/* A CONTRACT IS A FORM, NOT AN ESSAY.
 *
 * WHY. A brief written as prose is long, retyped slightly differently every
 * time and read unreliably -- an agent skims prose and parses a grammar. Six
 * authored lines expand to the same brief every time, and a namespace-scoped
 * API sheet (the `api` field, rendered by tool-registry.js) lists everything
 * the agent can call in a few hundred tokens.
 *
 * THE SPLIT THAT MAKES IT WORK. The AUTHOR writes only what is specific to this
 * task. The DISPATCHER expands the working rules every brief carries, so the
 * form cannot omit them.
 *
 * THE GRAMMAR, all of it:
 *
 *     CONTRACT/1
 *     role      INVESTIGATOR            # one of ROLES
 *     target    src/lib/                # a real path or glob; first line of the brief
 *     do        <one line>              # the task
 *     because   <one line>              # the observed fact or the person's request behind it
 *     done      <one line>              # what finished means, checkable by someone else
 *     report    REPORT-thing.md         # where the answer goes
 *     api       repo,code               # optional: namespaces to hand over as a sheet
 *
 * REFUSED, NOT WARNED, because a malformed contract spends real quota to
 * produce a diff nobody can use:
 *   - an unknown role, or a missing required field;
 *   - a `because` that states no evidence -- the commonest way a contract
 *     sends an agent to fix something that is not broken;
 *   - a `done` that cannot be checked by anybody but the agent itself;
 *   - a file:line citation anywhere -- line numbers change with the file, so an
 *     agent sent to a line can find other code there.
 */

const ROLES = Object.freeze([
  'IMPLEMENTER', 'INVESTIGATOR', 'TESTER', 'VERIFIER',
  'HARVESTER', 'PLANNER', 'COORDINATOR', 'MANAGER', 'WORKER',
]);

// Shared by advertised tool schema and expanded child briefs. This explains
// input syntax, not permission to delegate or evidence about the current task.
const CONTRACT_GUIDE = [
  'To call agent.spawn, contract is a newline-separated input form, not this expanded brief.',
  'Begin with CONTRACT/1; required fields are role, target, do, because, done, report (key then space then value).',
  `role: ${ROLES.join('|')}. Optional field: api (comma-separated Fleet tool namespaces to list in the brief). It does not change what the subagent is permitted to do.`,
  'because needs concrete evidence. For a new task, quote the person\'s request or state its requested count; no filesystem precheck is required. For a repair, cite an observed number, failing check or quoted output; never invent a measurement.',
  'done must name an independently verifiable artifact/check, not subjective claims such as "works correctly". Cite symbols, not file:line.',
  'Illustrative syntax only: replace the example paths, task, evidence and completion checks with your actual task; this example is not observed evidence.',
  '```text',
  'CONTRACT/1',
  'role INVESTIGATOR',
  'target src/',
  'do Inspect the requested project area and write findings; do not edit source.',
  'because The user requested 1 inspection report for this project.',
  'done .fleet/reports/child.md names inspected symbols, findings and verification commands.',
  'report .fleet/reports/child.md',
  '```',
].join('\n');

const REQUIRED = Object.freeze(['role', 'target', 'do', 'because', 'done', 'report']);

/* Working rules expanded into every brief, so the author of a contract does not
 * have to repeat them. They are guidance; FORBIDDEN below lists what Fleet
 * itself refuses. */
const INVARIANTS = Object.freeze([
  'evidence   cite a path and a quoted symbol or string, not file:line; line numbers change between versions.',
  'absent     before calling something unused, search for it in two different ways; re-exports, constants and default parameters can hide callers.',
  'unknown    "could not check" and "not there" are different answers; say which one you have.',
  'rank       order findings by what a person would lose: safety, then irreversible or outside effects, then confidential data, then correctness, then workflow.',
  'checks     for any check you add, show it failing on the broken case and passing on the fixed one.',
  'caps       say when you looked at only part of something (a subset, a sample, the top N), so a partial count is not read as a total.',
  'tests      test behaviour by calling code with values, not the exact wording of an implementation; never weaken a test or a check to make something pass.',
  'refusals   when you skip or refuse something, say so and why.',
  'shared     other agents may be working in the same project: do not discard or overwrite changes you did not make.',
  'secrets    never copy a credential value into a report, diff, fixture or log; name the variable and where it would go instead.',
  'conflict   if this brief and the code disagree, the code is what runs: report the disagreement instead of changing the code to fit the brief.',
]);

/* What Fleet refuses a subagent whatever its brief says. Each line is enforced:
 * by the agent CLI's sandbox and Fleet's file tools (the project folder), by
 * r_ledger.file (standing rules), by the absence of any settings tool for
 * agents, by agent.spawn (depth and width), and by the headless launch, which
 * declines anything that would need a new permission. */
const FORBIDDEN = Object.freeze([
  'writing files outside the project folder',
  'adding standing rules: only the person adds them, with /tefleet ledger rule',
  'changing Fleet\'s settings: only the person changes them, with /tefleet settings',
  'starting subagents beyond the person\'s depth and width settings',
  'any action that needs a new permission: a subagent cannot ask the person, so it is declined',
]);

/* WHAT COUNTS AS A FIELD LINE, and what is the line before it continuing.
 *
 * The grammar above is `key value`: a lowercase word, whitespace, the rest.
 * That is still the form, and it is still what the examples show. But the
 * things that WRITE contracts are agents, and an agent may write `ROLE:
 * Worker`, `TITLE: ...`, `WORKDIR: ...` and then prose -- the shape of the
 * EXPANDED brief it was itself given, written back as input -- or reach for
 * `because2` after a first `because` was refused as repeated.
 *
 * So two forms are read, and neither is ambiguous:
 *   key value       the original -- a lowercase word then whitespace
 *   Key: value      any-case word then a colon -- the colon is the signal
 * and everything else is a CONTINUATION of the field above it rather than an
 * error, because a value worth writing is often worth two lines. A repeated
 * field continues too. The only remaining parse error is text before the
 * first field, which really is not part of any field.
 *
 * A capitalised word followed by a space is NOT a field. `Read the file` is
 * prose, and treating it as field `read` would silently eat the sentence. */
const FIELD_LINE = /^(?:([A-Za-z][A-Za-z0-9_-]{0,31}):\s*(.*)|([a-z]+)\s+(.*))$/;

/* A MECHANICAL FAULT THE READER CAN FIX IS NOT WORTH A ROUND TRIP.
 *
 * A missing header used to return here with `fields: {}`, so the caller was
 * told FIVE things -- "no CONTRACT/1 header; missing required field: role;
 * missing required field: target; missing required field: do; missing required
 * field: because" -- for ONE mistake, and none of the four were true: every
 * field was sitting right there, unread, because the parse stopped before it
 * looked.
 *
 * So the header's absence is now REPAIRED rather than reported, and only on
 * proof: the body is re-read as if the header were present, and the repair is
 * accepted ONLY when that reading yields every required field with no parse
 * error of its own. Prose cannot satisfy that -- it has no `role`, no `done`,
 * no `report` -- so the strictness of the condition is what makes the repair
 * safe rather than generous.
 *
 * NOTHING ELSE IS FORGIVEN. This restores the fields; validate() still judges
 * them, and every gate it applies -- the role table, the measurement in
 * `because`, the checkable `done`, the file:line rule -- runs exactly as
 * before on exactly the same text. A contract that is wrong is still refused,
 * and now it is refused for the reason it is actually wrong.
 *
 * The repair is reported on the result as `repaired` so the caller can see
 * what was assumed rather than having it happen invisibly. */
function parseBody(lines, from) {
  const fields = {};
  const errors = [];
  let current = null;
  for (const line of lines.slice(from)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = FIELD_LINE.exec(trimmed);
    if (!match) {
      if (current === null) { errors.push(`not a field line: ${trimmed.slice(0, 60)}`); continue; }
      fields[current] = `${fields[current]} ${trimmed}`.trim();
      continue;
    }
    const key = (match[1] || match[3]).toLowerCase();
    const value = (match[2] !== undefined ? match[2] : match[4]).trim();
    fields[key] = Object.hasOwn(fields, key) ? `${fields[key]} ${value}`.trim() : value;
    current = key;
  }
  /* The role table is upper case and an agent writes `Worker` as often as
     `WORKER`; the word is the same word. */
  if (typeof fields.role === 'string') fields.role = fields.role.toUpperCase();
  return { errors, fields };
}

function parse(text) {
  const lines = String(text).split(/\r?\n/);
  const head = lines.findIndex((l) => l.trim() === 'CONTRACT/1');
  if (head !== -1) return parseBody(lines, head + 1);

  /* No header. Read the whole thing as a body and keep that reading only if it
     is unambiguously a contract: every required field present, and nothing in
     it that failed to parse. Anything less returns the original refusal, whose
     first line is the one true thing about it. */
  const repaired = parseBody(lines, 0);
  const complete = repaired.errors.length === 0
    && REQUIRED.every((key) => typeof repaired.fields[key] === 'string' && repaired.fields[key] !== '');
  if (!complete) return { errors: ['no CONTRACT/1 header'], fields: {} };
  return {
    errors: [],
    fields: repaired.fields,
    repaired: Object.freeze(['the CONTRACT/1 header was missing and was assumed: '
      + 'every required field was present and readable without it']),
  };
}

/* A `because` that names no measurement is the commonest way a contract sends an
 * agent to fix something that is not broken. Numbers, a comparison, a named
 * failing check or a quoted output all count; an adjective does not.
 *
 * A QUOTED OUTPUT IS LOOKED FOR (found in a real-window run). The refusal itself says
 * "or quoted output", and a Controller that quoted the person's request in
 * double quotes was refused six times for it. Quoted means several words in
 * double quotes, curly quotes or backticks: an apostrophe or a one-word scare
 * quote ("slow") is still an adjective. */
const QUOTED_OUTPUT = /"([^"\n]{8,})"|\u201c([^\u201d\n]{8,})\u201d|`([^`\n]{8,})`/g;
function quotesAnOutput(value) {
  for (const match of String(value).matchAll(QUOTED_OUTPUT)) {
    if (/\S\s+\S/.test(match[1] ?? match[2] ?? match[3])) return true;
  }
  return false;
}
function statesAMeasurement(value) {
  return /\d/.test(value) || /\b(measured|exits? 1|returns?|reports?|FAIL|red|green|zero|none|refus)\b/i.test(value)
    || quotesAnOutput(value);
}

/* THE ADJECTIVE GATE JUDGES PROSE, SO IT MUST NOT READ FILENAMES.
 *
 * `done` is required to name the file the diff may touch, and a file can be
 * named like `tools/require-clean-tree.mjs`. `\bclean\b` matches inside that
 * FILENAME -- `-` is a word boundary -- so a correct brief would be refused with
 * "done is not checkable by anybody but the agent", and the only way to satisfy
 * the gate would be to stop naming the target.
 *
 * The rule is aimed at subjective claims ("done when it is properly cleaned
 * up"), which survive this stripping untouched. Only path-shaped tokens are
 * removed, so the gate keeps every case it was written for. */
function withoutPaths(value) {
  return String(value).replace(/[\w./\\-]*[\w-]\.(?:js|mjs|cjs|jsx|json|css|html|ts|md|txt|ps1|py|sh|ya?ml)\b/gi, ' ');
}

function validate(fields) {
  const errors = [];
  for (const key of REQUIRED) if (!fields[key]) errors.push(`missing required field: ${key}`);
  if (fields.role && !ROLES.includes(fields.role)) {
    errors.push(`role must be one of ${ROLES.join('|')} -- got ${fields.role}`);
  }
  if (fields.because && !statesAMeasurement(fields.because)) {
    errors.push('because is missing concrete evidence. Quote the user\'s request with several words (at least 8 characters) in double quotes, curly quotes, or backticks, or name its requested count; for a repair, name an observed number, failing check or quoted output. No preliminary filesystem check is required for a direct request.');
  }
  if (fields.done && /\b(properly|correctly|well|good|clean|nice)\b/i.test(withoutPaths(fields.done))) {
    errors.push('done is not checkable by anybody but the agent. Say what someone else could verify.');
  }
  for (const [key, value] of Object.entries(fields)) {
    if (/[\w./-]+\.(?:js|mjs|cjs|json|css|html|ts):\d+/.test(value)) {
      errors.push(`${key} cites file:line. Line numbers address different code on another branch -- `
        + 'quote the symbol or the string instead.');
    }
  }
  return errors;
}

function expand(fields, apiSheet) {
  const out = [];
  out.push(`ROLE: ${fields.role} working in ${fields.target} -- ${fields.do}`);
  out.push('');
  out.push(`WHY: ${fields.because}`);
  out.push(`DONE WHEN: ${fields.done}`);
  out.push('');
  /* THE REPORT LINE IS NEAR THE TOP.
   *
   * An agent that only READS -- an investigation: "Find...", "List...",
   * "Audit..." -- produces no code change, so if it does not write the report
   * nothing comes back at all. As the last line, after the rules and a tool
   * sheet, the instruction sits where a reader has already stopped; placed
   * first, a warning tends to become the task. So the task leads and the
   * report line follows it. */
  out.push('WRITE THE REPORT EVEN IF YOU CHANGE NO CODE.');
  out.push(`  -> ${fields.report}, relative to the project root.`);
  out.push('  A task that changes nothing and reports nothing is indistinguishable from');
  out.push('  a task that never ran. If your answer is "nothing is wrong here", that is a');
  out.push('  finding and it goes in the file with the evidence that established it.');
  out.push('');
  out.push('RULES');
  for (const rule of INVARIANTS) out.push('  ' + rule);
  out.push('');
  out.push('FORBIDDEN (Fleet or the agent CLI refuses these)');
  for (const rule of FORBIDDEN) out.push('  - ' + rule);
  out.push('');
  if (apiSheet) {
    out.push('TOOLS YOU MAY CALL');
    out.push(apiSheet.trim());
    out.push('');
  }
  out.push('DELEGATION INPUT FORMAT (only when delegation is authorized)');
  out.push(CONTRACT_GUIDE);
  out.push('');
  out.push(`REPORT: ${fields.report} -- lead with the costliest finding, not the first one you found.`);
  return out.join('\n');
}

module.exports = { ROLES, REQUIRED, INVARIANTS, FORBIDDEN, CONTRACT_GUIDE, parse, validate, expand, statesAMeasurement };
