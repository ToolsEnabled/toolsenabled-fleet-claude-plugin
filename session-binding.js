'use strict';
// Private process metadata binds the UI child to its own client's MCP child.
// It carries no credentials, tree state or reports and grants no tool access.
const fs = require('node:fs');
const path = require('node:path');
const DIRECTORY = 'plugin-session-bindings';

function identity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2) return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    if (fields[0] === 'Z' || !/^\d+$/.test(fields[19])) return null;
    return { pid, parent: Number(fields[1]), started: fields[19] };
  } catch (error) {
    if (['EACCES', 'EPERM'].includes(error.code)) throw error;
    return null;
  }
}
function same(a, b) {
  return a && b && a.pid === b.pid && a.started === b.started && a.parent === b.parent;
}
function ancestors(pid = process.pid, read = identity) {
  const result = [];
  for (let i = 0; i < 2 && pid > 1; i++) {
    const item = read(pid);
    if (!item || result.some(row => row.pid === item.pid)) break;
    result.push(item);
    pid = item.parent;
  }
  return result;
}
function privateStat(file, directory = false) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())
      || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
    throw new Error('Fleet status access denied: unsafe binding permissions.');
  }
  return stat;
}
function createBinding(config, runtimePid) {
  // A configured runtime already owns its state root. Never create setup state.
  if (!config.engine || !fs.existsSync(config.stateRoot)) return () => {};
  const bridge = identity(process.pid), runtime = identity(runtimePid);
  const client = bridge && identity(bridge.parent);
  if (!bridge || !runtime || !client || runtime.parent !== bridge.pid) return () => {};
  const directory = path.join(config.stateRoot, DIRECTORY);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  privateStat(directory, true);
  const file = path.join(directory, `${bridge.pid}-${bridge.started}.json`);
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, JSON.stringify({ version: 1, engine: fs.realpathSync(config.engine), client, bridge, runtime })); }
  finally { fs.closeSync(fd); }
  return () => { try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; } };
}
function selectBinding(records, lineage, engine, read = identity) {
  const matches = [];
  for (const record of records) {
    if (record?.version !== 1 || record.engine !== engine
        || !same(record.client, read(record.client?.pid))
        || !same(record.bridge, read(record.bridge?.pid))
        || !same(record.runtime, read(record.runtime?.pid))
        || record.bridge.parent !== record.client.pid || record.runtime.parent !== record.bridge.pid) continue;
    // Both entrypoints must be direct children of the same client. An outer
    // Claude process is not this session when its own MCP is still starting.
    if (same(lineage[1], record.client)) matches.push(record);
  }
  // Unsupported launcher ancestry or two MCPs sharing a client fails closed.
  return matches.length === 1 ? matches[0] : null;
}
function readBinding(config) {
  const directory = path.join(config.stateRoot, DIRECTORY);
  let names;
  try { privateStat(directory, true); names = fs.readdirSync(directory); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (names.length > 256) throw new Error('Fleet status binding limit exceeded.');
  const records = [];
  for (const name of names) {
    if (!/^[0-9]+-[0-9]+\.json$/.test(name)) continue;
    const file = path.join(directory, name);
    try {
      const stat = privateStat(file);
      if (stat.size > 4096) continue;
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const current = fs.fstatSync(fd);
        if (current.ino !== stat.ino || current.dev !== stat.dev || current.size > 4096) continue;
        records.push(JSON.parse(fs.readFileSync(fd, 'utf8')));
      } finally { fs.closeSync(fd); }
    } catch (error) {
      if (['EACCES', 'EPERM'].includes(error.code)) throw error;
      // A disappearing, partial, malformed or stale record never binds a view.
    }
  }
  return selectBinding(records, ancestors(), fs.realpathSync(config.engine));
}
async function streamSession(config, { watch = false, output = process.stdout } = {}) {
  const state = path.join(config.stateRoot, 'workers');
  const { listTrees } = require(path.join(config.engine, 'src/lib/openshell-tree-store'));
  const { projectTrees } = require(path.join(config.engine, 'src/lib/fleet-tree-view'));
  const { sessionView } = require('./session-bridge');
  let stopped = false, wake;
  const stop = () => { stopped = true; wake?.(); };
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(signal, stop);
  try {
    do {
      const binding = readBinding(config);
      const view = binding ? sessionView(listTrees(state), binding.runtime.pid, projectTrees) : projectTrees([]);
      const tree = view.trees.length === 1 ? view.trees[0] : null;
      const startedAt = tree?.nodes.find(node => node.role === 'lead')?.startedAt;
      // Heartbeats supply a fresh count after lead completion, without tool use.
      const frame = { ...view, session: tree?.live && startedAt ? { treeKey: tree.treeKey, startedAt } : null };
      output.write(JSON.stringify(frame) + '\n');
      if (watch && !stopped) await new Promise(resolve => {
        const timer = setTimeout(() => { wake = null; resolve(); }, 1000);
        wake = () => { clearTimeout(timer); wake = null; resolve(); };
      });
    } while (watch && !stopped);
  } finally {
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.removeListener(signal, stop);
  }
}
module.exports = { identity, ancestors, same, createBinding, selectBinding, readBinding, streamSession };
