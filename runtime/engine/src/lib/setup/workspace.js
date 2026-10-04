'use strict';

// THE WORKSPACE -- the folder the assistant is allowed to work in.
//
// TWO REFUSALS, BOTH MECHANICAL.
//
// The first: a workspace that resolves inside the ToolsEnabled install tree is
// refused, so the product cannot be pointed at its own source. An assistant
// asked to "clean up this folder" inside the installation would be editing the
// code that is running it.
//
// The second: a workspace at the root of a drive, at the user profile root, or
// on a network share is refused as well. Pointing an assistant at the user
// profile root itself would hand it every file the person owns.

const os = require('node:os');
const path = require('node:path');

function isInside(candidate, container) {
  const relative = path.relative(path.resolve(container), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Would this folder be a safe place to let an assistant work?
 *
 * Returns a typed refusal rather than a boolean, because every refusal here has
 * to be explainable to the person who chose the folder. "That folder cannot be
 * used" with no reason is the shape that makes someone pick a worse one.
 */
function checkWorkspaceCandidate(candidate, { installRoot, env = process.env, homedir = os.homedir } = {}) {
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    return { ok: false, code: 'SETUP_WORKSPACE_MISSING', message: 'Choose a folder for your assistant to work in.' };
  }
  const resolved = path.resolve(candidate);

  if (resolved.startsWith('\\\\')) {
    return {
      ok: false,
      code: 'SETUP_WORKSPACE_NETWORK_REFUSED',
      message: 'That folder is on another computer over the network. Choose a folder on this computer.',
      resolved
    };
  }
  if (path.parse(resolved).root === resolved) {
    return {
      ok: false,
      code: 'SETUP_WORKSPACE_DRIVE_ROOT_REFUSED',
      message: 'That is the top of a whole drive. Choose a folder inside it instead.',
      resolved
    };
  }
  const home = typeof env.USERPROFILE === 'string' && env.USERPROFILE !== '' ? env.USERPROFILE : homedir();
  if (path.resolve(home) === resolved) {
    return {
      ok: false,
      code: 'SETUP_WORKSPACE_PROFILE_ROOT_REFUSED',
      message: 'That is your whole user folder. Choose one folder inside it, such as Documents.',
      resolved
    };
  }
  if (typeof installRoot === 'string' && isInside(resolved, installRoot)) {
    return {
      ok: false,
      code: 'SETUP_WORKSPACE_INSIDE_INSTALL_REFUSED',
      message: 'That folder is part of this program itself. Choose a folder of your own, such as Documents.',
      resolved
    };
  }
  return { ok: true, resolved };
}

module.exports = Object.freeze({
  checkWorkspaceCandidate,
  isInside
});
