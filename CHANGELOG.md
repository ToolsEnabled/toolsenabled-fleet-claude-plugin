# Changelog

Release notes for every version, with how each was tested, are on the
[releases page](https://github.com/ToolsEnabled/toolsenabled-fleet-claude-plugin/releases).

## 1.11.3 (2026-10-13)

Documentation only. The plugin's code and its bundled engine work as in 1.11.2; only the version number changes in
the files that carry it.

- README, "What Fleet runs, writes and sends": typing `/fleet setup` runs each installed agent CLI's sign-in check
  right away, before the pane opens and before you choose Set up Fleet or Cancel, and those checks may contact the
  CLI's provider. The README lists the checks and the environment they run with.
- README, "The panes": the one value the mod keeps, `toolsenabled-fleet.snapshot` in Claude Code's state for the
  session, what it holds, and that the mod saves nothing to disk.
- README, "Ledger": standing rules are passed on the command line of Claude Code and Codex subagents, so another
  account on the same computer could read them from the process list, as PRIVACY.md says.
- This changelog.
