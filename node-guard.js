'use strict';
// Which Node.js runs Fleet. Claude Code starts Fleet's scripts with the `node`
// it finds on PATH, as the plugin directory requires. A Node.js inside Fleet's
// project, or in a temporary folder, is one that a subagent or another program
// could replace, and every Fleet process after that would run the replacement
// outside any sandbox. Fleet refuses to run under such a Node.js and says why.
//
// This cannot stop a program planted as `node` ahead of the real one on PATH:
// that program never runs this check. It catches a real Node.js kept where it
// could be changed, before anything is changed.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function resolved(file) {
  try { return fs.realpathSync(file); } catch { return path.resolve(file); }
}
function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
// The `node` a shell would start for this PATH, as written on PATH, or null.
// An empty or relative entry means the working folder, as it does to a shell.
function pathNode(env = process.env, cwd = process.cwd()) {
  for (const entry of String(env.PATH || '').split(path.delimiter)) {
    const file = path.join(path.resolve(cwd, entry || '.'), 'node');
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return file;
    } catch { /* not in this folder */ }
  }
  return null;
}
// Folders Fleet will not run a Node.js from: the project folders named (Fleet's
// project, where subagents write) and the temporary folders.
function unsafeRoots(env, workspaces) {
  const roots = [...workspaces, '/tmp', '/var/tmp', '/dev/shm', os.tmpdir(), env.TMPDIR, env.TMP, env.TEMP]
    .filter(root => typeof root === 'string' && path.isAbsolute(root))
    .map(root => path.resolve(root))
    .filter(root => root !== path.parse(root).root);
  return [...new Set(roots.flatMap(root => [root, resolved(root)]))];
}
// Why Fleet will not run under this Node.js, or null. Both the Node.js running
// now and the one PATH names are checked, each where PATH lists it and where it
// really is.
function nodeRefusal({ env = process.env, cwd = process.cwd(), execPath = process.execPath, workspaces = [] } = {}) {
  const roots = unsafeRoots(env, workspaces);
  for (const file of [execPath, pathNode(env, cwd)]) {
    if (typeof file !== 'string' || !path.isAbsolute(file)) continue;
    for (const spelling of [path.resolve(file), resolved(file)]) {
      const root = roots.find(folder => within(folder, spelling));
      if (root) {
        return `Fleet will not run with the Node.js at ${file}, because it is inside ${root}, a folder that Fleet's subagents or other programs can change. `
          + 'Put a Node.js from outside that folder first on your PATH (for example /usr/bin/node), then restart Claude Code.';
      }
    }
  }
  return null;
}
// Fleet's project from its saved setup, read without starting the engine.
function savedWorkspaces(env = process.env) {
  try {
    const { resolveConfig } = require('./runtime-config');
    const { savedWorkspace } = require('./project-folder');
    const workspace = savedWorkspace(resolveConfig(env).stateRoot);
    return workspace ? [workspace] : [];
  } catch { return []; }
}
// Throws with the reason when Fleet must not run under this Node.js.
function assertSafeNode({ env = process.env, cwd = process.cwd(), workspaces = [] } = {}) {
  const refusal = nodeRefusal({ env, cwd, workspaces: [...workspaces, ...savedWorkspaces(env)] });
  if (refusal) throw Object.assign(new Error(refusal), { code: 'FLEET_NODE_UNSAFE' });
}

module.exports = { nodeRefusal, assertSafeNode, savedWorkspaces, pathNode };
