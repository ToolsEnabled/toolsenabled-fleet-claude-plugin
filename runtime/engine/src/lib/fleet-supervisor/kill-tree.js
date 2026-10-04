'use strict';

// Terminate a timed-out child process AND its descendants.
//
// WHY THIS EXISTS. A bare `child.kill('SIGTERM')` that resolves immediately
// leaves the provider CLI's own subprocess tree alive, consuming CPU for as
// long as it pleases, and a child that ignores SIGTERM is never escalated.
// This module is the shared version, so callers (codex-process.js and
// claude-cli-process.js) cannot drift apart.
//
// Best effort by design: the caller has already decided the work is dead and
// must not block its own timeout path on the kill's outcome. Every failure
// path here is swallowed on purpose — there is nothing useful a timed-out
// caller can do about "the kill failed", and the alternative (throwing out of
// a setTimeout callback) would crash the supervisor.
//
// On Windows, `taskkill /PID <pid> /T /F` runs FIRST, while the pid can still
// be resolved: against a pid that no longer exists it answers "not found" and
// performs no tree walk at all, so killing the direct child first would leave
// every grandchild alive, silently. taskkill kills the named process AND its
// tree in one call, which is why the child.kill() fallback below only fires if
// taskkill itself could not be started at all.
const { spawn } = require('node:child_process');

const POSIX_ESCALATION_GRACE_MS = 5_000;

function killProcessTree(child) {
  if (!child || typeof child.kill !== 'function') return;
  if (!Number.isSafeInteger(child.pid)) {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    return;
  }

  if (process.platform === 'win32') {
    // taskkill /T walks the descendant tree and kills the named pid itself
    // in the same call, so no separate child.kill() runs ahead of it on the
    // success path -- see the module header for why running one first
    // silently defeated the tree walk.
    try {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
        shell: false
      });
      killer.on('error', () => {
        // taskkill missing or refused to even start: fall back to the direct
        // kill so the immediate child is still addressed, best effort, even
        // though its own tree could not be reached this way.
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
      });
      if (typeof killer.unref === 'function') killer.unref();
    } catch {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
    }
    return;
  }

  try { child.kill('SIGTERM'); } catch { /* already gone */ }

  // POSIX: give SIGTERM a bounded grace, then hard-kill if the child ignored
  // it. unref'd so a successful earlier exit never holds the event loop.
  const escalate = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch { /* exited during the grace */ }
  }, POSIX_ESCALATION_GRACE_MS);
  if (typeof escalate.unref === 'function') escalate.unref();
  child.once('close', () => clearTimeout(escalate));
}

module.exports = { killProcessTree, POSIX_ESCALATION_GRACE_MS };
