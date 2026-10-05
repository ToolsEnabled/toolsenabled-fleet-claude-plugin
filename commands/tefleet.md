---
description: Fleet - /tefleet setup, /tefleet settings, /tefleet ledger, /tefleet confirm, /tefleet status
argument-hint: "[setup | status | settings [<changes>] | ledger [page <n> | all | <rule|task|answer|done|decline|remove> ...] | confirm <code>]"
disable-model-invocation: true
---

The person typed `/tefleet $ARGUMENTS`. Handle it with Fleet's tools, without shell commands or file edits. If Fleet offers only `fleet_setup_status` and `fleet_setup`, Fleet is not set up for this project: handle `setup` as below, and for anything else call `fleet_setup_status` and show what it says.

- Nothing, `status` or `help`: call `fleet_settings` and `fleet_session_status`. Show Fleet's settings and the subagents in a few short lines (finished ones from earlier sessions can be resumed), then these commands as written:
  - `/tefleet setup`: set up Fleet in this project, or move it here.
  - `/tefleet settings`: show Fleet's settings, or change them, for example `/tefleet settings depth 2`; Fleet applies changes itself.
  - `/tefleet ledger`: show the ledger, 20 items at a time (`/tefleet ledger page 2`, `/tefleet ledger all`), or add a standing rule or task (`/tefleet ledger rule <words>`); Fleet files these itself.
  - `/tefleet confirm <code>`: make a change Fleet showed you a code for, within 5 minutes; Fleet asks for a code when it cannot tell that you typed the change yourself.
- `setup`, optionally followed by agent CLI names such as `claude`, `codex` or `opencode`: call `fleet_setup` once, with `workspace` set to the absolute path of the current working directory and those names as `providers` if any. Show the result as the tool returned it.
- `settings`, `ledger` or `confirm`: Fleet handles these itself, straight from what the person typed, so you should not be reading this. Do not change settings, file anything or confirm anything yourself, and do not call `fleet_settings` to make a change: it only shows them. Tell the person nothing was changed and that Fleet's plugin hooks may be turned off; with nothing after `settings`, you may show the settings with `fleet_settings`.
- Anything else: show the commands above, as written.
