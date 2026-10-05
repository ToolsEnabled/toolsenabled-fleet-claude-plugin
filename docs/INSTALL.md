# Install and manage Fleet in Claude Code

See the [README](../README.md) for requirements and for what Fleet runs, writes and sends. Fleet runs only in Claude Code on Linux x86_64; other Claude surfaces do not run it.

## Install

In Claude Code, add the ToolsEnabled marketplace and install the plugin:

```text
/plugin marketplace add ToolsEnabled/toolsenabled-fleet-claude-plugin
/plugin install toolsenabled-fleet@toolsenabled
```

Or, in a terminal:

```sh
claude plugin marketplace add ToolsEnabled/toolsenabled-fleet-claude-plugin
claude plugin install toolsenabled-fleet@toolsenabled
```

Installing creates no Fleet state and starts no subagents.

## Set up a project

Open a project folder inside your home folder in Claude Code (Fleet refuses the home folder itself) and type `/tefleet setup`. Claude asks to run the `fleet_setup` tool; the approval prompt shows the project folder. Approve it. Fleet's full tool set appears in the same session a few seconds later; no restart is needed. In Claude Code 2.1.287 or newer in a terminal, where Fleet's panes load, you can instead type `/fleet setup` and confirm in the setup pane. `/tefleet setup` works everywhere: Fleet's tools and commands work in the desktop app, and the panes are tested in the terminal.

`fleet_setup` accepts only the folder this session works in, or a folder above it inside your home folder, and it never creates a folder. It refuses version-control, CI, git-hook, package (`node_modules`), Python environment (`.venv`, `venv`), editor and dev-container folders, Claude Code and Codex settings folders, dot folders in your home folder and `~/bin`, and any folder on your PATH or inside one.

Before setup, Fleet's MCP server stays connected with two tools: `fleet_setup_status`, which only explains how to set up, and `fleet_setup`. When setup finishes, by either route or from another session, the server switches to the full tool set and tells Claude Code its tool list changed. In `/mcp` the server is listed as `plugin:toolsenabled-fleet:fleet`.

Setup turns on subagents for each supported agent CLI on your PATH that passes its checks. For every CLI, setup runs its own sign-in status command the way a subagent starts it (for a CLI that speaks the Agent Client Protocol, the protocol's `initialize` request instead) and, where the CLI runs subagents in its own operating-system sandbox, checks that the sandbox can start (no model call). The README lists the check for each CLI. A CLI that is installed but fails a check stays off, and setup names the command or page that fixes it: do that, run setup again and start a new session. With no signed-in CLI, setup still completes with subagents off. To limit subagents to some CLIs, name them after the command, for example `/tefleet setup claude`, `/tefleet setup codex` or `/tefleet setup opencode`.

Subagents write their reports under `.fleet/reports/` in the project. Add `.fleet/` to your `.gitignore` if you do not want to commit them.

## Try it

On a Linux x86_64 computer or virtual machine with Claude Code, Python 3 at `/usr/bin/python3`, and Node.js 22.19 or newer on your PATH, not inside your project or a temporary folder:

1. Install and sign in to at least one agent CLI in a terminal, for example `claude` (then `claude auth status` reports a sign-in), `codex` (`codex login`) or `opencode` (`opencode auth login`).
2. Install the plugin as above, open a small project folder inside your home folder in Claude Code and type `/tefleet setup`. Approve the setup tool.
3. Ask: "Start a subagent that lists the files in this project and writes a one-paragraph summary to `.fleet/reports/summary.md`, then wait for its report."
4. Type `/tefleet` to see the settings and the subagent, and `/tefleet ledger task check the summary` to add a ledger task without going through Claude.

## Settings

`/tefleet settings` shows and changes depth (levels of subagents, 1-16, default 3), width (subagents each agent may have running at once, 1-64, default 4), which agent CLIs and models subagents may use, the Agent API mode, and audit (off by default). A plugin prompt hook applies it straight from what you typed, so the words never go through Claude; when it cannot tell that you typed it, it asks for a one-time code instead (see [Typed commands](#typed-commands-and-the-one-time-code)). Claude can show the settings with the read-only `fleet_settings` tool but cannot change them. Depth, width and the Agent API mode apply to the next subagent started, resumed or restarted. Providers and models are saved by setup for the project: a change runs setup's sign-in and sandbox checks again and applies right away, including to resumed and restarted subagents and in running sessions. Turning subagents off stops new starts in open sessions. A model list limits only the providers it names, and setup keeps it when you run setup again. With audit off, Fleet keeps no audit record: no signing key, nothing signed. With audit on, Fleet signs a record of the file reads and writes, commands, ledger changes, task and memory changes, and subagent starts, stops, resumes, restarts and removals it makes, refuses any of them it cannot record, and its audit tools appear in new sessions; messages sent between subagents and read-only calls, such as reading tasks, memory or the ledger, are not recorded. The Agent API mode is kept so an earlier choice still applies: in this plugin every mode gives every subagent the same tools and limits, described in the README.

## Ledger

`/tefleet ledger` lets you add standing rules and tasks, answer questions agents filed, and close items. It shows 20 open items at a time; `/tefleet ledger page 2` shows the next page, and `/tefleet ledger all` (or `all page 2`) includes closed items. A plugin prompt hook handles it directly from what you typed, so the words never go through Claude; agents cannot add standing rules themselves. Standing rules reach a subagent outside its task text, through its CLI's own instruction channel (the README's per-CLI table says which); a resumed subagent gets your current rules with its next message. If Fleet cannot read your ledger, it starts no subagent. In Fleet's `ledger.read` tool, records you filed show as filed by `person`.

## Typed commands and the one-time code

Fleet applies `/tefleet ledger`, `/tefleet settings` and `/tefleet confirm` changes at once when Claude Code reports that you typed the command at its prompt. If the hook cannot tell (for example a prompt sent by a scheduled task, `/loop` or another session), Fleet changes nothing and shows you a six-digit code. Type `/tefleet confirm <code>` within 5 minutes, in the same session, to make the change, or ignore it. Showing the ledger or settings needs no code. Claude cannot schedule or forward a `/tefleet` command: Fleet refuses CronCreate, CronUpdate, ScheduleWakeup, RemoteTrigger and SendMessage calls that carry one. The hook reads each prompt only to recognize `/tefleet ledger`, `/tefleet settings` and `/tefleet confirm`. It keeps nothing else, except a change waiting for your code, with only a digest of the code, for 5 minutes (in Claude Code's plugin data folder or Fleet's state folder).

## Move to another project

Fleet serves one project (and its subfolders) per state folder at a time, which is one per operating-system account by default. A session started in any other project gets only Fleet's setup tools, which say which project Fleet is set up for, so nothing in that session acts on the set-up project. Type `/tefleet setup` there to move Fleet; its tools then appear in that same session. After the move, the old session stops offering Fleet's tools, and subagents still running from the old project can no longer read or write files; start new ones in the new project. Fleet's records stay in the same state folder.

## State folder

Fleet's records live in `~/.toolsenabled-fleet-plugin`. To use another folder, set `TOOLSENABLED_FLEET_STATE_ROOT` to an absolute, private path in your environment or in Claude Code's settings `env` object, consistently for every session. Relative paths, `~`, filesystem roots and placeholders are refused, and so is a folder inside your project, `/tmp` or the temporary folder. Never put state or credentials in the plugin's own folder.

## After an update

When an update moves the plugin or changes your Node executable, Fleet binds the new version to the project you already set up the next time it starts, and runs setup's sign-in and sandbox checks again on its own. You do not need to run setup again.

If an earlier Fleet 1.6 kept your audit key in the login keyring, this version does not read it. The first time audit is used with audit on, Fleet moves the earlier history to `audit-history-keyring-<id>` in Fleet's state folder, with its files read-only, and starts a new signed history. Deleting the state folder deletes it too, and `rm -rf` of the state folder works. The old keyring entries stay in your keyring, and you can delete them there. After this version has opened Fleet's state database, Fleet 1.6 cannot open it.

## Subagent permissions and sign-in

Subagents get the permissions described in the README and nothing more. They can write files inside the project folder and nothing outside it, including `/tmp` and `$TMPDIR`. Fleet's file tools and each CLI's own file tools refuse the protected paths: version-control folders, CI workflows, editor and dev-container settings, package manifests and task-runner files, build files that run code (such as `setup.py`, `build.gradle`, `Cargo.toml`, `Gemfile` and `CMakeLists.txt`), agent instruction files such as `CLAUDE.md` and `AGENTS.md`, package-manager and interpreter startup files, project folders on your PATH, agent configuration and credential files. Common credential files in the project (`.npmrc`, `.netrc`, SSH keys, `.docker`, `.aws`, names containing `credential` and the like) cannot be read; this is a list of names, so a secret kept under another name is not covered. How each agent CLI is confined is in the README's per-CLI table. No subagent has its own subagent tools, web search or image generation; a subagent starts further subagents only through Fleet, within your depth, width and model limits.

A refusal names what was denied; if you want that action, do it yourself in your own session. Changing `/permissions` in your own session does not widen a subagent, so do not turn off permission checks for your whole session to get past a refusal. Subagents use each agent CLI's own saved login, the one its login command creates. Fleet never reads, copies or stores a sign-in: it removes the provider sign-in variables (API keys, tokens, cloud-provider credentials and endpoints), and every variable with KEY, TOKEN, SECRET, PASSWORD, PASSWD, PASSPHRASE or CREDENTIALS as a word between underscores in its name (such as `OPENAI_API_KEY`, `HF_TOKEN` or `DB_PASSWORD`), from the environment of every subagent and of every process Fleet starts. A sign-in that exists only in an environment variable is not used. Each CLI loads only the configuration listed for it in the README's permissions table, so a sign-in kept only in a CLI's settings file may not work for a subagent either. Setup reports a CLI that fails its sign-in check as having no saved login its subagents can use; run the CLI's own login command once. Subagents have no shell. Subagents and the programs Fleet runs for them get your PATH without folders inside the project or temporary folders. Fleet starts the `claude` and `codex` it finds on your PATH when a session starts, skipping those folders, and runs only that copy for the session.

## Older ToolsEnabled registrations

An earlier ToolsEnabled installer may have registered a separate MCP server named `toolsenabled` or `toolsenabled-fleet-host`. If `/mcp` shows one you no longer use, remove it yourself, for example `claude mcp remove --scope user toolsenabled`. Fleet never removes registrations automatically.

## Troubleshooting

Fleet runs on Linux x86_64 only, directly on your computer; it refuses to start inside an OpenShell sandbox. If Fleet says it will not run with your Node.js, put a Node.js from outside your project and temporary folders first on your PATH (for example `/usr/bin/node`), then restart Claude Code.

## Uninstall

Close sessions using Fleet, then uninstall the plugin from Claude Code. To delete Fleet's records, remove the state folder yourself:

```sh
rm -rf -- "$HOME/.toolsenabled-fleet-plugin"
```

If you set `TOOLSENABLED_FLEET_STATE_ROOT`, remove that folder instead. This also removes any moved audit history; the old Fleet 1.6 keyring entries stay in your keyring until you delete them there. Project files and provider sign-ins are not part of Fleet's state. The agent CLIs keep their own session history for subagents in their own folders (for example `~/.claude`, `~/.codex` and `~/.local/share/opencode`); manage it with each CLI.
