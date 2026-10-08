# ToolsEnabled Fleet

Fleet is a plugin that runs in Claude Code on Linux x86_64. It gives your Claude Code session a team: subagents that keep working in parallel, a shared task list, a ledger of your standing rules and open questions, and memory that every agent in the project can read. Subagents are real, separate agent sessions that you can watch, stop and resume, also in a later Claude Code session: they stop when your session ends and keep their conversations.

## Requirements

- Linux x86_64 (for example Ubuntu or Debian). macOS and Windows are not supported.
- Claude Code, in the terminal or the Code tab of the Claude desktop app. Fleet works only in Claude Code; other Claude surfaces do not run it.
- Node.js 22.19 or newer on your PATH, not inside your project or a temporary folder (Fleet refuses to run under one there), and Python 3 at `/usr/bin/python3`. Keep Node.js on a current release of its line: newer 22.x releases carry security fixes.
- A project folder inside your home folder.
- For subagents: Linux 5.3 or newer, plus at least one supported agent CLI installed on this computer: Claude Code (`claude`), Codex (`codex`) or OpenCode (`opencode`). Fleet starts each one it finds on your PATH, and setup turns on only the ones that pass its checks (see [Set up](#set-up)). A subagent gets its answers through the CLI's own saved login or provider configuration (see [Sign-ins and environment](#sign-ins-and-environment)).
- For the `/fleet` and `/ledger` panes: Claude Code 2.1.287 or newer in a terminal. Fleet's tools and commands work in the desktop app; the panes are tested in the terminal. Where the panes do not load, Fleet's tools and `/tefleet` commands still work.

## Set up

1. Install the plugin: run `claude plugin marketplace add ToolsEnabled/toolsenabled-fleet-claude-plugin`, then `claude plugin install toolsenabled-fleet@toolsenabled` (or, inside Claude Code, `/plugin marketplace add ToolsEnabled/toolsenabled-fleet-claude-plugin` and `/plugin install toolsenabled-fleet@toolsenabled`).
2. Open a project folder inside your home folder in Claude Code (not the home folder itself) and type `/tefleet setup`. Claude Code asks you to approve the `fleet_setup` tool and shows the project folder it will use.
3. Fleet's tools appear in the same session a few seconds later.

Setup accepts only the folder this session works in, or a folder above it inside your home folder, and it never creates a folder. It refuses version-control, CI, git-hook, package (`node_modules`), Python environment (`.venv`, `venv`), editor and dev-container folders, Claude Code, Codex and OpenCode settings folders, dot folders in your home folder (such as `~/.config`) and `~/bin`, and any folder on your PATH or inside one.

Setup turns on subagents for every supported agent CLI on your PATH that passes its checks. For each CLI it runs the checks in the table under [Permissions Fleet gives subagents](#permissions-fleet-gives-subagents): the CLI's own sign-in status command, run the way a subagent starts it (for a CLI that speaks the Agent Client Protocol, the protocol's `initialize` request instead, with no model call), and, where the CLI runs subagents in its own operating-system sandbox, a check that the sandbox starts. A CLI that is installed but fails a check is left off, and setup names the command or page that fixes it; do that, run setup again and start a new session. To choose which CLIs subagents use, name them: `/tefleet setup claude`, `/tefleet setup codex` or `/tefleet setup opencode`.

Fleet works in one project at a time (and its subfolders). In any other project its tools are not offered, so nothing there acts on your set-up project; Fleet says which project it is set up for, and `/tefleet setup` moves it, bringing your ledger and memory along. After the move, the old session stops offering Fleet's tools, and subagents still running from the old project can no longer read or write files; start new ones in the new project. After a plugin update, Fleet reconnects to the project you already set up on its own.

## Example prompts

Fleet starts subagents only when you ask for them. To the brief of each subagent you ask for, Fleet adds rules for working inside the project and for reporting. For example:

- "Start two subagents: one reviews `src/auth` for security problems, the other writes tests for it. Wait for both reports and summarize them."
- "Have one subagent from each installed agent CLI propose a fix for the failing test in `tests/parser.test.js`, then compare their answers."
- "Add a task to the Fleet ledger to update the changelog before the release, and check the ledger for questions I have not answered yet."

## Settings

Type `/tefleet settings` to see them, or name what to change. Fleet applies the change itself from what you type, without sending it to Claude (see [Typed commands and the one-time code](#typed-commands-and-the-one-time-code)):

- **Depth:** levels of subagents below your session (default 3), for example `/tefleet settings depth 2`.
- **Width:** subagents each agent may have running at once (default 4), for example `/tefleet settings width 3`. Depth and width are upper limits, not targets: with the defaults, up to 84 subagents could run at once (4, then 16, then 64), each a separate agent CLI session under your sign-in. Lower them to keep fan-out small.
- **Providers:** which agent CLIs subagents may use, for example `/tefleet settings providers claude`, `/tefleet settings providers codex` or `/tefleet settings providers opencode`.
- **Models:** which models subagents may use, for example `/tefleet settings models <name> <name>`; `/tefleet settings` lists the names. A list limits only the providers it names; `models all` removes it.
- **Audit:** off by default. Off means Fleet keeps no audit record: no signing key, nothing signed. `/tefleet settings audit on` makes Fleet sign a record of the reads and writes of Fleet's own file tools, ledger changes, task and memory changes, and subagent starts, stops, resumes, restarts and removals it makes, and refuse any of them it cannot record; Fleet's audit tools then appear in new sessions. File changes a CLI makes with its own tools are not recorded, because they do not go through Fleet; the table under [Permissions Fleet gives subagents](#permissions-fleet-gives-subagents) says which CLIs those are. Messages sent between subagents and read-only calls, such as reading tasks, memory or the ledger, are not recorded. `/tefleet settings audit off` turns it off again and keeps the records already made.

Depth and width apply to the next subagent started, resumed or restarted. Provider and model changes run setup's sign-in and sandbox checks again and apply right away, including to resumed and restarted subagents. Turning subagents off stops new starts in open sessions. Claude can show Fleet's settings with its read-only `fleet_settings` tool but cannot change them.

## Ledger

Fleet keeps a ledger that every agent in the project reads: your standing rules, tasks, and questions agents leave for you. Only you add standing rules, so a file an agent reads cannot plant a permanent instruction. Type:

- `/tefleet ledger rule never push to main`: add a standing rule.
- `/tefleet ledger task review the release notes`: add a task.
- `/tefleet ledger answer A3 yes, ship it`: answer a question an agent filed.
- `/tefleet ledger done T2`, `decline A4` or `remove R1`: close an item.
- `/tefleet ledger`: show what is open, 20 items at a time. `/tefleet ledger page 2` shows the next page, and `/tefleet ledger all` (or `/tefleet ledger all page 2`) includes closed items.

These are handled by a small hook from the plugin, without sending your words to Claude. Your standing rules reach every subagent Fleet starts and every new Claude Code session in Fleet's project, and a rule you add reaches the current session with your next message. They reach a subagent outside its task text, through its CLI's own instruction channel (see the table under [Permissions Fleet gives subagents](#permissions-fleet-gives-subagents)); a resumed subagent gets your current rules with its next message. If Fleet cannot read your ledger, it starts no subagent. When agents read the ledger with Fleet's `ledger.read` tool, items you filed show as filed by `person`.

## Typed commands and the one-time code

Fleet applies `/tefleet ledger`, `/tefleet settings` and `/tefleet confirm` changes at once when Claude Code reports that you typed the command at its prompt. If the hook cannot tell (for example a prompt sent by a scheduled task, `/loop` or another session), Fleet changes nothing and shows you a six-digit code. Type `/tefleet confirm <code>` within 5 minutes, in the same session, to make the change, or ignore it. Showing the ledger or settings needs no code.

These checks rely on Claude Code telling Fleet's hooks where a prompt came from, which Claude Code does not promise, and on the hooks running: if `node` is missing or a hook times out, the check does not run. Claude cannot schedule or forward a `/tefleet` command: Fleet refuses CronCreate, CronUpdate, ScheduleWakeup, RemoteTrigger and SendMessage calls whose prompt begins with one (Claude Code runs a command only from the start of a prompt); text that only mentions or quotes a command goes through.

The hook reads each prompt only to recognize `/tefleet ledger`, `/tefleet settings` and `/tefleet confirm`. It keeps nothing else, except a change waiting for your code, with only a digest of the code, for 5 minutes (in Claude Code's plugin data folder or Fleet's state folder).

## Sign-ins and environment

- Subagents sign in as each agent CLI does in your terminal: with its own saved login (`claude auth login`, `codex login` or `opencode auth login`), or with the sign-in variables it reads, such as an API key or token, a cloud provider's variables, or a gateway's address and token. Fleet leaves those variables in place for the agent CLIs it starts. The table below lists, for each CLI, the sign-ins its subagents can use.
- Fleet itself never writes, stores, logs or sends a sign-in value, never puts one on a command line, and never signs in for you. It holds the values only in memory, to remove the secret ones from an agent CLI's error output, messages and errors before keeping or showing them: keys, tokens, passwords and credentials, each CLI's own sign-in variables, and sign-in headers. A setting that only chooses a provider, region, profile or address is not a secret and can appear in a report, as can a value shorter than three characters.
- Each CLI then chooses its credential by its own rules, given in its own documentation. A CLI that finds both a key in your environment and a saved login may use the key, and its subagents then bill that key.
- From the agent CLIs, Fleet removes only what ties a process to your own session (its session ids, effort level and process details, messaging socket, the desktop app's sign-in refresh, IDE connection), Fleet's own internal variables, and OpenCode's configuration variables (`OPENCODE_` names other than its sign-in ones), which would replace the configuration Fleet generates for a subagent.
- Which of Fleet's processes have the variables: Claude Code starts Fleet's MCP server, its two hooks and the panes' programs with its own environment, as it does for every plugin. Fleet passes the variables on, unread, through the processes that start an agent CLI: its session runtime, setup's sign-in check and protocol probe, and its process supervisor, which receives the CLI's environment over a pipe to start it. Every other program Fleet starts for itself (process listings, audit tools, setup's other scripts) gets no sign-in variable: the provider sign-in variables, and every variable with KEY, TOKEN, SECRET, PASSWORD, PASSWD, PASSPHRASE or CREDENTIALS as a word between underscores in its name, are removed from them.
- The table below lists, for each CLI, the sign-ins its subagents can use and the configuration they load. A sign-in kept only in a settings file that a subagent does not load is not used; set it as a variable or use the CLI's own login instead.
- Setup runs each CLI's sign-in check the way a subagent starts it (the table lists each check). A CLI that fails its check is turned off, except when the check sees only a saved login: a variable or a provider in the CLI's own configuration can still sign in, so setup leaves that CLI on and says it found no saved login.

## What Fleet runs, writes and sends

- **Runs:**
  - A local MCP server from this plugin's folder, started with the `node` on your PATH.
  - Two hooks. `ledger-hook.js` handles `/tefleet ledger`, `/tefleet settings` and `/tefleet confirm` and gives each new session in Fleet's project your standing rules. `schedule-guard.js` reads CronCreate, CronUpdate, ScheduleWakeup, RemoteTrigger and SendMessage calls only to refuse one whose prompt begins with a `/tefleet` command, and keeps nothing.
  - Small Python helpers from the same folder for process control and, with audit on, the audit key.
  - During setup, each supported agent CLI's own sign-in status command and, where the CLI has its own sandbox, a command that starts that sandbox around `/bin/true` in the project (the table under [Permissions Fleet gives subagents](#permissions-fleet-gives-subagents) lists them). Fleet uses only whether they succeed and whether a sandbox reported that it could not start. These checks run again after an update and when you change providers or models.
  - The panes start `tree-entry.js` and `ledger-entry.js`, and the setup pane and setup tool start `setup-entry.js`, all from this plugin's folder. On Claude Code 2.1.287 and newer in a terminal, the plugin also loads in-process code that draws the panes and a one-line status above the prompt.
  - When you or Claude start a subagent, Fleet starts one of the agent CLIs installed on your computer in your project folder, headless, and stops it when you ask. It uses the copy of `claude`, `codex` or `opencode` that it finds on your PATH when a session starts, skipping folders inside the project and temporary folders, and runs only that copy for the session.
- **Writes:**
  - Fleet's private state folder, `~/.toolsenabled-fleet-plugin` by default (or the absolute path in `TOOLSENABLED_FLEET_STATE_ROOT`; Fleet refuses a state folder inside your project, `/tmp` or the temporary folder). It holds tasks, the ledger, memory, the search index, subagent records, settings, each subagent's generated launch settings and any per-subagent file its CLI needs (see the table under [Permissions Fleet gives subagents](#permissions-fleet-gives-subagents)), a machine record and, with audit on, the signed audit log and its signing key. The machine record holds the computer's hostname and a loopback address and port numbers that this plugin never binds or connects to.
  - Claude Code's plugin data folder (or, without one, Fleet's state folder) holds the ID, not the words, of a rule you just added until your next message, and a change waiting for your code.
  - Temporary private socket folders for the subagent tree: `$XDG_RUNTIME_DIR/tef/<hash>/` or `/tmp/tef-<uid>/<hash>/`.
  - Subagents' reports, under `.fleet/reports/` in your project. Add `.fleet/` to your `.gitignore` if you do not want to commit them.
  - The agent CLIs keep their own session history for the subagents, in their own folders (for example `~/.claude`, `~/.codex` and `~/.local/share/opencode`), as they do for any session.
  - Fleet does not edit your Claude Code settings, your Codex configuration, your OpenCode configuration or any file outside your project and the folders named here, except when an agent you direct edits files in your project.
- **The panes:** see [The panes](#the-panes) below.
- **Network:** Fleet's own code opens no network connection. The one socket it uses is a Unix socket on this computer, between a subagent's Fleet server and the server that holds the subagent tree. Web addresses in its source are documentation links that Fleet never fetches: in comments, in a help link shown to you if an agent CLI's own sandbox cannot start, and in the `$schema` lines of its JSON schemas. The loopback address and port numbers in its source are recorded in the machine record, and this plugin never binds or connects to them. The agent CLIs it starts talk to their own providers (below).
- **Sends:** nothing to ToolsEnabled. There is no telemetry and no ToolsEnabled account. Fleet's search runs on this computer. Agent CLIs that Fleet starts talk to their own providers under your own sign-in and those providers' terms.

### The panes

On Claude Code 2.1.287 and newer in a terminal, the plugin loads `hooks/register.tsx` into Claude Code (a plugin mod) to draw the `/fleet` and `/ledger` panes and a one-line status above the prompt.

- **Programs it starts:** only these, each with the `node` on your PATH:
  - `node <plugin folder>/tree-entry.js --watch --json-lines --session` reads this session's subagents from Fleet's state folder, for the `/fleet` pane and the status line.
  - `node <plugin folder>/ledger-entry.js --offset <n> --limit 20`, with `--all` and `--revision <n>` when you page, reads one page of the ledger for the `/ledger` pane.
  - `node <plugin folder>/setup-entry.js --check <project>` shows what setup would do in the `/fleet setup` pane, and `--setup <project>` sets up the project when you confirm there.
- **Environment they get:** Claude Code's own, which every program a plugin starts inherits; the mod reads no environment variable. The setup program is also told the session's working folder (`CLAUDE_PROJECT_DIR`), and runs each agent CLI's sign-in check with that environment, the way a subagent starts. The tree and ledger programs start no other program.
- **What it reads from Claude Code:** this session's working folder, Claude Code's version (the panes need 2.1.287 or newer), the session's list of tools (only to tell you when an older ToolsEnabled server is also connected), and when your own turns start and end. From a turn it reads only its id and whether it belongs to a subagent of Claude Code's own, to show a "reports ready" notice when you are idle; it never reads the text of the conversation.
- **Events it hooks:** session start and end, to start and stop watching; turn start and turn complete, as above; the `/fleet` and `/ledger` commands it adds, and no other command; closing its own ledger pane; and drawing its own panes and status line.
- **What it sends:** the panes and the tree and ledger programs send nothing; they show results only in the panes. The setup program writes Fleet's state folder and opens no network connection itself; an agent CLI's sign-in check that it runs may contact that CLI's provider, as it does when you run the check yourself.

## Permissions Fleet gives subagents

Fleet sets the permissions for the subagents it starts. The plugin always runs at the Standard level, and every agent CLI gets the same limits:

- **Files:** a subagent reads and changes files inside the project folder only. It cannot write anywhere else, including `/tmp` and `$TMPDIR`.
- **Protected paths,** denied at any depth: version-control folders, CI workflows, editor and dev-container settings, package manifests and task-runner files (such as `package.json`, `Makefile` and `pyproject.toml`), build files that run code (such as `setup.py`, `build.gradle`, `Cargo.toml`, `Gemfile` and `CMakeLists.txt`), agent instruction files such as `CLAUDE.md` and `AGENTS.md`, package-manager and interpreter startup files, project folders on your PATH, agent configuration and credential files. Common credential files in the project (`.npmrc`, `.netrc`, SSH keys, `.docker`, `.aws`, names containing `credential` and the like) cannot be read; this is a list of names, so a secret kept under another name is not covered.
- **No shell, no web tools, no approvals:** a subagent has no shell and no web or network tools of its own (the table below says how each CLI is confined), and an action that would need your approval is refused, because a background subagent cannot show you a prompt. The refusal names what was denied; you can do that action yourself in your own session.
- **Fleet's tools:** subagents get Fleet's coordination tools, such as subagents, messages, tasks, the ledger and memory. The CLIs' own subagent tools, web search and image generation are off, so a subagent starts further subagents only through Fleet, within your depth, width and model limits.
- **PATH:** subagents and the programs Fleet runs for them get your PATH without folders inside the project or temporary folders, so a subagent does not find programs in an activated virtualenv inside the project.
- Changing `/permissions` in your own session does not widen a subagent.

Each CLI reaches those limits by its own mechanism, and each keeps its own sign-in and session history:

| | Claude Code (`claude`) | Codex (`codex`) | OpenCode (`opencode`) |
| --- | --- | --- | --- |
| Setup's signed-in check | `claude --setting-sources '' --restricted auth status`, the way a subagent starts; it also sees the sign-in variables | `codex login status`; it sees only a saved login, so when it fails setup says so and leaves Codex on | `opencode acp --pure` answers the protocol's `initialize` request, with no model call; `opencode providers list` is run only to say when it has no saved login, which does not turn it off |
| Setup's sandbox check | none; Fleet confines it with launch options (below) | `codex sandbox -P :workspace -C <project> /bin/true`, no model call; on Ubuntu 24.04 and later it needs an AppArmor profile for bubblewrap, see [Codex's sandbox prerequisites](https://developers.openai.com/codex/concepts/sandboxing#prerequisites) | none; Fleet confines it with a generated configuration (below) |
| Sign in with | `claude auth login` | `codex login` | `opencode auth login` |
| Sign-ins a subagent can use | its saved login, and the sign-in variables in your environment: API key, token, OAuth token, profile, cloud provider and gateway variables. Not a sign-in kept only in your user, project or local settings file, which a subagent does not load; managed settings still apply | its saved login, and the model providers in your Codex configuration with their keys from your environment | its saved logins, the providers in your OpenCode global configuration, and the provider keys in your environment |
| How a subagent is confined | `--permission-mode dontAsk` (the only mode Fleet starts it in) and `--restricted`, without your user or project settings and without a shell; its own Read, Edit and Write tools only, under exact project path rules | its `workspace-write` sandbox limited to the project, with `/tmp` and `$TMPDIR` left out, approvals "never", network off and project-local configuration disabled; its own tools, plugins, hooks, MCP servers, connectors and browser or computer control turned off, so it changes files only through Fleet's file tools | a generated configuration that denies every tool of its own except Fleet's server (named separately for each start), approvals declined, every other MCP server and plugin switched off, and your Claude skills, `.agents` skills and project configuration switched off, so it changes files only through Fleet's file tools |
| Configuration it loads | none of your user, project or local settings files, only the settings Fleet generates for it | your Codex configuration folder (`CODEX_HOME`); project-local Codex configuration is off | your OpenCode global configuration (providers and models); its MCP servers are switched off for the subagent, and project-local OpenCode configuration and skills from `.claude`, `.opencode` and `.agents` folders are off |
| What Fleet checks before a start | the launch options above are accepted | Codex's resolved sandbox, its own listing of tools and servers, and the model list copy below; a start is refused if one does not match | what OpenCode itself reports with the generated configuration in place (`opencode debug config`, `debug agent build`, `debug skill`): every other MCP server off, every tool of its own denied, Fleet's tools allowed and no skill from outside itself; a start is refused if not |
| How standing rules reach it | in its system prompt | as its developer instructions, replacing a `developer_instructions` setting in your Codex configuration for new subagents while rules exist | in the text of each turn |
| What Fleet writes for it | its generated launch settings, in Fleet's state folder | a copy of Codex's own model list with its subagent tools turned off, in Fleet's state folder; a model Codex does not list is refused, and the copy is not refreshed from the network | its generated `opencode.json`, in Fleet's state folder |
| File changes in the audit record, when audit is on | not recorded: its own Edit and Write tools do not go through Fleet | recorded: it changes files through Fleet's file tools | recorded: it changes files through Fleet's file tools |
| Its own variables that Fleet removes | none of its sign-in variables; only the variables that tie it to your own session | none of its sign-in variables | `OPENCODE_` variables other than its sign-in ones (`OPENCODE_API_KEY`, `OPENCODE_AUTH_CONTENT`, `OPENCODE_CONSOLE_TOKEN`), because OpenCode reads inline configuration, permissions and tools from them; a launch sets the few it needs |
| Where the CLI keeps its own history | `~/.claude` | `~/.codex` | `~/.local/share/opencode` |

### OpenCode

- Support was tested with the real OpenCode CLI driven by a scripted local model, and with a real 9-billion-parameter local model that wrote a file through Fleet's file tools, had the five forbidden actions it was asked to try refused, and resumed with its conversation. A hosted model you signed in to with `opencode auth login` has not been tested.
- A local model server must give the model a context window of at least 16,000 tokens. In testing, OpenCode's prompt with Fleet's tools was about 14,000 tokens; a server that defaults to a smaller window, such as 4,096, cuts the prompt off, and the model then answers in text without calling any tool.
- A subagent changes files only when its model calls Fleet's file tools. Check what it wrote, not only what it said, especially with a small local model.
- When a turn fails, OpenCode's own provider message reaches you in the subagent's report.
- The limit on OpenCode's own tools is the set of denied tools that OpenCode itself reports before a start. A tool call from outside Fleet's server also closes the session, but only as a backstop, because the name of a call is text the agent supplies. A small model sometimes asks for one of Fleet's tools without the server's prefix; that call closes the session too, as a precaution, and the report says so. Resume the subagent to let the model try again: its conversation is kept.
- If OpenCode is slow to report its configuration, nothing starts and the message says so; try again.

Subagents run under your operating-system account. Fleet is not an operating-system sandbox, and its records can be changed by any program running as you. The plugin runs only at the Standard level; setting another level by hand is refused.

## Usage and plan limits

Every subagent Fleet starts is a separate session of an agent CLI on your own sign-in, whichever one the CLI chooses (a saved login, or an API key or cloud credential you set), and it counts against that provider's plan limits or API bill. Plan limits assume ordinary individual use. With the default depth and width, a lead can have up to 84 subagents running at once, which can use a plan up quickly. Lower `/tefleet settings width` and `depth` if you use a subscription plan. Fleet never signs in for you, never pools or switches accounts, and never resells usage.

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

- Fleet runs on Linux x86_64 only, directly on your computer; it refuses to start inside a ToolsEnabled OpenShell sandbox (where `OPENSHELL_SANDBOX` is `1`).
- If an OpenCode subagent's first turn fails with a message from OpenCode's provider, OpenCode has no model it can use for another program: run `opencode auth login` or set up a provider in OpenCode's own configuration, then start a new subagent.
- If setup says an agent CLI did not answer in time, run `/tefleet setup` again; a busy computer can be slow to start it.
- If setup says an agent CLI is ready but its subagents refuse to start with a sandbox message, the CLI's sandbox is failing now and then: run `/tefleet setup` again, and follow the CLI's own sandbox help if it keeps failing.
- If Fleet says it will not run with your Node.js, put a Node.js from outside your project and temporary folders first on your PATH (for example `/usr/bin/node`), then restart Claude Code.

## Upgrading

### From Fleet 1.10 or earlier

Agent CLIs now get your sign-in variables. Before, Fleet removed them, so a subagent could only use a CLI's saved login. If a CLI's sign-in variable is set in your environment, that CLI's subagents now use it the way the CLI does in your terminal, which can change the account they bill. Unset it before starting Claude Code if you want subagents to use the CLI's saved login.

### From Fleet 1.9 or earlier

`/tefleet settings` no longer shows or changes an Agent API mode. In every earlier version all four of its choices (Only, Optimized, Enabled and Disabled) gave subagents the same tools, so removing it changes nothing, and a choice you saved is ignored. Subagent reports now end with the same status for every agent CLI (`completed`, `interrupted` or `failed`); Claude Code subagents used to report `success` or `error`. A subagent whose agent CLI ends by itself while idle is now noticed within seconds: Fleet marks it failed and tells you in a report, and you can resume it (its conversation is kept) or restart it.

### From Fleet 1.6

If Fleet 1.6 kept your audit key in the login keyring, this version does not read it. The first time audit is used with audit on, Fleet moves the earlier history to `audit-history-keyring-<id>` in Fleet's state folder, with its files read-only, and starts a new signed history. Deleting the state folder deletes it too, and `rm -rf` of the state folder works. The old keyring entries stay in your keyring, and you can delete them there. After this version has opened Fleet's state database, Fleet 1.6 cannot open it.

### From Fleet 1.7.2 to 1.7.5

Those versions read the sign-in settings in the user settings file of the CLI that hosts Fleet and copied sign-in commands from it into the generated settings file of each subagent run by that same CLI, in Fleet's state folder. This version never reads that file. The first time it starts, it removes those copied commands from the subagent settings files Fleet generated earlier (Fleet rewrites each file at every subagent start). If a key was ever written inside such a command, treat it as exposed to the files of your own account and rotate it.

### From before Fleet 1.6.11

If you used Fleet before its memory tools reserved Fleet's own namespaces, see [RECOVERY.md](RECOVERY.md): an agent could once write Fleet's own internal state, and the honest repair is to reset that state rather than claim every forgery can be found.

## Uninstall

Close sessions that use Fleet, then uninstall the plugin from Claude Code. To delete Fleet's records too, remove `~/.toolsenabled-fleet-plugin` (or your `TOOLSENABLED_FLEET_STATE_ROOT` folder) yourself. Your project files and sign-ins are not part of Fleet's state. The agent CLIs' own session history for subagents stays in those CLIs' folders; manage it with each CLI. The old keyring entries from Fleet 1.6 stay in your keyring until you delete them there.

## Privacy, support and license

[Privacy](https://github.com/ToolsEnabled/toolsenabled-fleet-claude-plugin/blob/main/PRIVACY.md) · [Security and safe harbor](https://github.com/ToolsEnabled/toolsenabled-fleet-claude-plugin/blob/main/SECURITY.md) · Support: support@toolsenabled.ai or [GitHub issues](https://github.com/ToolsEnabled/toolsenabled-fleet-claude-plugin/issues) · MIT licensed ([LICENSE](https://github.com/ToolsEnabled/toolsenabled-fleet-claude-plugin/blob/main/LICENSE)).

ToolsEnabled is not affiliated with or endorsed by Anthropic, OpenAI or any other AI provider. Product names are used only to say which tools Fleet works with.
