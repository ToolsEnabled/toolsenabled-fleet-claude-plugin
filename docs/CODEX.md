# Codex self-distribution candidate (unreleased)

This package exposes Fleet's hook-independent core MCP on Linux x86_64 with
Node.js >=22.19. It requires a **separate workers-off state root** and runs as
actor `codex`. Workers, Claude typed commands, panes and lifecycle hooks are
unavailable. An explicit empty `codex-hooks.json` prevents discovery of the
Claude hook file (the CLI tested here falls back to autodiscovery for `hooks: []`).
The original Claude package is unchanged. This branch is a local
marketplace candidate, not an OpenAI directory listing or approval.

```sh
codex plugin marketplace add ToolsEnabled/toolsenabled-fleet-claude-plugin --ref openai-plugin
codex plugin add toolsenabled-fleet@toolsenabled-fleet-openai
```

With no explicit environment configuration, only `fleet_codex_status` is
available; it reads no Fleet state. For core coordination, use a fresh private
state root outside the installation/project and a project inside your account
home, as required by Fleet's canonical host controls. From the installed plugin
folder run the reviewed terminal command yourself, substituting both paths:

```sh
node runtime/engine/bin/toolsenabled-host.js setup --plugin --workspace /absolute/project --state-root /absolute/private/fleet-codex
export TOOLSENABLED_FLEET_CODEX_STATE_ROOT=/absolute/private/fleet-codex
export FLEET_CODEX_WORKSPACE=/absolute/project
```

Restart Codex with those variables; the manifest forwards only these two to
Fleet. FLEET_CODEX_WORKSPACE must resolve to exactly the saved project directory.
A child, parent or unrelated directory is refused; a symlink alias is accepted
only when it resolves to the very same directory. The server verifies the saved
private setup, exact workspace identity and
`workers === false` before serving canonical tools. Never point this package at
an existing workers-enabled state. To move to a new plugin cache after an
upgrade, repeat the terminal setup against the **same separately owned state**;
no automatic rebind or worker enablement is offered here.

The canonical core provides individual task, memory, ledger, search and mediated
project-file tools, constrained by host tier and saved settings. Use only the
advertised schemas. Setup/settings/standing-rule changes stay terminal actions.
The local MCP server is not a sandbox around Codex's own native tools.

Fleet itself sends no network traffic and holds no ToolsEnabled account or
telemetry. Codex can send returned content to OpenAI under its own login/terms.
The separate state root retains tasks, ledger, memory, search and host records;
core startup also creates private runtime bookkeeping. Stop all clients before
backing it up or deleting it. Uninstalling the plugin does not delete that state.
See [Privacy](../PRIVACY.md), [Security](../SECURITY.md),
[Terms](https://toolsenabled.ai/terms/) and the source MIT license.
Full worker/typed-command parity and directory submission are separate pending
engineering/review gates; this package does not rely on Claude hooks for its
workers-off boundary.
