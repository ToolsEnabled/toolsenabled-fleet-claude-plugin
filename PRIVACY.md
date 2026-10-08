# ToolsEnabled Fleet: privacy

This statement covers the ToolsEnabled Fleet plugin. It does not describe other ToolsEnabled products or the privacy practices of any AI provider.

## Data kept on your computer

Fleet keeps its setup choices, tasks, ledger records, memory, search index, subagent records, conversation history of the subagents it starts, settings, launch files for each subagent (generated settings and, where its CLI needs one, a copy of that CLI's model list), the computer's hostname in a machine record and, with audit on, its signed audit log and the log's signing key in its private state folder, `~/.toolsenabled-fleet-plugin` by default (or the folder you set in `TOOLSENABLED_FLEET_STATE_ROOT`). These records can contain prompts, file excerpts, tool arguments and results, and anything you or an agent choose to save. Every agent connected to the same Fleet setup can read them.

Fleet also keeps two kinds of local diagnostic log in its state folder, under `logs/`: the error output of each Claude Code subagent (up to 256K characters per file, the newest 50 files kept, with the sign-in secrets in your environment removed; Fleet cannot recognize a secret it never sees, such as one inside a CLI's own saved login), and a short record of how each Fleet server process ended (its process details, versions, memory use, how many requests it served and the name of the last tool called, never a tool's arguments). Error output is whatever the agent CLI printed, which can include file paths and error messages. These logs never leave your computer; check them before sharing.

Claude Code's plugin data folder (or, without one, Fleet's state folder) holds the ID, not the words, of a standing rule you just added until your next message, and a change waiting for your one-time code, with only a digest of the code. Fleet also makes private socket folders for its subagent tree, `$XDG_RUNTIME_DIR/tef/<hash>/` or `/tmp/tef-<uid>/<hash>/`; they are temporary.

With audit off, the default, Fleet keeps no audit record: no signing key, nothing signed. With audit on, it signs a record of the reads and writes of Fleet's own file tools, ledger changes, task and memory changes, and subagent starts, stops, resumes, restarts and removals it makes; the agent CLIs' own file tools, which do not go through Fleet, messages sent between subagents and read-only calls, such as reading tasks, memory or the ledger, are not recorded. If an earlier Fleet 1.6 kept your audit key in the login keyring, Fleet never reads that keyring. The first time audit is used with audit on, Fleet moves the earlier history to `audit-history-keyring-<id>` in Fleet's state folder, with its files read-only, and starts a new signed history. Deleting the state folder deletes it too, and `rm -rf` of the state folder works. The old keyring entries stay in your keyring, and you can delete them there.

The agent CLIs Fleet starts as subagents also keep their own session history, in their own folders (for example `~/.claude` for the Claude Code CLI, `~/.codex` for the Codex CLI and `~/.local/share/opencode` for the OpenCode CLI), as they do for any session you run.

Fleet 1.7.2 to 1.7.5 read the sign-in settings in the user settings file of the CLI that hosts Fleet and copied sign-in commands from it into the generated settings file of each subagent run by that same CLI, in Fleet's state folder. This version never reads that file and, the first time it starts, removes those copied commands from the generated files. If a key was ever written inside such a command, treat it as exposed to the files of your own account and rotate it.

Your standing rules are also passed to each subagent on its command line, so another account on the same computer could read them from the process list unless the system hides other accounts' processes.

## What Fleet sends

Fleet sends nothing to ToolsEnabled. It has no telemetry, no crash reporting and no ToolsEnabled account or hosted service. Fleet's search runs on your computer.

The agent CLIs Fleet starts as subagents (the Claude Code CLI, the Codex CLI or the OpenCode CLI) communicate with their own providers under your own sign-in. They can send prompts, tool results and file content to those providers under your account and the providers' terms. Subagents sign in exactly as each agent CLI does in your terminal: with its own saved login, or with the sign-in variables you set for it (an API key or token, a cloud provider's variables, a gateway's address and token), which Fleet leaves in place for the agent CLIs it starts. Fleet itself never writes, stores, logs or sends a sign-in value; it holds the values only in memory, to remove the secret ones (keys, tokens, passwords, credentials and each CLI's own sign-in variables) from an agent CLI's error output, messages and errors before keeping or showing them; a setting that only chooses a provider, region, profile or address is not a secret. From the agent CLIs Fleet removes only what ties a process to your own session, Fleet's own internal variables, and OpenCode's configuration variables other than its sign-in ones. Claude Code starts Fleet's MCP server, its two hooks and the panes' programs with its own environment, as it does for every plugin, and Fleet passes the variables on, unread, through the processes that start an agent CLI (its session runtime, setup's sign-in check and protocol probe, and its process supervisor, over a pipe). Every other program Fleet starts for itself gets no sign-in variable: the provider sign-in variables, and every variable with KEY, TOKEN, SECRET, PASSWORD, PASSWD, PASSPHRASE or CREDENTIALS as a word between underscores in its name, are removed from them. A sign-in kept only in a settings file that a subagent does not load is not used: a Claude Code subagent loads none of your user, project or local settings files (managed settings still apply). Subagents have no shell. During setup, Fleet runs each installed agent CLI's own sign-in status command (and, where the CLI runs subagents in its own sandbox, a check that starts that sandbox around `/bin/true` with no model call), the way a subagent starts it, and uses only whether they succeeded and whether a sandbox reported that it could not start; that CLI may contact its provider to check, as it does when you run the command yourself. These checks run again on their own after an update and when you change providers or models.

Subagent reports are written under `.fleet/reports/` in your project folder.

Fleet's prompt hook receives each prompt in a session where the plugin is on, only to recognize `/tefleet ledger`, `/tefleet settings` and `/tefleet confirm`, which Fleet applies itself without sending them to Claude. It keeps nothing else, except a change waiting for your code, with only a digest of the code, for 5 minutes (in Claude Code's plugin data folder or Fleet's state folder). It does not send other prompts anywhere; a ledger command's words are saved in your ledger, and a settings change in Fleet's settings, in Fleet's state folder. At the start of each session in Fleet's project, the hook reads your open standing rules from that ledger and gives them to Claude (Fleet also gives them to every subagent it starts), and the ID of a rule you just added is held until your next message carries that rule to Claude.

Fleet's tool hook (`schedule-guard.js`) reads CronCreate, CronUpdate, ScheduleWakeup, RemoteTrigger and SendMessage calls only to refuse one whose prompt begins with a `/tefleet` command; it keeps nothing.

## The agent CLIs' own privacy policies

What an agent CLI sends to its provider is governed by that provider's privacy policy, not by Fleet:

- Claude Code (Anthropic): https://www.anthropic.com/legal/privacy
- Codex (OpenAI): https://openai.com/policies/ (the privacy policy for your region)
- OpenCode: https://opencode.ai/legal/privacy-policy

When an agent CLI uses a cloud provider, a gateway or a model provider that you set up for it, that provider's own privacy policy applies as well, for example:

- Amazon Web Services (Amazon Bedrock): https://aws.amazon.com/privacy/
- Google Cloud: https://cloud.google.com/terms/cloud-privacy-notice
- Microsoft (Microsoft Foundry, Azure): https://www.microsoft.com/privacy/privacystatement

For a gateway or any other provider you configure, see that provider's own policy.

## Removing data

Uninstalling the plugin keeps Fleet's state folder. Delete that folder yourself to remove Fleet's records, including any moved audit history; `rm -rf` of the state folder works. The old Fleet 1.6 keyring entries stay in your keyring until you delete them there. The agent CLIs' own session history for subagents stays in those CLIs' folders; manage or delete it with each CLI. Removing Fleet does not delete anything already sent to a provider; that is governed by the provider's own terms and settings.

## Contact

Questions: support@toolsenabled.ai, or [GitHub issues](https://github.com/ToolsEnabled/toolsenabled-fleet-claude-plugin/issues) for anything that is not sensitive. Security problems: see [SECURITY.md](SECURITY.md), which offers private reporting and a safe harbor for good-faith research.
