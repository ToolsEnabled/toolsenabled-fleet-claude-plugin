# Changelog

Release notes for every version, with how each was tested, are on the
[releases page](https://github.com/ToolsEnabled/toolsenabled-fleet-claude-plugin/releases).

## 1.11.4 (2026-10-14)

Fixes in the plugin and its bundled engine. The documentation changes prepared as 1.11.3 ship here; 1.11.3 was not released separately.

- A large answer no longer stops Fleet. Reading a file of a few hundred kilobytes with `host.read_file` (about 450 KB
  of JavaScript, or about 330 KB of a quote-heavy file such as `package-lock.json`), well under its 2 MiB limit, made
  one answer longer than the session bridge allowed, and the bridge stopped Fleet's engine: Claude
  Code lost Fleet's tools and every running subagent was interrupted. Any answer `host.read_file` can give now passes.
  An answer too long even for that, or a request over Fleet's 1 MiB request limit, fails only its own call, with a
  message that says why; Fleet and its subagents keep running.
- Fleet's file tools keep a file's permission bits. Fleet keeps its own state private with umask 077, and that umask
  also narrowed the files `host.write_file` and `host.patch_file` wrote: a patched 0755 script became 0700 and a
  rewritten 0644 page 0600. A replaced file now keeps its own permission bits, and a new file or folder gets the ones
  your umask gives. Subagent CLIs still start with Fleet's umask 077.
- A file that is not UTF-8 is no longer corrupted by a whole-file write. `host.read_file` shows each byte that is not
  UTF-8 as U+FFFD; it now says so with `lossy: true`, and `host.write_file` refuses to replace such a file instead of
  writing U+FFFD over those bytes. `host.patch_file` still changes its text and keeps every other byte.
- `/fleet setup` gives the agent CLIs' sign-in checks and setup four minutes instead of 30 seconds, so a slow agent
  CLI no longer makes setup fail every time.
- `/tefleet settings providers` and `/tefleet settings models` run setup's sign-in check with the sign-in variables a
  subagent gets, as `/fleet setup` does. A sign-in kept only in a variable such as `ANTHROPIC_API_KEY` no longer
  counts as signed out there.
- Sessions still running from before a plugin update keep following the subagent limits you set with
  `/tefleet settings`, including turning subagents off.
- The reply to a new standing rule past the limit (your first 40 rules, at most 6000 characters, 500 of each) says
  it is not given to new sessions and subagents and how to make room, instead of saying they would read it.
- README, "What Fleet runs, writes and sends": typing `/fleet setup` runs each installed agent CLI's sign-in check
  right away, before the pane opens and before you choose Set up Fleet or Cancel, and those checks may contact the
  CLI's provider. The README lists the checks and the environment they run with.
- README, "The panes": the one value the mod keeps, `toolsenabled-fleet.snapshot` in Claude Code's state for the
  session, what it holds, and that the mod saves nothing to disk.
- README, "Ledger": standing rules are passed on the command line of Claude Code and Codex subagents, so another
  account on the same computer could read them from the process list, as PRIVACY.md says.
- README, "Ledger": the limit on the standing rules sessions and subagents are given. README, "Sign-ins and
  environment": which of Fleet's processes pass the sign-in variables on now names the settings program, for setup
  only.
- This changelog.
