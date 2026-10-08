#!/usr/bin/env node
'use strict';
// Fleet's prompt hook.
// - /tefleet ledger ... and /tefleet settings ... are the person's commands,
//   handled here and never through Claude: agents may not add standing rules,
//   answer for the person or change Fleet's settings.
//   - Run with --expansion, for Claude Code's UserPromptExpansion event, the
//     hook applies a change at once. Claude Code raises that event only when a
//     slash command typed at its prompt expands; scheduled prompts, wakeups and
//     messages from other sessions skip slash commands, so they never raise it.
//   - On UserPromptSubmit, the hook cannot tell the person's typing from a
//     scheduled or relayed prompt (Claude Code 2.1.289 passes no prompt
//     source). It shows views, and for a change it shows the person a one-time
//     code instead: the change is made only when the person types
//     /tefleet confirm <code>. A blocked prompt's reason is shown to the
//     person and is not added to Claude's context.
//   - A prompt Claude Code says came from a subagent or from anything but the
//     person is refused.
// - With --session-start, a new session in Fleet's project gets the person's
//   standing rules.
// - The prompt after a new rule carries that rule to this session's Claude.
// Every other prompt passes through untouched and is not kept.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { projectFolder, inside, savedWorkspace } = require('./project-folder');
const PREFIXES = ['/tefleet', '/toolsenabled-fleet:tefleet'];
const COMMAND_NAMES = new Set(['tefleet', 'toolsenabled-fleet:tefleet']);
const PAGE_SIZE = 20;
const CONFIRM_MS = 5 * 60 * 1000;
const CODE = /^\d{6}$/;
const CONFIRM_LINE = 'If Fleet cannot tell that you typed a change yourself, it shows a code instead; type /tefleet confirm <code> within 5 minutes to make the change.';
const USAGE = [
  'Fleet ledger (you type these; Fleet files them itself, not through Claude):',
  `/tefleet ledger - show open items, ${PAGE_SIZE} at a time`,
  '/tefleet ledger page <number> - show another page of open items',
  '/tefleet ledger all [page <number>] - show every item, closed ones too',
  '/tefleet ledger rule <words> - add a standing rule every Fleet agent follows',
  '/tefleet ledger task <words> - add a task',
  '/tefleet ledger answer <question ID> <words> - answer a question an agent filed',
  '/tefleet ledger done <task ID> - mark a task done',
  '/tefleet ledger decline <question or rule ID> [note] - decline a question, or stop a standing rule',
  '/tefleet ledger remove <rule, task or question ID> - remove it from the ledger',
  CONFIRM_LINE,
].join('\n');
const SETTINGS_USAGE = [
  'Fleet settings (you type these; Fleet applies them itself, not through Claude):',
  '/tefleet settings - show the settings',
  '/tefleet settings depth <1-16> - levels of subagents below your session',
  '/tefleet settings width <1-64> - subagents each agent may have running at once',
  '/tefleet settings providers <CLI ...|all> - agent CLIs subagents may use: claude, codex, opencode',
  '/tefleet settings models <model ...|all> - models subagents may use',
  '/tefleet settings audit <on|off> - signed audit of Fleet operations',
  'Several changes can go in one command, for example /tefleet settings depth 2 width 3.',
  CONFIRM_LINE,
].join('\n');
const HANDLED = '(Fleet handled this itself; it was not sent to Claude.)';
// How much of the person's rules a Claude session is given; subagent briefs
// use the same bounds. Claude can read the rest with Fleet's ledger.read.
const MAX_RULES = 40;
const MAX_RULE_CHARS = 500;
const MAX_RULES_TEXT = 6000;
const STANDING = new Set(['open', 'in-progress', 'partial', 'blocked-external']);
const RULE_ID = /^R[1-9]\d{0,9}$/;
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
// Prompt sources Claude Code may name; any source but "user" is not the person typing.
const SOURCES = Object.freeze({
  schedule_wakeup: 'a scheduled task sent it',
  loop_wakeup: 'a /loop wakeup sent it',
  system: 'Claude Code sent it on its own, for example a message from another session or a notification',
  sdk: 'a program driving Claude Code sent it',
  poll_event: 'an event Claude Code received sent it',
});

function output(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
// Whether this session works in the project Fleet is set up for. Rules are
// context only there; Fleet's tools and subagents serve only that project.
function inFleetProject(event) {
  const workspace = savedWorkspace(require('./runtime-config').resolveConfig().stateRoot);
  const cwd = typeof event.cwd === 'string' && path.isAbsolute(event.cwd) ? event.cwd : process.cwd();
  return Boolean(workspace) && inside(projectFolder(process.env, cwd), workspace);
}
// Text from a prompt, safe to repeat in a message: one line, no control or
// direction characters, at most `max` characters.
function quoted(value, max = 300) {
  const chars = Array.from(String(value).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}
// Runs one of Fleet's own commands. `failure` begins the sentence the person
// reads when it fails, such as "Fleet's ledger did not change".
function command(argv, failure, retried = false) {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(process.execPath, argv, { env: require('./runtime-config').childEnvironment(), encoding: 'utf8', timeout: 80000, maxBuffer: 4 * 1024 * 1024 });
  if (result.status === 0) return { ok: true, text: String(result.stdout).trim() };
  const detail = String(result.stderr || result.error?.message || 'Fleet did not answer.').trim();
  // Right after a plugin update, bind the saved setup to this version first.
  if (!retried && /HOST_PLUGIN_REBIND_REQUIRED/.test(detail) && require('./setup-server').runRebind()) return command(argv, failure, true);
  if (/HOST_SETUP_REQUIRED|not configured|setup is required/i.test(detail)) {
    return { ok: false, detail, text: 'Fleet is not set up for this project yet, so nothing was changed. Type /tefleet setup first.' };
  }
  const reason = detail.replace(/^Fleet settings failed:\s*/, '').replace(/^[A-Z][A-Z0-9_]+:\s*/, '').split('\n')[0];
  return { ok: false, detail, text: `${failure}: ${reason}` };
}
// The engine's own person command for the ledger. The person's words come
// after "--", so words that begin with "--" stay words.
function ledger(options, words = []) {
  const config = require('./runtime-config').resolveConfig();
  return command([path.join(config.engine, 'bin/toolsenabled-host.js'), 'ledger', ...options,
    '--plugin', '--state-root', config.stateRoot, '--', ...words], 'Fleet\'s ledger did not change');
}
// The person's standing rules, every page of them, in filing order; null when
// the ledger cannot be read. Rules are read on their own, so no number of
// tasks or asks can push them out.
function standingRules() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const rules = [];
    let offset = 0, revision = null, changed = false;
    for (let pages = 0; pages < 100; pages += 1) {
      const listed = ledger(['--json', '--kinds', 'R', '--limit', '100', '--offset', String(offset),
        ...(revision === null ? [] : ['--revision', String(revision)])]);
      if (!listed.ok) { changed = /LEDGER_PAGE_CHANGED/.test(listed.detail); break; }
      let page;
      try { page = JSON.parse(listed.text); } catch { return null; }
      if (revision === null) revision = page.revision;
      for (const row of Array.isArray(page.records) ? page.records : []) if (row.kind === 'R' && STANDING.has(row.status)) rules.push(row);
      if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset) return rules;
      offset = page.nextOffset;
    }
    if (!changed) return null;
  }
  return null;
}
// Rule lines for Claude, within the bounds above, and what was cut.
function ruleLines(rules) {
  const lines = [];
  let size = 0, shortened = 0;
  for (const row of rules) {
    const words = Array.from(String(row.words || '').replace(/\s+/g, ' ').trim());
    const cut = words.length > MAX_RULE_CHARS || row.truncated === true;
    const line = `- ${row.id}: ${words.slice(0, MAX_RULE_CHARS).join('')}${cut ? ' [cut]' : ''}`;
    if (lines.length >= MAX_RULES || size + line.length > MAX_RULES_TEXT) break;
    lines.push(line);
    size += line.length + 1;
    if (cut) shortened += 1;
  }
  const notes = [];
  // Rules are delivered here, never fetched: the rest are the person's to see, not instructions to look up.
  if (rules.length > lines.length) notes.push(`(${rules.length - lines.length} more standing rule${rules.length - lines.length === 1 ? ' is' : 's are'} not shown here; the person sees every rule with /tefleet ledger.)`);
  if (shortened) notes.push('(Rules marked [cut] are longer than shown; the person sees their full words with /tefleet ledger.)');
  return { lines, notes, shown: new Set(lines.map(line => line.slice(2, line.indexOf(':')))) };
}
// The person's standing rules, as context for a Claude session.
function rulesContext() {
  const rules = standingRules();
  if (!rules || !rules.length) return '';
  const { lines, notes } = ruleLines(rules);
  return ['Standing rules the person set in Fleet\'s ledger. Follow them in this project, and they apply to every subagent you start:',
    ...lines, ...notes].join('\n');
}

// Private folders for what waits on the person's next prompt: a rule's id
// until this session's Claude is told of it, and a change waiting for the
// person's confirmation. They live in Claude Code's plugin data folder, or in
// Fleet's own state folder when Claude Code gives none.
const FOLDERS = Object.freeze({ rules: ['pending-rules', 'plugin-pending-rules'], confirm: ['pending-confirm', 'plugin-pending-confirm'] });
function pendingFolder(kind) {
  const [dataName, stateName] = FOLDERS[kind];
  const data = process.env.CLAUDE_PLUGIN_DATA;
  if (typeof data === 'string' && path.isAbsolute(data) && path.normalize(data) === data) return { parent: data, folder: path.join(data, dataName) };
  try {
    const { stateRoot } = require('./runtime-config').resolveConfig();
    return { parent: stateRoot, folder: path.join(stateRoot, stateName) };
  } catch { return null; }
}
function ownedBy(stat, { directory, privateMode }) {
  return !stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile()) && stat.uid === process.getuid()
    && (privateMode ? (stat.mode & 0o077) === 0 : (stat.mode & 0o022) === 0);
}
// The pending folder, checked with lstat: a folder (not a link) owned by this
// account with mode 0700, in a parent that only this account can change.
function privatePending(create, kind = 'rules') {
  const where = pendingFolder(kind);
  if (!where) return null;
  // Claude Code's data folder may not exist yet; Fleet's state folder must.
  if (create && where.parent === process.env.CLAUDE_PLUGIN_DATA && !fs.existsSync(where.parent)) fs.mkdirSync(where.parent, { recursive: true, mode: 0o700 });
  if (!ownedBy(fs.lstatSync(where.parent), { directory: true, privateMode: false })) throw new Error('unsafe pending parent');
  if (create) { try { fs.mkdirSync(where.folder, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
  const stat = fs.lstatSync(where.folder);
  if (!ownedBy(stat, { directory: true, privateMode: true }) || (stat.mode & 0o777) !== 0o700) throw new Error('unsafe pending folder');
  return where.folder;
}
function openPrivate(file, flags) {
  const fd = fs.openSync(file, flags | fs.constants.O_NOFOLLOW, 0o600);
  const stat = fs.fstatSync(fd);
  if (!ownedBy(stat, { directory: false, privateMode: true }) || stat.nlink !== 1) { fs.closeSync(fd); throw new Error('unsafe pending file'); }
  return fd;
}
// A session that sent no further prompt leaves its file; clear old ones.
function clearOld(folder, pattern, ageMs) {
  for (const name of fs.readdirSync(folder)) {
    const file = path.join(folder, name);
    try { if (pattern.test(name) && Date.now() - fs.lstatSync(file).mtimeMs > ageMs) fs.unlinkSync(file); } catch { /* gone */ }
  }
}
function rememberRule(sessionId, id) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId) || !RULE_ID.test(id)) return;
  const folder = privatePending(true);
  if (!folder) return;
  clearOld(folder, /^[A-Za-z0-9_-]{1,128}\.txt$/, 7 * 86400000);
  const fd = openPrivate(path.join(folder, `${sessionId}.txt`), fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT);
  try { fs.writeSync(fd, `${id}\n`); } finally { fs.closeSync(fd); }
}
function takePendingRules(sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return [];
  let folder;
  try { folder = privatePending(false); } catch { return []; }
  if (!folder) return [];
  const file = path.join(folder, `${sessionId}.txt`);
  let fd;
  try { fd = openPrivate(file, fs.constants.O_RDONLY); } catch { return []; }
  let content = '';
  try {
    const buffer = Buffer.alloc(4096);
    content = buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, 0)).toString('utf8');
  } finally { fs.closeSync(fd); }
  try { fs.unlinkSync(file); } catch { /* already taken */ }
  return [...new Set(content.split('\n').map(line => line.trim()).filter(line => RULE_ID.test(line)))].slice(0, MAX_RULES);
}

// One-time codes. Only a digest of the code is kept, with the change it
// confirms, for one session and five minutes; the code itself appears only in
// the message shown to the person.
const MAX_CONFIRM_FILE = 256 * 1024;
function digest(salt, sessionId, code) {
  return crypto.createHash('sha256').update(`${salt}\n${sessionId}\n${code}`).digest('hex');
}
function waitForConfirmation(sessionId, request) {
  const folder = privatePending(true, 'confirm');
  if (!folder) throw new Error('no private folder');
  clearOld(folder, /^[A-Za-z0-9_-]{1,128}\.json(?:\.(?:new|taken)-[0-9a-f]+)?$/, 3600000);
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const salt = crypto.randomBytes(16).toString('hex');
  const record = JSON.stringify({ version: 1, salt, digest: digest(salt, sessionId, code), expires: Date.now() + CONFIRM_MS,
    command: request.command, words: request.words });
  if (Buffer.byteLength(record) > MAX_CONFIRM_FILE) throw new Error('too long to confirm');
  // Written whole, then put in place: a newer request replaces an older one.
  const fresh = path.join(folder, `${sessionId}.json.new-${crypto.randomBytes(8).toString('hex')}`);
  const fd = openPrivate(fresh, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL);
  try { fs.writeSync(fd, record); } finally { fs.closeSync(fd); }
  fs.renameSync(fresh, path.join(folder, `${sessionId}.json`));
  return code;
}
// The change waiting in this session, taken so no other prompt can use it.
function takeConfirmation(sessionId) {
  let folder;
  try { folder = privatePending(false, 'confirm'); } catch { return null; }
  if (!folder) return null;
  const taken = path.join(folder, `${sessionId}.json.taken-${crypto.randomBytes(8).toString('hex')}`);
  try { fs.renameSync(path.join(folder, `${sessionId}.json`), taken); } catch { return null; }
  let content = '';
  try {
    const fd = openPrivate(taken, fs.constants.O_RDONLY);
    try {
      const buffer = Buffer.alloc(MAX_CONFIRM_FILE + 1);
      content = buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, 0)).toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return null; } finally { try { fs.unlinkSync(taken); } catch { /* gone */ } }
  let record;
  try { record = JSON.parse(content); } catch { return null; }
  if (!record || record.version !== 1 || typeof record.salt !== 'string' || !/^[0-9a-f]{64}$/.test(record.digest || '')
      || !Number.isSafeInteger(record.expires) || !['ledger', 'settings'].includes(record.command) || typeof record.words !== 'string') return null;
  return record;
}

// Who sent this prompt, as far as Claude Code says: { typed } for the person
// typing at Claude Code's prompt, { unknown } when Claude Code does not say,
// or { refused } with the reason.
function promptOrigin(event, expansion) {
  if (typeof event.agent_id === 'string' && event.agent_id) return { refused: 'a subagent\'s prompt carried it' };
  if (typeof event.session_id === 'string' && event.session_id.startsWith('served:')) return { refused: 'another session sent it' };
  if (expansion && event.hook_event_name === 'UserPromptExpansion' && event.expansion_type === 'slash_command') return { typed: true };
  if (event.source !== undefined && event.source !== null) {
    if (event.source === 'user') return { typed: true };
    return { refused: Object.hasOwn(SOURCES, event.source) ? SOURCES[event.source] : 'Claude Code says it did not come from you typing it' };
  }
  return { unknown: true };
}
function refusal(why) {
  return `Fleet did not change anything: this /tefleet command did not come from you typing it (${why}). `
    + `Fleet acts on /tefleet ledger and /tefleet settings only when you type them at Claude Code's prompt. ${HANDLED}`;
}

// The ledger, a page at a time, in the engine's own text, with the next
// page named as the person types it.
function ledgerView({ all, page }) {
  const listed = ledger(['--text', '--width', '100', '--limit', String(PAGE_SIZE), '--offset', String((page - 1) * PAGE_SIZE), ...(all ? ['--all'] : [])]);
  if (!listed.ok) return listed.text;
  const lines = listed.text.split('\n');
  const end = lines.findIndex(line => line.startsWith('more: ') || line === 'Join wrapped parts exactly:');
  const shown = end === -1 ? lines : lines.slice(0, end);
  const pages = /· page (\d+)\/(\d+)$/.exec(shown[0] || '');
  const last = pages ? Number(pages[2]) : 1;
  const which = all ? 'all ' : '';
  if (page > last) return `The ledger has ${last} page${last === 1 ? '' : 's'} of ${all ? 'items' : 'open items'}; type /tefleet ledger ${which}page ${last} for the last one.`;
  const next = page < last ? [`Next page: /tefleet ledger ${which}page ${page + 1}`] : [];
  const closed = all ? [] : ['Closed items too: /tefleet ledger all'];
  return [...shown, ...next, ...closed].join('\n');
}
// What the person asked of the ledger: a view, a change, or null for the usage.
function parseLedger(rest) {
  let match;
  if (rest === '' || rest === 'list') return { view: { all: false, page: 1 } };
  if ((match = /^(?:all|(?:(all)\s+)?page\s+([1-9]\d{0,5}))$/.exec(rest))) {
    return { view: { all: rest.startsWith('all'), page: match[2] ? Number(match[2]) : 1 } };
  }
  if ((match = /^(rule|task)\s+([\s\S]+)$/.exec(rest))) return { change: { action: 'add', kind: match[1], words: match[2].trim() } };
  if ((match = /^answer\s+(\S+)\s+([\s\S]+)$/.exec(rest))) return { change: { action: 'answer', id: match[1], words: match[2].trim() } };
  if ((match = /^decline\s+(\S+)(?:\s+([\s\S]+))?$/.exec(rest))) return { change: { action: 'decline', id: match[1], words: match[2] ? match[2].trim() : '' } };
  if ((match = /^(done|remove)\s+(\S+)$/.exec(rest))) return { change: { action: match[1], id: match[2] } };
  return null;
}
function describeLedger(change) {
  if (change.action === 'add') return `add the ${change.kind === 'rule' ? 'standing rule' : 'task'} "${quoted(change.words)}" to Fleet's ledger`;
  if (change.action === 'answer') return `answer ${quoted(change.id, 40)} with "${quoted(change.words)}"`;
  if (change.action === 'decline') return `decline ${quoted(change.id, 40)}${change.words ? ` with the note "${quoted(change.words)}"` : ''}`;
  if (change.action === 'done') return `mark ${quoted(change.id, 40)} done`;
  return `remove ${quoted(change.id, 40)} from Fleet's ledger`;
}
function addRuleReply(id, here) {
  const rules = standingRules() || [];
  const { shown } = ruleLines(rules);
  const row = rules.find(rule => rule.id === id);
  const long = row && (Array.from(String(row.words || '').replace(/\s+/g, ' ').trim()).length > MAX_RULE_CHARS || row.truncated === true);
  const notes = [];
  if (row && !shown.has(id)) notes.push(`New sessions are given your first ${shown.size} standing rules in full and told to read the rest, including this one, with Fleet's ledger.read tool.`);
  else if (long) notes.push(`New sessions and subagents are given its first ${MAX_RULE_CHARS} characters and told to read the rest with Fleet's ledger.read tool.`);
  return [here
    ? `Done: added standing rule ${id} to Fleet's ledger. New Fleet subagents and sessions follow it, and this session does from your next message.`
    : `Done: added standing rule ${id} to Fleet's ledger. Fleet's subagents and new sessions in its project follow it.`, ...notes, HANDLED].join(' ');
}
function applyLedger(change, event) {
  if (change.action === 'add') {
    const added = ledger([], ['add', change.kind, change.words]);
    if (!added.ok) return added.text;
    const id = (/^(\S+) is now/.exec(added.text) || [])[1] || '';
    if (change.kind === 'task') return `Done: added task ${id} to Fleet's ledger. ${HANDLED}`;
    const here = inFleetProject(event);
    if (here) {
      try { rememberRule(event.session_id, id); } catch { /* the rule still reaches new sessions and every subagent */ }
    }
    return addRuleReply(id, here);
  }
  const done = ledger([], [change.action, change.id, ...(change.words ? [change.words] : [])]);
  return done.ok ? `Done: ${done.text} ${HANDLED}` : done.text;
}

// /tefleet settings: the person's own changes, applied here without Claude.
const SETTING_NAMES = Object.freeze({
  depth: 'depth', width: 'width', providers: 'providers', provider: 'providers', models: 'models', model: 'models',
  audit: 'audit',
});
function parseSettings(rest) {
  const words = rest.split(/[\s,=]+/).filter(Boolean);
  const changes = {};
  for (let at = 0; at < words.length;) {
    const name = SETTING_NAMES[words[at].toLowerCase()];
    if (!name || Object.hasOwn(changes, name)) return null;
    const values = [];
    for (at += 1; at < words.length && !Object.hasOwn(SETTING_NAMES, words[at].toLowerCase()); at += 1) values.push(words[at]);
    if (!values.length) return null;
    if (name === 'depth' || name === 'width') {
      if (values.length !== 1 || !/^\d{1,3}$/.test(values[0])) return null;
      changes[name] = Number(values[0]);
    } else if (name === 'audit') {
      const value = values.length === 1 && values[0].toLowerCase();
      if (!['on', 'off', 'true', 'false', 'yes', 'no'].includes(value)) return null;
      changes.audit = ['on', 'true', 'yes'].includes(value);
    } else {
      const list = values.map(value => value.toLowerCase());
      if (list.includes('all') && list.length > 1) return null;
      changes[name] = list;
    }
  }
  return changes;
}
function describeSettings(changes) {
  const named = { depth: 'depth', width: 'width', audit: 'audit', providers: 'providers', models: 'models' };
  return `change Fleet's settings: ${Object.entries(changes).map(([name, value]) => `${named[name]} ${
    name === 'audit' ? (value ? 'on' : 'off') : quoted(Array.isArray(value) ? value.join(' ') : value, 200)}`).join(', ')}`;
}
function settingsView(changes) {
  const { describeSettings: describe } = require('./settings-tool');
  const changing = Object.keys(changes).length > 0;
  const result = command([path.join(__dirname, 'settings-entry.js'), ...(changing ? ['--apply', JSON.stringify(changes)] : ['--show'])],
    changing ? 'Fleet\'s settings were not changed' : 'Fleet\'s settings are unavailable');
  if (!result.ok) return result.text;
  let view;
  try { view = JSON.parse(result.text.slice(result.text.indexOf('{'))); }
  catch { return 'Fleet\'s settings returned an unexpected result.'; }
  return [...(changing ? ['Done: Fleet\'s settings are changed.'] : []), ...describe(view),
    ...(changing ? [] : ['Change them with /tefleet settings followed by the change, for example /tefleet settings depth 2. Type /tefleet settings help for every change.']), HANDLED].join('\n');
}

// One of the person's commands, as { usage }, { view } or { change }.
function plan(request) {
  if (request.command === 'ledger') {
    const parsed = parseLedger(request.words);
    if (!parsed) return { usage: USAGE };
    if (parsed.view) return { view: () => ledgerView(parsed.view) };
    return { describe: describeLedger(parsed.change), apply: event => applyLedger(parsed.change, event) };
  }
  if (request.words === 'help') return { usage: SETTINGS_USAGE };
  const changes = request.words === '' || request.words === 'show' ? {} : parseSettings(request.words);
  if (!changes) return { usage: SETTINGS_USAGE };
  if (!Object.keys(changes).length) return { view: () => settingsView({}) };
  return { describe: describeSettings(changes), apply: () => settingsView(changes) };
}
function askToConfirm(request, describe, event) {
  let code = null;
  if (typeof event.session_id === 'string' && SESSION_ID.test(event.session_id)) {
    try { code = waitForConfirmation(event.session_id, request); } catch { code = null; }
  }
  if (!code) {
    return 'Fleet did not change anything. It cannot tell whether you typed this /tefleet command yourself, and it could not ask you to confirm it here. '
      + `Type the command at Claude Code's prompt. ${HANDLED}`;
  }
  return ['Fleet has not changed anything yet. It cannot tell whether you typed this /tefleet command yourself or a scheduled task or another program sent it.',
    `It asks Fleet to ${describe}.`,
    `If you want that, type /tefleet confirm ${code} within 5 minutes. The code works once, in this session.`,
    'If you did not ask for it, ignore this message and nothing changes.',
    HANDLED].join('\n');
}
function run(request, event, origin) {
  const steps = plan(request);
  if (steps.usage) return steps.usage;
  if (steps.view) return steps.view();
  return origin.typed ? steps.apply(event) : askToConfirm(request, steps.describe, event);
}
function confirm(words, event) {
  if (!CODE.test(words)) return `Type /tefleet confirm followed by the 6-digit code Fleet showed you. ${HANDLED}`;
  const record = typeof event.session_id === 'string' && SESSION_ID.test(event.session_id) ? takeConfirmation(event.session_id) : null;
  if (!record) return `Nothing is waiting for your confirmation in this session, so nothing was changed. A code works once and for 5 minutes; type the command again. ${HANDLED}`;
  if (Date.now() > record.expires) return `That code has expired, so nothing was changed. Type the command again. ${HANDLED}`;
  const given = Buffer.from(digest(record.salt, event.session_id, words), 'hex');
  if (!crypto.timingSafeEqual(given, Buffer.from(record.digest, 'hex'))) {
    return `That code does not match, so nothing was changed, and the waiting change was dropped. Type the command again. ${HANDLED}`;
  }
  return run({ command: record.command, words: record.words }, event, { typed: true });
}

// The words after "/tefleet <verb>", or null for any other prompt.
function commandRest(prompt, verb) {
  for (const prefix of PREFIXES) {
    if (!prompt.startsWith(prefix)) continue;
    const match = new RegExp(`^\\s+${verb}(?:\\s+([\\s\\S]*))?$`).exec(prompt.slice(prefix.length));
    if (match) return (match[1] || '').trim();
  }
  return null;
}
// The reason to block with for one of the person's commands, or null when the
// prompt is not one.
function respond(prompt, event, expansion) {
  const words = { ledger: commandRest(prompt, 'ledger'), settings: commandRest(prompt, 'settings'), confirm: commandRest(prompt, 'confirm') };
  if (words.ledger === null && words.settings === null && words.confirm === null) return null;
  const origin = promptOrigin(event, expansion);
  if (origin.refused) return refusal(origin.refused);
  const unsafe = require('./node-guard').nodeRefusal({ workspaces: require('./node-guard').savedWorkspaces() });
  if (unsafe) return `${unsafe} Nothing was changed.`;
  if (words.confirm !== null) return confirm(words.confirm, event);
  return words.ledger !== null ? run({ command: 'ledger', words: words.ledger }, event, origin)
    : run({ command: 'settings', words: words.settings }, event, origin);
}
// The command a UserPromptExpansion event names, as the person typed it.
function expandedPrompt(event) {
  const name = typeof event.command_name === 'string' ? event.command_name : '';
  if (!COMMAND_NAMES.has(name)) return null;
  const args = typeof event.command_args === 'string' ? event.command_args
    : Array.isArray(event.command_args) ? event.command_args.join(' ') : null;
  if (args !== null) return `/tefleet ${args}`.trim();
  return typeof event.prompt === 'string' ? event.prompt.trim() : null;
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; if (input.length > 1_000_000) process.exit(0); });
process.stdin.on('end', () => {
  let event = {};
  try { event = JSON.parse(input) || {}; } catch { return; }
  if (process.argv.includes('--session-start')) {
    if (!inFleetProject(event)) return;
    const unsafe = require('./node-guard').nodeRefusal({ workspaces: require('./node-guard').savedWorkspaces() });
    if (unsafe) { output({ systemMessage: unsafe }); return; }
    const context = rulesContext();
    if (context) output({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } });
    return;
  }
  if (process.argv.includes('--expansion')) {
    // Other /tefleet commands expand for Claude as usual.
    const prompt = expandedPrompt(event);
    const reason = prompt === null ? null : respond(prompt, event, true);
    if (reason !== null) output({ decision: 'block', reason: reason.slice(0, 4000) });
    return;
  }
  const prompt = String(event.prompt || '').trim();
  const reason = respond(prompt, event, false);
  if (reason !== null) { output({ decision: 'block', reason: reason.slice(0, 4000) }); return; }
  // Claude Code versions without short plugin command names pass "/tefleet ..."
  // to Claude as text; give Claude the command's own instructions.
  const short = /^\/tefleet(?:\s+([\s\S]*))?$/.exec(prompt);
  if (short) {
    try {
      const body = fs.readFileSync(path.join(__dirname, 'commands', 'tefleet.md'), 'utf8').replace(/^---[\s\S]*?\n---\n/, '');
      output({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: body.replace(/\$ARGUMENTS/g, (short[1] || '').trim()).trim() } });
    } catch { /* the prompt still reaches Claude as typed */ }
    return;
  }
  const ids = takePendingRules(event.session_id);
  if (!ids.length || !inFleetProject(event)) return;
  const rules = (standingRules() || []).filter(row => ids.includes(row.id) && row.filedBy === 'owner');
  if (!rules.length) return;
  const { lines, notes } = ruleLines(rules);
  output({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit',
    additionalContext: ['The person just added standing rules in Fleet\'s ledger. Follow them from now on, and they apply to every subagent you start:',
      ...lines, ...notes].join('\n') } });
});
