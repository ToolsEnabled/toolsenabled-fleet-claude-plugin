#!/usr/bin/env node
'use strict';

// Set privacy before importing any module that may create shared state.
process.umask(0o077);
const path = require('node:path');
const os = require('node:os');
const runtime = require('../src/lib/host-runtime');

function parseArgs(argv) {
  const result = { args: [], stateRoot: path.join(os.homedir(), '.toolsenabled-host') };
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at];
    // After "--", every word is a word: ledger text may itself begin with "--".
    if (arg === '--') { result.args.push(...argv.slice(at + 1)); break; }
    if (['--state-root', '--actor', '--workspace', '--tier', '--providers', '--models'].includes(arg)) {
      if (!argv[at + 1] || argv[at + 1].startsWith('--')) throw new Error(`${arg} needs a value.`);
      result[({ '--state-root': 'stateRoot', '--actor': 'actor', '--workspace': 'workspace', '--tier': 'tier', '--providers': 'providers', '--models': 'models' })[arg]] = argv[++at];
    } else if (['--offset', '--limit', '--revision', '--width', '--surface', '--kinds'].includes(arg)) {
      if (!argv[at + 1] || argv[at + 1].startsWith('--')) throw new Error(`${arg} needs a value.`);
      result[arg.slice(2)] = argv[++at];
    } else if (arg === '--plugin') result.plugin = true;
    else if (arg === '--enable-workers') result.enableWorkers = true;
    else if (arg === '--json') result.json = true;
    else if (arg === '--text') result.text = true;
    else if (arg === '--watch') result.watch = true;
    else if (arg === '--json-lines') result.jsonLines = true;
    else if (arg === '--all') result.all = true;
    else if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}.`);
    else result.args.push(arg);
  }
  if (result.actor && !['codex', 'claude'].includes(result.actor)) throw new Error('--actor must be codex or claude.');
  const paged = ['offset', 'limit', 'revision', 'kinds'].some(key => result[key] !== undefined);
  if ((paged && (!['ledger', 'settings'].includes(result.args[0]) || !(result.json || result.text)))
      || (result.kinds !== undefined && result.args[0] !== 'ledger')
      || (result.args[0] === 'ledger' && (result.json || result.text) && result.args[1])) {
    throw new Error('Use a read-only --json or --text view for paging; do not include a ledger action.');
  }
  return result;
}

const out = value => process.stdout.write(`${value}\n`);
const hostPageLine = value => out(value.replace('Inside one sandbox,', 'On this host,'));
const textView = (name, snapshot, options) => out(require('../src/lib/fleet-text-view')
  .render(name, snapshot, { width: options.width, surface: options.surface }).text);
function readOnlyHostEnvironment(config) {
  // A pane uses the verified host binding, not inherited state overrides.
  // This is process-local configuration; it creates no profile or services.
  for (const name of Object.keys(process.env)) if (name.startsWith('TOOLSENABLED_')) delete process.env[name];
  process.env.TOOLSENABLED_RUNTIME_MODE = 'host';
  process.env.TOOLSENABLED_STATE_ROOT = path.join(config.stateRoot, 'capability');
  if (config.setupKind === 'plugin') process.env.TOOLSENABLED_HOST_SETUP_KIND = 'plugin';
}

function ledger(options) {
  const page = require('../src/lib/openshell-ledger-page');
  const [verb, id, ...words] = options.args.slice(1);
  if (verb === 'apply') {
    if (options.args.length !== 2 || options.json || options.all) throw new Error('Use ledger apply with one JSON action on stdin.');
    out(JSON.stringify(page.applyHumanInput(page.readActionStdin())));
    return;
  }
  if (!verb && (options.json || options.text)) {
    const snapshot = page.machineView(page.machineOptions(options, 'ledger'));
    if (options.json) out(JSON.stringify(snapshot)); else textView('ledger', snapshot, options);
    return;
  }
  if (!verb) {
    const snapshot = page.machineView({ includeClosed: options.all, limit: 50 });
    page.format({ records: snapshot.records.map(row => ({ ...row, verbatim: row.words })),
      note: page.NOT_A_BOUNDARY }).forEach(hostPageLine);
    return;
  }
  const text = words.join(' ');
  if (!['add', 'answer', 'decline', 'done', 'remove'].includes(verb)) throw new Error('Use ledger add, answer, decline, done or remove.');
  if (verb === 'add' && id !== 'rule' && id !== 'task') throw new Error('Use ledger add rule|task <words>.');
  // The same validated, signed-intent path as ledger apply, without a revision pin.
  const { result } = page.applyPersonAction(verb === 'add'
    ? { action: `add-${id}`, words: text } : { action: verb, id, words: text });
  out(`${result.id} is now ${result.status}.`);
}

function settings(options) {
  const page = require('../src/lib/openshell-settings-page');
  const [verb, id, ...words] = options.args.slice(1);
  if (options.json || options.text) {
    if (verb && !(verb === 'get' && id && words.length === 0)) throw new Error('Use settings --json or settings get ID --json.');
    const paging = require('../src/lib/fleet-read-view').pageOptions(options, 'settings', ['settings']);
    const snapshot = require('../src/lib/fleet-settings-view').machineView({ ...paging, id: id || null });
    if (options.json) out(JSON.stringify(snapshot)); else textView('settings', snapshot, options);
    return;
  }
  if (!verb || verb === 'list') {
    const read = require('../src/lib/fleet-settings-view');
    read.format(read.machineView({ limit: 100 })).forEach(hostPageLine); return;
  }
  if (verb === 'get' && id && !words.length) {
    const read = require('../src/lib/fleet-settings-view');
    read.format(read.machineView({ id })).forEach(hostPageLine); return;
  }
  if (verb === 'set' && id && words.length) {
    const result = page.set([[id, page.parseValue(words.join(' '))]]);
    out(`${id} saved (settings revision ${result.revision}).`); return;
  }
  throw new Error('Use settings get <id> or settings set <id> <value>.');
}

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h') || !argv.length) {
    out('ToolsEnabled Fleet host mode: setup | serve | tree | ledger | settings [--state-root ABSOLUTE_PATH]');
    out('Read-only panes: ledger, settings [get ID]; add --json for versioned data.');
    out('Read-only text: <ledger|settings> --text [--width 40..240] [--surface SURFACE] [--offset N --limit 1..20]; ledger also takes --kinds R,T,A.');
    out('Person ledger actions: ledger add rule|task WORDS | answer A# WORDS | decline A#|R# [WORDS] | done T# | remove R#|T#|A# (put -- before words that begin with --).');
    out('Plugin setup: setup --plugin --workspace ABSOLUTE_PROJECT [--tier standard] [--enable-workers [--providers CLI,CLI] [--models TIER,TIER]]');
    out(runtime.HOST_WARNING); return;
  }
  if (argv.length === 1 && argv[0] === '--version') { out(require('../package.json').version); return; }
  const options = parseArgs(argv);
  if (options.json && options.text) throw new Error('Choose --json or --text.');
  if ((options.width || options.surface) && !options.text) throw new Error('--width and --surface require --text.');
  if (!['setup', 'serve', 'tree', 'ledger', 'settings'].includes(options.args[0])) throw new Error(`Unknown command ${options.args[0]}.`);
  if ((options.watch || options.jsonLines) && options.args[0] !== 'tree') throw new Error('--watch and --json-lines are only for tree.');
  if (options.jsonLines && !options.watch) throw new Error('--json-lines needs --watch.');
  if (options.watch && options.json) throw new Error('Use --json-lines with --watch, not --json.');
  runtime.requireHostEnvironment();
  if (options.args[0] === 'ledger' && (options.json || options.text)) {
    // A read-only ledger page must never initialize a host installation.
    // Validate the host binding; only an absent ledger inside a configured
    // state root is an empty page. A mistyped root still needs setup.
    const config = runtime.readHostConfig(options.stateRoot, { setupKind: options.plugin ? 'plugin' : null });
    const page = require('../src/lib/openshell-ledger-page');
    const pageOptions = page.machineOptions(options, 'ledger');
    readOnlyHostEnvironment(config);
    const snapshot = page.machineView(pageOptions);
    if (options.json) out(JSON.stringify(snapshot)); else textView('ledger', snapshot, options);
    return;
  }
  if (options.args[0] === 'settings' && options.args[1] !== 'set') {
    readOnlyHostEnvironment(runtime.readHostConfig(options.stateRoot, { setupKind: options.plugin ? 'plugin' : null }));
    settings(options);
    return;
  }
  if (options.plugin && options.args[0] === 'setup') {
    if (options.args.length !== 1 || !options.workspace || options.actor) {
      throw new Error('Plugin setup requires setup --plugin --workspace ABSOLUTE_PROJECT [--tier standard] [--enable-workers [--providers CLI,CLI] [--models TIER,TIER]].');
    }
    out(JSON.stringify(runtime.setupPluginHost({ stateRoot: options.stateRoot,
      workspace: options.workspace, tier: options.tier || 'standard', workers: Boolean(options.enableWorkers),
      providers: options.providers ? options.providers.split(',') : null,
      models: options.models ? options.models.split(',') : null })));
    return;
  }
  if (options.workspace || options.tier || options.enableWorkers || options.providers || options.models) throw new Error('These setup choices require --plugin.');
  const config = runtime.readHostConfig(options.stateRoot, { setupKind: options.plugin ? 'plugin' : null });
  if (options.plugin && config.setupKind !== 'plugin') throw new Error('HOST_CONFIG_INVALID: This state is not a Fleet plugin setup.');
  if (options.args[0] === 'setup') {
    runtime.setupHost(config);
    out('ToolsEnabled Fleet host mode initialized.'); out(runtime.HOST_WARNING);
    out(config.workers ? runtime.WORKER_WARNING : 'Workers are off.'); return;
  }
  if (options.args[0] === 'serve') { await runtime.serveHost(config, { actor: options.actor }); return; }
  const command = options.args[0];
  const readOnly = command === 'tree'
    || command === 'ledger' && options.args.length === 1
    || command === 'settings' && (options.args.length === 1 || options.args[1] === 'list'
      || options.args[1] === 'get' && options.args.length === 3);
  if (readOnly) readOnlyHostEnvironment(config);
  else runtime.configureHost(config, { actor: options.actor });
  if (options.args[0] === 'ledger') ledger(options);
  else if (options.args[0] === 'settings') settings(options);
  else {
    const store = require('../src/lib/openshell-tree-store');
    const readTrees = () => store.listTrees(path.join(config.stateRoot, 'workers'));
    if (options.watch) {
      await require('../src/lib/fleet-tree-watch').watchTrees({ readTrees, jsonLines: options.jsonLines });
      return;
    }
    const trees = readTrees();
    if (options.json) out(JSON.stringify(require('../src/lib/fleet-tree-view').projectTrees(trees), null, 2));
    else store.formatTrees(trees).forEach(out);
  }
}

if (require.main === module) main(process.argv.slice(2)).catch(error => {
  process.stderr.write(`${require('../src/lib/terminal-safe-text').terminalSafeText(String(error.message))}\n`); process.exitCode = 1;
});

module.exports = { main, parseArgs };
