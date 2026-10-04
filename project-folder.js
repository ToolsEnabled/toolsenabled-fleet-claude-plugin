'use strict';
// Fleet serves one project folder and its subfolders. These say which folder a
// Claude Code session works in and whether that is Fleet's project.
const fs = require('node:fs');
const path = require('node:path');

function real(folder) {
  const resolved = path.resolve(folder);
  try { return fs.realpathSync(resolved); } catch { return resolved; }
}
function projectFolder(env = process.env, cwd = process.cwd()) {
  return real(env.CLAUDE_PROJECT_DIR || cwd);
}
function inside(folder, workspace) {
  const relative = path.relative(real(workspace), real(folder));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
// Fleet's saved setup, read without starting the engine: the project and the
// subagent choices. Null when Fleet is not set up or the record is not a
// private file of this account.
function savedSetup(stateRoot) {
  let fd;
  try {
    fd = fs.openSync(path.join(stateRoot, 'host-mode.json'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.size > 16384) return null;
    const saved = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (!saved || typeof saved.workspace !== 'string' || !path.isAbsolute(saved.workspace)) return null;
    return Object.freeze({ workspace: saved.workspace, workers: saved.workers === true,
      providers: Array.isArray(saved.providers) ? [...saved.providers] : null,
      models: Array.isArray(saved.models) ? [...saved.models] : null });
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}
// The project in Fleet's saved setup; null when Fleet is not set up.
function savedWorkspace(stateRoot) {
  const saved = savedSetup(stateRoot);
  return saved ? saved.workspace : null;
}

module.exports = { real, projectFolder, inside, savedSetup, savedWorkspace };
