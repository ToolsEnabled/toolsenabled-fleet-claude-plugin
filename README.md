# ToolsEnabled Fleet

Fleet is a plugin that runs in Claude Code on Linux x86_64. It gives your Claude Code session a team: subagents that keep working in parallel, a shared task list, a ledger of your standing rules and open questions, and memory that every agent in the project can read. Subagents are real, separate agent sessions that you can watch, stop and resume, also in a later Claude Code session: they stop when your session ends and keep their conversations.

## Requirements

- Linux x86_64 (for example Ubuntu or Debian). macOS and Windows are not supported.
- Claude Code, in the terminal or the Code tab of the Claude desktop app. Fleet works only in Claude Code; other Claude surfaces do not run it.
- Node.js 22.19 or newer on your PATH, not inside your project or a temporary folder (Fleet refuses to run under one there), and Python 3 at `/usr/bin/python3`.
- A project folder inside your home folder.
- For subagents: Linux 5.3 or newer, plus at least one supported agent CLI installed and signed in on this computer: the Claude Code CLI or the Codex CLI. Setup turns on only the CLIs that are signed in. Subagents use each CLI's own sign-in as your terminal does: its saved login, or the provider variables in your environment (an API key, Amazon Bedrock, Google Vertex AI, Microsoft Foundry and others). Fleet passes these variables through unchanged and never saves them; it uses their values only to blank them out of error output. Claude Code subagents do not load your settings files, with one exception for signing in: Fleet reads your user settings file (`settings.json` in Claude Code's configuration folder, never a project's) in memory and gives the subagent only its sign-in settings. Those are `apiKeyHelper`, `awsAuthRefresh`, `awsCredentialExport`, `gcpAuthRefresh`, `forceLoginMethod`, and the provider and endpoint variables in its `env` block (Bedrock, Vertex, Foundry, AWS and Google Cloud variables, `ANTHROPIC_*` endpoint, key and model-alias variables). The sign-in commands go into the subagent's own settings file; a key or token value goes only into the subagent's process environment, never into a file or a command line, and a variable already set in your environment wins. Only string values are used, so write `"1"`, not `1`, and a sign-in command must be a full path, a `~/` path or a bare program name, not a relative path. If Fleet cannot use your settings file it says why when a subagent starts and in setup. Setup's sign-in check runs the same way, so "signed in" means a subagent can sign in. Fleet ignores a settings file that is not yours, can be changed by others, or sits in a folder a subagent can write.
- For the `/fleet` and `/ledger` panes: Claude Code 2.1.287 or newer in a terminal. Fleet's tools and commands work in the desktop app; the panes are tested in the terminal. Where the panes do not load, Fleet's tools and `/tefleet` commands still work.

## Set up

1. Install the plugin: run `claude plugin marketplace add ToolsEnabled/toolsenabled-fleet-claude-plugin`, then `claude plugin install toolsenabled-fleet@toolsenabled` (or, inside Claude Code, `/plugin marketplace add ToolsEnabled/toolsenabled-fleet-claude-plugin` and `/plugin install toolsenabled-fleet@toolsenabled`).
2. Open a project folder inside your home folder in Claude Code (not the home folder itself) and type `/tefleet setup`. Claude Code asks you to approve the `fleet_setup` tool and shows the project folder it will use.
3. Fleet's tools appear in the same session a few seconds later.

Setup accepts only the folder this session works in, or a folder above it inside your home folder, and it never creates a folder. It refuses version-control, CI, git-hook, package (`node_modules`), Python environment (`.venv`, `venv`), editor and dev-container folders, Claude Code and Codex settings folders, dot folders in your home folder (such as `~/.config`) and `~/bin`, and any folder on your PATH or inside one.

Setup turns on subagents for every supported agent CLI on your PATH that is signed in and can run here. Its sign-in check runs with the same environment subagents get. If one is installed but not signed in, setup says which command signs it in; run it once in a terminal, run setup again and start a new session. Codex subagents also need Codex's own sandbox to start on your computer (on Ubuntu 24.04 and later this needs an AppArmor profile for bubblewrap); if it cannot, setup leaves Codex off and links Codex's instructions. To choose which CLIs subagents use, name them: `/tefleet setup claude` or `/tefleet setup codex`.

Fleet works in one project at a time (and its subfolders). In any other project its tools are not offered, so nothing there acts on your set-up project; Fleet says which project it is set up for, and `/tefleet setup` moves it, bringing your ledger and memory along. After the move, the old session stops offering Fleet's tools, and subagents still running from the old project can no longer read or write files; start new ones in the new project. After a plugin update, Fleet reconnects to the project you already set up on its own.

## Example prompts

Fleet starts subagents only when you ask for them. To the brief of each subagent you ask for, Fleet adds rules for working inside the project and for reporting. For example:

- "Start two subagents: one reviews `src/auth` for security problems, the other writes tests for it. Wait for both reports and summarize them."
- "Have a Codex subagent and a Claude subagent each propose a fix for the failing test in `tests/parser.test.js`, then compare their answers."
- "Add a task to the Fleet ledger to update the changelog before the release, and check the ledger for questions I have not answered yet."

## Settings

Type `/tefleet settings` to see them, or name what to change. Fleet applies the change itself from what you type, without sending it to Claude (see [Typed commands and the one-time code](#typed-commands-and-the-one-time-code)):

- **Depth:** levels of subagents below your session (default 3), for example `/tefleet settings depth 2`.
- **Width:** subagents each agent may have running at once (default 4), for example `/tefleet settings width 3`. Depth and width are upper limits, not targets: with the defaults, up to 84 subagents could run at once (4, then 16, then 64), each a separate agent CLI session under your sign-in. Lower them to keep fan-out small.
- **Providers:** which agent CLIs subagents may use, for example `/tefleet settings providers claude` or `/tefleet settings providers codex`.
- **Models:** which models subagents may use, for example `/tefleet settings models claude-sonnet terra`. A list limits only the providers it names; `models all` removes it.
- **Agent API mode:** which tools new subagents get. Claude Code subagents always get only Read, Edit and Write inside the project; the mode decides whether they also get Fleet's coordination tools (every mode except Disabled), never Fleet's file or search tools. Codex subagents get Fleet's tools and none of Codex's own (Only, the default), Fleet's tools and Codex's own tools (Enabled), or Codex's own tools without Fleet's (Disabled). In Enabled and Disabled, Codex's own tools and shell are available inside Codex's sandbox, with network off, and can change any project file except `.git`, `.codex` and `.agents`; those two modes are your choice and are wider than Only. Optimized currently adds nothing to Claude Code subagents, and a Codex subagent does not start under it.
- **Audit:** off by default. Off means Fleet keeps no audit record: no signing key, nothing signed. `/tefleet settings audit on` makes Fleet sign a record of the reads and writes of Fleet's own file tools, ledger changes, task and memory changes, and subagent starts, stops, resumes, restarts and removals it makes, and refuse any of them it cannot record; Fleet's audit tools then appear in new sessions. Claude Code subagents' own Read, Edit and Write and Codex's own tools are not recorded, because they do not go through Fleet. Messages sent between subagents and read-only calls, such as reading tasks, memory or the ledger, are not recorded. `/tefleet settings audit off` turns it off again and keeps the records already made.

Depth, width and the Agent API mode apply to the next subagent started, resumed or restarted. Provider and model changes run setup's sign-in and sandbox checks again and apply right away, including to resumed and restarted subagents. Turning subagents off stops new starts in open sessions. Claude can show Fleet's settings with its read-only `fleet_settings` tool but cannot change them.

## Ledger

Fleet keeps a ledger that every agent in the project reads: your standing rules, tasks, and questions agents leave for you. Only you add standing rules, so a file an agent reads cannot plant a permanent instruction. Type:

- `/tefleet ledger rule never push to main`: add a standing rule.
- `/tefleet ledger task review the release notes`: add a task.
- `/tefleet ledger answer A3 yes, ship it`: answer a question an agent filed.
- `/tefleet ledger done T2`, `decline A4` or `remove R1`: close an item.
- `/tefleet ledger`: show what is open, 20 items at a time. `/tefleet ledger page 2` shows the next page, and `/tefleet ledger all` (or `/tefleet ledger all page 2`) includes closed items.

These are handled by a small hook from the plugin, without sending your words to Claude. Your standing rules reach every subagent Fleet starts and every new Claude Code session in Fleet's project, and a rule you add reaches the current session with your next message. They reach a subagent outside its task text: in a Claude subagent's system prompt and as a Codex subagent's developer instructions. While rules exist they replace any `developer_instructions` in your Codex configuration for new Codex subagents; a resumed subagent gets your current rules with its next message. If Fleet cannot read your ledger, it starts no subagent. When agents read the ledger with Fleet's `ledger.read` tool, items you filed show as filed by `person`.

## Typed commands and the one-time code

Fleet applies `/tefleet ledger`, `/tefleet settings` and `/tefleet confirm` changes at once when Claude Code reports that you typed the command at its prompt. If the hook cannot tell (for example a prompt sent by a scheduled task, `/loop` or another session), Fleet changes nothing and shows you a six-digit code. Type `/tefleet confirm <code>` within 5 minutes, in the same session, to make the change, or ignore it. Showing the ledger or settings needs no code.

These checks rely on Claude Code telling Fleet's hooks where a prompt came from, which Claude Code does not promise, and on the hooks running: if `node` is missing or a hook times out, the check does not run. Claude cannot schedule or forward a `/tefleet` command: Fleet refuses CronCreate, CronUpdate, ScheduleWakeup, RemoteTrigger and SendMessage calls that carry one.

The hook reads each prompt only to recognize `/tefleet ledger`, `/tefleet settings` and `/tefleet confirm`. It keeps nothing else, except a change waiting for your code, with only a digest of the code, for 5 minutes (in Claude Code's plugin data folder or Fleet's state folder).

## What Fleet runs, writes and sends

- **Runs:** a local MCP server from this plugin's folder; a hook (`ledger-hook.js`) that handles `/tefleet ledger`, `/tefleet settings` and `/tefleet confirm` and gives each new session in Fleet's project your standing rules; a hook (`schedule-guard.js`) that reads CronCreate, CronUpdate, ScheduleWakeup, RemoteTrigger and SendMessage calls only to refuse a `/tefleet` command in them, and keeps nothing; and small Python helpers from the same folder for process control and, with audit on, the audit key. The `node` that the MCP server and hooks start with comes from your PATH. During setup, each supported agent CLI's own sign-in status command (`claude auth status`, `codex login status`), and for Codex a sandbox check that runs `/bin/true` inside Codex's sandbox (`codex sandbox -P :workspace`); Fleet uses only whether they succeed and whether Codex's sandbox reported that it could not start. These sign-in and sandbox checks re-run on their own after an update and when you change providers or models. The panes start `tree-entry.js` and `ledger-entry.js`, and the setup pane and setup tool start `setup-entry.js`, all from this plugin's folder. When you or Claude start a subagent, Fleet starts one of the agent CLIs installed on your computer in your project folder, headless, and stops it when you ask. It starts the `claude` and `codex` it finds on your PATH when a session starts, skipping folders inside the project and temporary folders, and runs only that copy for the session. On Claude Code 2.1.287 and newer in a terminal, the plugin also loads in-process code (a plugin mod) that draws the `/fleet` and `/ledger` panes and a one-line status above the prompt.
- **Writes:** Fleet's private state folder, `~/.toolsenabled-fleet-plugin` by default (or the absolute path in `TOOLSENABLED_FLEET_STATE_ROOT`; Fleet refuses a state folder inside your project, `/tmp` or the temporary folder): tasks, the ledger, memory, the search index, subagent records, settings, a copy of Codex's model list for each Codex subagent, the computer's hostname in a machine record and, with audit on, the signed audit log and its signing key. Each subagent's generated launch settings are written inside that folder. Claude Code's plugin data folder (or, without one, Fleet's state folder) holds the ID, not the words, of a rule you just added until your next message, and a change waiting for your code. Fleet makes private socket folders for its subagent tree, `$XDG_RUNTIME_DIR/tef/<hash>/` or `/tmp/tef-<uid>/<hash>/`; they are temporary. Subagents write their reports under `.fleet/reports/` in your project; add `.fleet/` to your `.gitignore` if you do not want to commit them. The agent CLIs keep their own session history for the subagents, in their own folders (for example `~/.claude` and `~/.codex`), as they do for any session. Fleet does not edit your Claude Code settings, your Codex configuration or any file outside your project and the folders named here, except when an agent you direct edits files in your project.
- **The plugin mod** (the `/fleet` and `/ledger` panes) starts only Fleet's own scripts from this plugin's folder: `tree-entry.js` to watch this session's subagents, `ledger-entry.js` to show the ledger and `setup-entry.js` for setup. It reads only Fleet's own state and sends nothing off your computer.
- **Network:** Fleet's own code opens no network connection. Web addresses in its source are documentation links in comments. The agent CLIs it starts talk to their own providers (below).
- **Sends:** nothing to ToolsEnabled. There is no telemetry and no ToolsEnabled account. Fleet's search runs on this computer. Agent CLIs that Fleet starts talk to their own providers under your own sign-in and those providers' terms.

## Permissions Fleet gives subagents

Fleet sets the permissions for the subagents it starts. The plugin always runs at the Standard level:

- **Claude Code subagents** start with `--permission-mode dontAsk` and `--restricted`, without your user or project settings and without a shell; dontAsk is the only mode Fleet starts them in. They read and change files only with Claude Code's own Read, Edit and Write, inside the project folder. They get Fleet's coordination tools, such as subagents, messages, tasks, the ledger and memory, but not Fleet's file or search tools. Claude Code's protected paths and Fleet's protected files are denied at any depth: version-control folders, CI workflows, editor and dev-container settings, package manifests and task-runner files (such as `package.json`, `Makefile` and `pyproject.toml`), build files that run code (such as `setup.py`, `build.gradle`, `Cargo.toml`, `Gemfile` and `CMakeLists.txt`), agent instruction files such as `CLAUDE.md` and `AGENTS.md`, package-manager and interpreter startup files, project folders on your PATH, agent configuration and credential files. Claude subagents also cannot read common credential files in the project (`.npmrc`, `.netrc`, SSH keys, `.docker`, `.aws`, names containing `credential` and the like); this is a list of names, so a secret kept under another name is not covered. Fleet's own file tools, which a Codex subagent uses in Only mode, refuse a shorter list of credential names. Any other tool or path is refused, because a background subagent cannot show you a prompt; the refusal names what was denied, and you can do that action yourself in your own session.
- **Codex subagents** run in Codex's workspace-write sandbox, limited to the project folder. Fleet does not restrict what a Codex subagent reads; the sandbox restricts only where it writes. In Enabled and Disabled, Codex's shell can read files outside the project, including Fleet's own state folder (the ledger, memory and the link tokens other subagents use), so use those modes only for work you would trust the subagent with at your own account's level. `/tmp` and `$TMPDIR` are not writable, and Fleet refuses to start a Codex subagent unless Codex confirms this. Network access is off, approvals are "never" (anything needing approval is refused), and project-local Codex configuration is disabled. Shell commands inside a Codex subagent see only core environment variables (home, user, shell, PATH and the temporary folder). In Only mode a Codex subagent has none of Codex's own tools, not even its file-editing tool, so it changes files only through Fleet's file tools, which refuse the protected paths that Claude Code subagents are denied, including `.gitmodules`, `.yarn/`, `.mvn/`, `.cargo/`, `.pnp.cjs`, `bunfig.toml` and the Gradle and Maven wrapper files. In Enabled and Disabled, which you choose and which are wider than Only, Codex's own tools and shell are available inside Codex's sandbox, with network off, and can change any project file except `.git`, `.codex` and `.agents`. MCP servers, plugins, connectors, hooks and browser or computer control from your Codex configuration run outside that sandbox, so Fleet turns them off for the subagent; Codex's own listing confirms that no other server is on before the subagent starts. Codex's own subagent tools, web search and image generation are off in every mode; a Codex subagent starts further subagents only through Fleet, within your depth, width and model limits. Fleet gives each Codex subagent a copy of Codex's own model list with Codex's subagent tools (and, in Only mode, its file-editing tool) turned off and starts it only after Codex's listing confirms the copy; a model Codex does not list is refused when the subagent starts (a model change made later is checked against your limits, not against Codex's list again), and that subagent's model list is not refreshed from the network. These settings are passed on the command line for that subagent only; your Codex configuration is not changed.
- **What subagents can write:** files inside the project folder, except the protected paths; in Enabled and Disabled, a Codex subagent's own tools can change any project file except `.git`, `.codex` and `.agents`. Neither kind can write `/tmp`, `$TMPDIR` or anything else outside the project.
- **PATH:** subagents and the programs Fleet runs for them get your PATH without folders inside the project or temporary folders, so a subagent's shell does not find programs in an activated virtualenv inside the project.
- Changing `/permissions` in your own session does not widen a subagent.

Subagents run under your operating-system account. Fleet is not an operating-system sandbox, and its records can be changed by any program running as you. The plugin runs only at the Standard level; setting another level by hand is refused.

## Usage and plan limits

Every Claude Code subagent Fleet starts is a separate Claude Code session on your own sign-in, and it counts against your plan's limits or your API bill. Anthropic's plan limits assume ordinary individual use. With the default depth and width, a lead can have up to 84 subagents running at once, which can use a plan up quickly. Lower `/tefleet settings width` and `depth` if you use a subscription plan. Fleet never signs in for you, never pools or switches accounts, and never resells usage.

## Commands

One command, `/tefleet`, works in the desktop app and the terminal. In a terminal, Claude Code 2.1.289 lists plugin commands under the plugin's name: type `/toolsenabled-fleet:tefleet` (typing `/tef` completes it) wherever this README writes `/tefleet`.


- `/tefleet` or `/tefleet status`: settings and this session's subagents.
- `/tefleet setup`: set up Fleet in this project, or move it here.
- `/tefleet settings`: show or change Fleet's settings.
- `/tefleet ledger`: show the ledger, or add or close ledger items yourself.
- `/tefleet confirm <code>`: make a change Fleet showed you a code for.

In Claude Code 2.1.287+ in a terminal, two panes open without a model request:

- `/fleet`: this session's subagents, their state and provider.
- `/ledger`: read-only view of rules, tasks and questions.

## Troubleshooting

- Fleet runs on Linux x86_64 only, directly on your computer; it refuses to start inside an OpenShell sandbox.
- If Fleet says it will not run with your Node.js, put a Node.js from outside your project and temporary folders first on your PATH (for example `/usr/bin/node`), then restart Claude Code.

## Upgrading from Fleet 1.6

If Fleet 1.6 kept your audit key in the login keyring, this version does not read it. The first time audit is used with audit on, Fleet moves the earlier history to `audit-history-keyring-<id>` in Fleet's state folder, with its files read-only, and starts a new signed history. Deleting the state folder deletes it too, and `rm -rf` of the state folder works. The old keyring entries stay in your keyring, and you can delete them there. After this version has opened Fleet's state database, Fleet 1.6 cannot open it.

## Upgrading from an earlier release

If you used Fleet before its memory tools reserved Fleet's own namespaces (before 1.6.11), see [RECOVERY.md](RECOVERY.md): an agent could once write Fleet's own internal state, and the honest repair is to reset that state rather than claim every forgery can be found.

## Uninstall

Close sessions that use Fleet, then uninstall the plugin from Claude Code. To delete Fleet's records too, remove `~/.toolsenabled-fleet-plugin` (or your `TOOLSENABLED_FLEET_STATE_ROOT` folder) yourself. Your project files and sign-ins are not part of Fleet's state. The agent CLIs' own session history for subagents stays in those CLIs' folders; manage it with each CLI. The old keyring entries from Fleet 1.6 stay in your keyring until you delete them there.

## Privacy, support and license

[Privacy](https://github.com/ToolsEnabled/toolsenabled-fleet-claude-plugin/blob/main/PRIVACY.md) · Support: support@toolsenabled.ai or [GitHub issues](https://github.com/ToolsEnabled/toolsenabled-fleet-claude-plugin/issues) · MIT licensed ([LICENSE](https://github.com/ToolsEnabled/toolsenabled-fleet-claude-plugin/blob/main/LICENSE)).

ToolsEnabled is not affiliated with or endorsed by Anthropic, OpenAI or any other AI provider. Product names are used only to say which tools Fleet works with.
