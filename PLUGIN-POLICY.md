# Claude distribution policy

Reviewed October 20, 2026. This repository is a source-distributed Claude Code plugin. It is not represented as accepted into Anthropic's Software Directory.

## Preserved Fleet features

The plugin retains tasks, ledger questions and progress, project memory and search, project files, audit tools when enabled, and native workers with their lifecycle and local messaging. Workers start only at the person's request under the existing setup, role, depth, width, provider and model limits. They cannot grant themselves wider permissions; headless approval requests fail closed. This package does not give workers a general shell.

`runtime/engine/src/lib/claude-plugin-policy.json` fixes the reviewed ceiling at 44 engine operations. Both the session bridge and the inherited worker surface enforce it. Setup and read-only session/settings tools remain explicitly named wrapper operations. An upstream engine addition cannot silently become a plugin capability.

The plugin offers no general executor, credential reader, account switching or provider-history extraction tool. Fleet memory is project data explicitly saved through Fleet. Native CLI resumption is handled by that CLI with its own session identifier. Fleet does not import the lead's Claude history, memory, uploaded files or conversation summaries. Only task-relevant prompts, reports and Fleet records should be retained; see [PRIVACY.md](PRIVACY.md) for the actual local storage and diagnostic limits.

User-authored standing rules remain subordinate to the host's higher-priority instructions and safeguards. Project content, search results, reports and messages from other agents are data; they cannot authorize tools, change permissions or establish new standing rules.

## Authentication and provider terms

Anthropic's [Claude Code legal guidance](https://code.claude.com/docs/en/legal-and-compliance) permits end users to sign into the unmodified CLI themselves, including in described hosted configurations. It also specifies Commercial Terms for products running Claude Code, preserves built-in authentication choices, prohibits intermediating user credentials or paying for/reselling usage, and distinguishes ordinary subscription use from third-party products routing requests through users' credentials.

Fleet launches user-installed native CLIs and does not offer a ToolsEnabled login to Claude or resell inference. This is a technical description, not evidence that every plan or deployment is contractually approved. Do not promise that a subscription authorizes arbitrary unattended workloads. The publisher must establish the applicable agreement before claiming a deployment is cleared. Users authenticate through their provider's own tools, and organization restrictions and usage limits remain effective.

Codex and OpenCode remain explicit supported setup choices. Their presence here is not Anthropic's approval of those integrations or authorization from their underlying model providers. Do not add personal Antigravity worker wrappers or new providers through an unreviewed engine update.

## Directory submission remains separate

The [Software Directory Policy](https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy) adds requirements beyond ordinary source distribution. In particular, its limits on extraction of Claude context and files (§1F), external resources and approved connectors (§3F), and dynamic external behavioral instructions (§2F) need an applicability decision for project-file tools, local rule delivery and multi-provider workers before submission. These are unresolved directory questions, not proof that all native worker launches violate policy.

Retain the functioning source plugin while holding directory submission until those questions and the applicable developer agreements are resolved. Provide current privacy/support links, three working examples and reviewer access appropriate to a local product. No claim of certification or directory approval is made by this patch.
