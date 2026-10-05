'use strict';

// Older worker settings can contain fields that the current generator no
// longer writes. Retain only its current top-level shape before any worker is
// launched, including workers belonging to other saved project trees.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function directories(folder) {
  try {
    if (!fs.lstatSync(folder).isDirectory()) return [];
    return fs.readdirSync(folder).filter(name => {
      try { return fs.lstatSync(path.join(folder, name)).isDirectory(); } catch { return false; }
    });
  } catch { return []; }
}

function sweep(stateRoot) {
  try {
    if (typeof stateRoot !== 'string' || !path.isAbsolute(stateRoot)
        || !fs.lstatSync(stateRoot).isDirectory()) return;
    const allowed = new Set(Object.keys(require('./claude-workspace-file-tools').settings(
      'toolsenabled-fleet-host', { workspaceRoot: stateRoot, pathDirectories: [] })));
    const treeRoot = path.join(stateRoot, 'workers', 'openshell-tree');
    if (!fs.lstatSync(path.join(stateRoot, 'workers')).isDirectory()
        || !fs.lstatSync(treeRoot).isDirectory()) return;
    for (const project of directories(treeRoot)) {
      const nodes = path.join(treeRoot, project, 'nodes');
      for (const node of directories(nodes)) {
        const file = path.join(nodes, node, 'settings.json');
        let original;
        try {
          if (!fs.lstatSync(file).isFile()) continue;
          const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
          try { original = fs.readFileSync(fd, 'utf8'); } finally { fs.closeSync(fd); }
        } catch { continue; }
        let parsed;
        try { parsed = JSON.parse(original); } catch { parsed = null; }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          try { fs.unlinkSync(file); } catch { /* The next start rewrites it. */ }
          continue;
        }
        const kept = Object.fromEntries(Object.entries(parsed).filter(([key]) => allowed.has(key)));
        if (Object.keys(kept).length === Object.keys(parsed).length) continue;
        const temporary = path.join(nodes, node, `.settings-${crypto.randomBytes(12).toString('hex')}.tmp`);
        try {
          fs.writeFileSync(temporary, `${JSON.stringify(kept)}\n`, { flag: 'wx', mode: 0o600 });
          fs.chmodSync(temporary, 0o600);
          fs.renameSync(temporary, file);
        } catch { /* Keep the original if rewriting fails. */ }
        finally { try { fs.rmSync(temporary, { force: true }); } catch {} }
      }
    }
  } catch { /* Cleanup must never prevent a worker from starting. */ }
}

module.exports = { sweep };
