# ToolsEnabled Fleet: privacy

This statement covers the ToolsEnabled Fleet plugin. It does not describe other ToolsEnabled products or the privacy practices of any AI provider.

## Data kept on your computer

Fleet keeps its setup choices, tasks, ledger records, memory, search index, subagent records, conversation history of the subagents it starts, settings, a copy of Codex's model list for each Codex subagent, the computer's hostname in a machine record and, with audit on, its signed audit log and the log's signing key in its private state folder, `~/.toolsenabled-fleet-plugin` by default (or the folder you set in `TOOLSENABLED_FLEET_STATE_ROOT`). These records can contain prompts, file excerpts, tool arguments and results, and anything you or an agent choose to save. Every agent connected to the same Fleet setup can read them. Local logs can include paths and error details; check them before sharing.

Claude Code's plugin data folder (or, without one, Fleet's state folder) holds the ID, not the words, of a standing rule you just added until your next message, and a change waiting for your one-time code, with only a digest of the code. Fleet also makes private socket folders for its subagent tree, `$XDG_RUNTIME_DIR/tef/<hash>/` or `/tmp/tef-<uid>/<hash>/`; they are temporary.

With audit off, the default, Fleet keeps no audit record: no signing key, nothing signed. With audit on, it signs a record of the file reads and writes, commands, ledger changes, task and memory changes, and subagent starts, stops, resumes, restarts and removals it makes; messages sent between subagents and read-only calls, such as reading tasks, memory or the ledger, are not recorded. If an earlier Fleet 1.6 kept your audit key in the login keyring, Fleet never reads that keyring. The first time audit is used with audit on, Fleet moves the earlier history to `audit-history-keyring-<id>` in Fleet's state folder, with its files read-only, and starts a new signed history. Deleting the state folder deletes it too, and `rm -rf` of the state folder works. The old keyring entries stay in your keyring, and you can delete them there.

The agent CLIs Fleet starts as subagents also keep their own session history, in their own folders (for example `~/.claude` for the Claude Code CLI and `~/.codex` for the Codex CLI), as they do for any session you run.

## What Fleet sends

Fleet sends nothing to ToolsEnabled. It has no telemetry, no crash reporting and no ToolsEnabled account or hosted service. Fleet's search runs on your computer.

The agent CLIs Fleet starts as subagents (the Claude Code CLI or the Codex CLI) communicate with their own providers under your own sign-in. They can send prompts, tool results and file content to those providers under your account and the providers' terms. Subagents use each CLI's own sign-in as your terminal does: its saved login, or the provider variables in your environment (an API key, Amazon Bedrock, Google Vertex AI, Microsoft Foundry and others). Fleet passes these variables through unchanged and never saves them; it uses their values only to blank them out of error output. Claude Code subagents do not load your settings files, so a sign-in set there (`apiKeyHelper`, or an `env` block in `settings.json`) is not used. Shell commands inside a Codex subagent see only core environment variables (home, user, shell, PATH and the temporary folder); Claude Code subagents have no shell. During setup, Fleet runs each installed agent CLI's own sign-in status command (and, for Codex, a sandbox check that runs `/bin/true` with no model call), with the same environment subagents get, and uses only whether they succeeded and whether Codex's sandbox reported that it could not start; that CLI may contact its provider to check, as it does when you run the command yourself. These checks run again on their own after an update and when you change providers or models.

Subagent reports are written under `.fleet/reports/` in your project folder.

Fleet's prompt hook receives each prompt in a session where the plugin is on, only to recognize `/tefleet ledger`, `/tefleet settings` and `/tefleet confirm`, which Fleet applies itself without sending them to Claude. It keeps nothing else, except a change waiting for your code, with only a digest of the code, for 5 minutes (in Claude Code's plugin data folder or Fleet's state folder). It does not send other prompts anywhere; a ledger command's words are saved in your ledger, and a settings change in Fleet's settings, in Fleet's state folder. At the start of each session in Fleet's project, the hook reads your open standing rules from that ledger and gives them to Claude (Fleet also gives them to every subagent it starts), and the ID of a rule you just added is held until your next message carries that rule to Claude.

Fleet's tool hook (`schedule-guard.js`) reads CronCreate, CronUpdate, ScheduleWakeup, RemoteTrigger and SendMessage calls only to refuse a `/tefleet` command in them; it keeps nothing.

## Removing data

Uninstalling the plugin keeps Fleet's state folder. Delete that folder yourself to remove Fleet's records, including any moved audit history; `rm -rf` of the state folder works. The old Fleet 1.6 keyring entries stay in your keyring until you delete them there. The agent CLIs' own session history for subagents stays in those CLIs' folders; manage or delete it with each CLI. Removing Fleet does not delete anything already sent to a provider; that is governed by the provider's own terms and settings.

## Contact

Questions or security concerns: support@toolsenabled.ai, or [GitHub issues](https://github.com/ToolsEnabled/toolsenabled-fleet-claude-plugin/issues) for anything that is not sensitive.
