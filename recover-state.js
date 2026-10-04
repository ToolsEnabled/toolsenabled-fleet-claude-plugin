#!/usr/bin/env node
'use strict';
// Resets Fleet's own messaging, control and diagnostic state after an upgrade.
//
// WHY THIS EXISTS. Releases before the memory tools were fenced let an agent read
// and write Fleet's reserved namespaces in the memory table: agent-comms (the
// retained history of local messages, including the owner journal every message
// is appended to), agent-comms-control (channel membership and designation) and
// mcp.tool-surface (the instance records system.status reports). Closing that door
// does not clean the room. A row an agent forged has the same shape, revision
// mechanics and storage integrity as one Fleet wrote itself, so after the fact
// there is NOTHING that distinguishes them. Nobody can hand you a list of the bad
// ones. The only honest repair is to reset the state.
//
// SO THIS IS NOT AUTOMATIC, AND NOT A TOOL. It is a command the person runs, with
// Fleet stopped, because it destroys message history. It is deliberately not an
// MCP tool: an agent must not be able to clear the record of what it did.
//
// WHAT IS LOST: retained local message history and read cursors, channel
// membership and designation state. WHAT IS NOT: your ledger, tasks, memory,
// settings, subagent records and audit ledger all live elsewhere and are not
// touched. mcp.tool-surface rebuilds itself the next time Fleet starts.
const fs = require('node:fs');
const path = require('node:path');
const { resolveConfig, configureEnvironment } = require('./runtime-config');
const { identity } = require('./session-binding');

const BINDINGS = 'plugin-session-bindings';

// A binding file records the pids it was written for. A pid that is gone, or
// reused by a different process, is not Fleet running -- same test the status
// pane uses, so a crashed session cannot block recovery forever.
function liveSessions(stateRoot) {
  const directory = path.join(stateRoot, BINDINGS);
  let names;
  try { names = fs.readdirSync(directory); }
  catch (error) {
    // No directory means no session ever wrote one. Anything else means we cannot
    // tell, and "cannot tell" must not read as "nothing is running".
    if (error && error.code === 'ENOENT') return [];
    throw new Error(`Fleet's session records could not be read, so it is not safe to say nothing is running: ${error.message}`);
  }
  const live = [];
  for (const name of names) {
    if (!/^[0-9]+-[0-9]+\.json$/.test(name)) continue;
    let record;
    try { record = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')); }
    catch {
      // A record this cannot read is counted as live. The cost of being wrong that
      // way is a refusal the person can clear by closing sessions; the cost of the
      // other way is clearing state under a running Fleet.
      live.push(name);
      continue;
    }
    const running = ['client', 'bridge', 'runtime'].some(part => {
      const current = identity(record?.[part]?.pid);
      return current && current.started === record[part].started;
    });
    if (running) live.push(name);
  }
  return live;
}

function backup(stateDirectory) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const into = path.join(stateDirectory, `recovery-backup-${stamp}`);
  fs.mkdirSync(into, { recursive: true, mode: 0o700 });
  const copied = [];
  // The -wal and -shm files are part of the database's current contents, so a
  // backup without them is not the database you had.
  for (const name of ['toolsenabled.sqlite3', 'toolsenabled.sqlite3-wal', 'toolsenabled.sqlite3-shm']) {
    const from = path.join(stateDirectory, name);
    if (!fs.existsSync(from)) continue;
    fs.copyFileSync(from, path.join(into, name));
    fs.chmodSync(path.join(into, name), 0o600);
    copied.push(name);
  }
  if (!copied.includes('toolsenabled.sqlite3')) throw new Error(`No state database found in ${stateDirectory}.`);
  return { into, copied };
}

function main(argv = process.argv.slice(2)) {
  const unknown = argv.filter(arg => !['--reset', '--help'].includes(arg));
  if (unknown.length || argv.includes('--help')) {
    process.stdout.write('Fleet state recovery.\n'
      + '  node recover-state.js           report what Fleet\'s reserved state looks like\n'
      + '  node recover-state.js --reset   back it up, then reset it (Fleet must be stopped)\n'
      + 'See RECOVERY.md. Resetting destroys retained message history; it does not touch your\n'
      + 'ledger, tasks, memory, settings, subagent records or audit ledger.\n');
    return unknown.length ? 1 : 0;
  }
  const reset = argv.includes('--reset');
  const config = configureEnvironment(resolveConfig());
  const runtime = require(path.join(config.engine, 'src/lib/host-runtime'));
  const record = runtime.readHostConfig(config.stateRoot, { setupKind: 'plugin' });
  if (record.setupKind !== 'plugin') throw new Error('Fleet is not set up for a project here.');

  const live = liveSessions(config.stateRoot);
  if (reset && live.length) {
    throw new Error(`Fleet is running in ${live.length} session${live.length === 1 ? '' : 's'}. `
      + 'Close those Claude Code sessions and run this again: resetting state under a running '
      + 'Fleet would leave a session holding records that no longer exist.');
  }

  // The engine keeps the plugin's records under capability/, the same root the
  // ledger reader binds. Bound before the store is required so nothing resolves
  // another root.
  process.env.TOOLSENABLED_STATE_ROOT = path.join(config.stateRoot, 'capability');
  const stateDirectory = path.join(process.env.TOOLSENABLED_STATE_ROOT, 'state');
  const status = require(path.join(config.engine, 'src/lib/system-status'));
  const before = status.reservedMemoryState();
  process.stdout.write(`${JSON.stringify({ reservedMemory: before }, null, 2)}\n`);

  if (!reset) {
    process.stdout.write('\nNothing was changed. A row reported "unverifiable" is not a problem found; it is a\n'
      + 'row nobody can prove Fleet wrote. If this installation ever ran a release before the\n'
      + 'memory tools were fenced, treat it that way and run again with --reset.\n');
    return 0;
  }

  const saved = backup(stateDirectory);
  const store = require(path.join(config.engine, 'src/lib/state-store')).getStateStore();
  const cleared = {};
  for (const namespace of status.RESERVED_MEMORY) {
    cleared[namespace] = store.clearMemoryNamespace({ namespace });
  }
  process.stdout.write(`\nBacked up to ${saved.into} (${saved.copied.join(', ')}).\n`
    + `${JSON.stringify({ cleared }, null, 2)}\n`
    + '\nReset. Retained local message history, read cursors, channel membership and\n'
    + 'designation state are gone; that is what resetting means, and no part of it could be\n'
    + 'verified instead. Your ledger, tasks, memory, settings, subagent records and audit\n'
    + 'ledger were not touched. Fleet rebuilds its tool-surface record the next time it starts.\n');
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(); } catch (error) {
    process.stderr.write(`Fleet state recovery did not run: ${error.message}\n`);
    process.exitCode = 1;
  }
}
module.exports = { main, liveSessions, backup };
