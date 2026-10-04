'use strict';

// The Ledger page for a person working in a terminal: the records (rules,
// tasks and asks) and the person-side actions on them (answer, decline or
// remove an ask; decline or remove a standing rule; complete or remove a task),
// through the engine's own store with the person as the actor.
//
// Inside one sandbox this is a product rule, not a boundary: every process in
// the sandbox, agents included, could run the same command. The person is told
// so on every page; keeping the person's actions out of the agents' reach needs
// the ToolsEnabled host outside the agents' sandbox.

const path = require('node:path');
const fs = require('node:fs');
const store = require('./owner-request-store');
const { MinorLedgerAgentControl } = require('./minor-ledger-agent-gate');
const { resolveStateRoot } = require('./runtime-state-root');
const { terminalDisplayText: safeText } = require('./terminal-safe-text');
const { isRequestId } = require('./request-id');

const PERSON = 'owner';
const KINDS = Object.freeze(['R', 'T', 'A']);
const NOT_A_BOUNDARY = 'Inside one sandbox, agents could run this command too; it records you as the actor but cannot prove it was you.';
const CLOSED = new Set(['done', 'answered', 'declined', 'removed', 'completed']);

function refuse(code, message) {
  return Object.assign(new Error(message), { code });
}

const ID_EXAMPLE = Object.freeze({ A: 'an ask id such as A3', T: 'a task id such as T12', R: 'a rule id such as R2' });
function requireId(kind, id) {
  const valid = kind === 'R' ? isRequestId(id, { family: 'R' })
    : typeof id === 'string' && (kind === 'A' ? /^A[1-9]\d{0,9}$/ : /^T[1-9]\d{0,9}$/).test(id);
  if (!valid) throw refuse('LEDGER_PAGE_ID_INVALID', `Expected ${ID_EXAMPLE[kind]}, got ${JSON.stringify(id)}.`);
  return id;
}

// Which kind an id the person typed names, from its first letter.
function kindOf(id) {
  return typeof id === 'string' && ['R', 'A'].includes(id[0]) ? id[0] : 'T';
}

function optionalText(text) {
  return typeof text === 'string' && text.trim() !== '' ? text : null;
}

function requireText(text, what) {
  if (typeof text !== 'string' || text.trim() === '') throw refuse('LEDGER_PAGE_TEXT_REQUIRED', `Give the ${what}.`);
  return text;
}

/** Records to show: open work first. `kinds` narrows to R, T and/or A. */
function view(options = {}, { read = (args) => new MinorLedgerAgentControl().read(args) } = {}) {
  const { kinds = KINDS, limit = 50, includeClosed = false } = options;
  // The terminal's --all has no next-page control. An explicitly limited
  // caller still gets one page; an omitted limit must walk the whole ledger.
  const allPages = includeClosed && options.limit === undefined;
  const wanted = kinds.filter((kind) => KINDS.includes(kind));
  if (wanted.length === 0) throw refuse('LEDGER_PAGE_KIND_INVALID', 'Choose rules (R), tasks (T) or asks (A).');
  // Declined and removed records are kept but hidden from a plain read; --all shows them too.
  const request = { kinds: wanted, limit, ...(includeClosed ? { removed: true } : {}) };
  let page = read(request);
  let records = Array.isArray(page && page.records) ? page.records : [];
  const closed = CLOSED;
  const result = {
    records: includeClosed ? [...records] : records.filter((record) => !closed.has(record.status)),
    total: page && typeof page.total === 'number' ? page.total : records.length,
    note: NOT_A_BOUNDARY
  };
  if ((includeClosed && !allPages) || !Number.isSafeInteger(limit) || limit < 1) return result;

  // The store pages all records before this view filters closed work. Keep
  // reading until the person's limit is filled or the store is exhausted.
  if (!allPages) result.records = result.records.slice(0, limit);
  const counted = page && Number.isSafeInteger(page.total) && page.total >= 0;
  // A trustworthy total bounds forward offsets. A malformed reader without
  // that count gets a finite budget too, so it cannot trap the terminal.
  const maxPages = counted ? Math.max(1, result.total) : 1000;
  let offset = 0;
  for (let pages = 1; (allPages || result.records.length < limit) && pages < maxPages; pages += 1) {
    const nextOffset = page && page.nextOffset;
    if (records.length === 0 || !Number.isSafeInteger(nextOffset) || nextOffset <= offset
      || (counted && nextOffset >= result.total)) break;
    offset = nextOffset;
    page = read({ ...request, offset });
    records = Array.isArray(page && page.records) ? page.records : [];
    result.records.push(...(allPages ? records
      : records.filter((record) => !closed.has(record.status)).slice(0, limit - result.records.length)));
  }
  return result;
}

function answer({ id, words }, { writer = store, expectedRevision } = {}) {
  return writer.answerAsk({ id: requireId('A', id), answer: requireText(words, 'answer'), actor: PERSON }, { expectedRevision });
}

/** The reason is optional: `decline A4` alone is enough. */
function decline({ id, reason }, { writer = store, expectedRevision } = {}) {
  return writer.declineAsk({ id: requireId('A', id), reason: optionalText(reason), actor: PERSON }, { expectedRevision });
}

/** The person declines a standing or suggested rule; it stops applying and stays on file. */
function declineRule({ id, reason }, { writer = store, expectedRevision } = {}) {
  return writer.declineRequest({ id: requireId('R', id), reason: optionalText(reason), actor: PERSON }, { expectedRevision });
}

/** The person removes a standing rule and its refinements; they stay on file as removed. */
function removeRule({ id }, { writer = store, expectedRevision } = {}) {
  return writer.removeRequest({ id: requireId('R', id), actor: PERSON }, { expectedRevision });
}

function removeAsk({ id }, { writer = store, expectedRevision } = {}) {
  return writer.removeAsk({ id: requireId('A', id), actor: PERSON }, { expectedRevision });
}

function completeTask({ id }, { writer = store, expectedRevision } = {}) {
  return writer.completeTask({ id: requireId('T', id), actor: PERSON }, { expectedRevision });
}

function removeTask({ id }, { writer = store, expectedRevision } = {}) {
  return writer.removeTask({ id: requireId('T', id), actor: PERSON }, { expectedRevision });
}

// Where a record the person typed came from, as the ledger's provenance says it.
const TERMINAL_SOURCE = 'typed by the person with /tefleet ledger';

/** A standing rule for every agent, as the person's own words. */
function addRule({ words }, { writer = store, expectedRevision } = {}) {
  return writer.fileRequest({ scope: 'global', words: requireText(words, 'rule'), filedBy: PERSON, source: TERMINAL_SOURCE }, { expectedRevision });
}

/** A task for the agents, as the person's own words. */
function addTask({ words }, { writer = store, expectedRevision } = {}) {
  return writer.fileTask({ scope: 'global', words: requireText(words, 'task'), filedBy: PERSON }, { expectedRevision });
}

function readActionStdin() {
  const chunks = [];
  let bytes = 0;
  const buffer = Buffer.alloc(4096);
  for (;;) {
    const read = fs.readSync(0, buffer, 0, Math.min(buffer.length, 16_385 - bytes));
    if (read === 0) break;
    bytes += read;
    if (bytes > 16_384) throw refuse('LEDGER_ACTION_TOO_LARGE', 'The ledger action exceeds 16 KiB.');
    chunks.push(Buffer.from(buffer.subarray(0, read)));
  }
  let input;
  try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw refuse('LEDGER_ACTION_INVALID', 'Send one JSON ledger action on stdin.'); }
  return input;
}

// Validate an action, its id and its words before anything is recorded, so a
// refused action leaves no signed intent behind.
function checkAction({ action, id, words }) {
  switch (action) {
    case 'answer': requireId('A', id); requireText(words, 'answer'); return;
    case 'decline': requireId(kindOf(id) === 'R' ? 'R' : 'A', id); return;
    case 'done':
      requireId('T', id);
      /* completeTask has no note field, so words here were accepted and then
       * dropped -- which told the person their note had been kept. Refuse it by
       * name instead; the CLI and any native caller get the same answer. */
      if (typeof words === 'string' && words.trim() !== '') {
        throw refuse('LEDGER_ACTION_INVALID', 'A completion note is not recorded; use done with the task id alone.');
      }
      return;
    case 'remove': requireId(kindOf(id), id); return;
    case 'add-rule': requireText(words, 'rule'); return;
    case 'add-task': requireText(words, 'task'); return;
    default: throw refuse('LEDGER_ACTION_INVALID', 'Choose answer, decline, done, remove, add-rule or add-task.');
  }
}

/** Every person-side change typed at a terminal, whether a plain ledger verb
 * or ledger apply, takes this one path: validate, sign the intent, mutate.
 * The intent is evidence about the local account, not about a person: any
 * process running as the same user can create an identical signed record. */
function applyPersonAction({ action, id, words }, { expectedRevision } = {}) {
  checkAction({ action, id, words });
  // The terminal cannot authenticate composer origin. Record the claimed
  // actor and surface in the signed audit before the ledger mutation, so an
  // unavailable audit refuses the action instead of leaving no provenance.
  const auditIntent = require('./audit').requireRecord('ledger.apply.intent', action, {
    actor: 'owner-claimed', surface: 'terminal-cli', expectedRevision: expectedRevision === undefined ? null : expectedRevision,
    recordId: typeof id === 'string' ? id : null
  });
  const bound = { expectedRevision };
  let result;
  switch (action) {
    case 'answer': result = answer({ id, words }, bound); break;
    case 'decline': result = kindOf(id) === 'R' ? declineRule({ id, reason: words }, bound) : decline({ id, reason: words }, bound); break;
    case 'done': result = completeTask({ id }, bound); break;
    case 'remove': result = { R: removeRule, A: removeAsk, T: removeTask }[kindOf(id)]({ id }, bound); break;
    case 'add-rule': result = addRule({ words }, bound); break;
    default: result = addTask({ words }, bound); break;
  }
  return { result, auditEventId: auditIntent.eventId };
}

/** The plugin passes a human-confirmed action on stdin, never in process argv.
 * The plugin must check composer origin; this CLI boundary cannot prove it. */
function applyHumanInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['action', 'id', 'words', 'expectedRevision'].includes(key))) {
    throw refuse('LEDGER_ACTION_INVALID', 'Use action, id, words and expectedRevision only.');
  }
  const { action, id, words, expectedRevision } = input;
  if (typeof action !== 'string' || (id !== undefined && typeof id !== 'string')
      || (words !== undefined && (typeof words !== 'string' || words.length > 8000))
      || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw refuse('LEDGER_ACTION_INVALID', 'Ledger action fields are invalid or too long.');
  }
  const { result, auditEventId } = applyPersonAction({ action, id, words }, { expectedRevision });
  return { schema: 'ai.toolsenabled/fleet-ledger-action/v1', action,
    id: safeText(result.id), status: safeText(result.status),
    auditEventId, grantsAuthority: false };
}

function oneLine(text, max = 160) {
  const flat = safeText(text).replace(/\s+/g, ' ').trim();
  const points = Array.from(flat);
  return points.length > max ? `${points.slice(0, max - 1).join('')}…` : flat;
}

// Ledger words can be filed by agents. Never pass terminal controls or text
// direction controls from a stored record to a person's terminal or pane.
function safeField(value) { return typeof value === 'string' ? safeText(value) : value; }
function boundedText(value, max = 8000) {
  const points = Array.from(safeText(value));
  return { words: points.slice(0, max).join(''), truncated: points.length > max };
}

/** A single read-only snapshot for user interfaces. Filter before paging so
 * closed records cannot hide open work. Never export the store's private path,
 * capture log, history or authority metadata to the pane. */
function readMachineLedger(args) {
  // statePath() establishes/adopts a redirected root. A pane read must only
  // resolve its location; the store's own readAll never creates ledger files.
  const root = resolveStateRoot().root;
  return store.readAll({ ...args, rootPath: (...parts) => path.join(root, ...parts) });
}

function machineView(options = {}, { read = readMachineLedger } = {}) {
  const { offset = 0, limit = 50, revision, includeClosed = false, kinds = KINDS } = options;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100
      || (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0))) {
    throw refuse('LEDGER_PAGE_RANGE_INVALID', 'Use a non-negative offset/revision and a limit from 1 to 100.');
  }
  // A kinds filter lets a reader page through rules alone, however many tasks
  // and asks agents have filed.
  if (!Array.isArray(kinds) || kinds.length === 0 || kinds.some(kind => !KINDS.includes(kind))) {
    throw refuse('LEDGER_PAGE_KIND_INVALID', 'Choose rules (R), tasks (T) or asks (A).');
  }
  const snapshot = read({ kinds: KINDS, includeRemoved: true, includeProposed: true });
  if (revision !== undefined && revision !== snapshot.revision) {
    throw refuse('LEDGER_PAGE_CHANGED', 'The ledger changed. Reload from offset 0.');
  }
  const matching = snapshot.records.filter(record => kinds.includes(record.kind)
    && (includeClosed || !CLOSED.has(record.status)));
  const records = matching.slice(offset, offset + limit).map(record => {
    const detail = boundedText(record.verbatim || record.request || '');
    const answer = record.answer ? boundedText(record.answer.words) : null;
    const progressDecision = record.kind === 'T' && Array.isArray(record.decisions)
      ? record.decisions.slice().reverse().find(item => item && item.decision === 'progress') : null;
    const progressReason = progressDecision ? boundedText(progressDecision.reason || '', 2000) : null;
    return {
      id: safeField(record.id), kind: safeField(record.kind), title: oneLine(detail.words),
      words: detail.words, truncated: detail.truncated, status: safeField(record.status),
      filedAt: safeField(record.filedAt || null), filedBy: safeField(record.filedBy || null),
      scope: safeField(record.scope), scopeKey: safeField(record.scopeKey || null),
      completedAt: safeField(record.completedAt || null),
      answer: record.answer ? {
        words: answer.words, truncated: answer.truncated,
        at: safeField(typeof record.answer.at === 'string' ? record.answer.at : null),
      } : null,
      progress: progressDecision ? { status: safeField(progressDecision.status || null),
        reason: progressReason.words, truncated: progressReason.truncated,
        at: safeField(progressDecision.at || null) } : null,
      waitingFor: record.kind === 'T' && Array.isArray(record.waitingFor)
        ? record.waitingFor.slice(0, 100).map(value => oneLine(value, 40)) : [],
      waitingForTruncated: record.kind === 'T' && Array.isArray(record.waitingFor) && record.waitingFor.length > 100,
      difficulty: record.kind === 'T' ? safeField(record.difficulty || null) : null,
      recurrence: record.kind === 'T' && record.recurrence ? {
        interval: oneLine(record.recurrence.interval, 160),
        completions: Array.isArray(record.recurrence.completions) ? record.recurrence.completions.length : 0
      } : null,
    };
  });
  return {
    schema: 'ai.toolsenabled/fleet-ledger/v1', revision: snapshot.revision, updatedAt: safeField(snapshot.updatedAt || null),
    view: includeClosed ? 'all' : 'open', ...(kinds === KINDS ? {} : { kinds: [...kinds] }), records, total: matching.length, offset, limit,
    nextOffset: offset + records.length < matching.length ? offset + records.length : null,
    grantsAuthority: false,
  };
}

/** Both terminal entry points share the same read-only paging contract. */
function machineOptions(args, command, verb) {
  const options = { includeClosed: args.all === true };
  const paged = ['offset', 'limit', 'revision', 'kinds'].some(key => args[key] !== undefined);
  if ((paged && (command !== 'ledger' || !(args.json || args.text))) || (command === 'ledger' && (args.json || args.text) && verb)) {
    throw refuse('LEDGER_PAGE_RANGE_INVALID', 'Use --offset, --limit and --revision only with ledger --json or --text; read-only ledger views cannot include an action.');
  }
  for (const key of ['offset', 'limit', 'revision']) {
    if (args[key] === undefined) continue;
    if (!/^\d+$/.test(args[key])) throw refuse('LEDGER_PAGE_RANGE_INVALID', `--${key} needs a non-negative integer.`);
    options[key] = Number(args[key]);
  }
  if (args.kinds !== undefined) {
    const kinds = String(args.kinds).split(',').map(kind => kind.trim().toUpperCase()).filter(Boolean);
    if (!kinds.length || kinds.some(kind => !KINDS.includes(kind))) throw refuse('LEDGER_PAGE_KIND_INVALID', '--kinds takes R, T and/or A, for example --kinds R.');
    options.kinds = KINDS.filter(kind => kinds.includes(kind));
  }
  if (args.text && args.limit === undefined) options.limit = 20;
  if (args.text && !['plain', 'console'].includes(args.surface) && options.limit > 20) options.limit = 20;
  return options;
}

/** Plain terminal lines for view()'s result. */
function format({ records, note }) {
  const heading = ['ToolsEnabled Fleet — Ledger', ''];
  if (records.length === 0) return [...heading, 'Nothing open on the ledger.', '', safeText(note)];
  const lines = records.map((record) => {
    const who = record.filedBy ? ` (from ${record.filedBy === PERSON ? 'you' : oneLine(record.filedBy, 80)})` : '';
    const words = record.verbatim || record.request || record.words || '';
    return `${oneLine(record.id, 40)}  ${oneLine(record.status || 'open', 40)}${who}  ${oneLine(words)}`;
  });
  return [...heading, ...lines, '', safeText(note)];
}

module.exports = Object.freeze({ view, machineView, machineOptions, answer, decline, declineRule, removeRule, removeAsk, completeTask, removeTask,
  addRule, addTask, readActionStdin, applyHumanInput, applyPersonAction, format, NOT_A_BOUNDARY });
