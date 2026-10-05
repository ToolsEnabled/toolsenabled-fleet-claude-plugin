'use strict';

// Transport profiles describe how an already signed-in agent CLI that speaks the
// Agent Client Protocol (ACP) is started as a Fleet subagent. A profile is data
// plus two small functions: prepare() returns the private launch files and the
// environment, and confirm() judges the configuration the CLI itself reports it
// would run with. Files are returned as data; the host launcher writes them only
// with writePrivate inside the worker's node folder. Fleet never calls an ACP
// authenticate method: each CLI signs in by its own saved login.
const crypto = require('node:crypto');
const path = require('node:path');

function wildcardTest(glob, text) {
  const source = String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${source}$`, 's').test(String(text));
}
// OpenCode evaluates its permission rules in order and the last matching rule wins.
function lastAction(rules, permission, pattern) {
  let action = null;
  for (const rule of rules) {
    if (rule && wildcardTest(rule.permission, permission) && wildcardTest(rule.pattern, pattern)) action = rule.action;
  }
  return action;
}

// Switches that keep the person's other tools, skills and project files out of a
// subagent: OpenCode would otherwise load skills from the person's Claude folders,
// every MCP server and plugin of the person's own configuration, and the project's
// own configuration (which a project can plant).
const OPENCODE_SWITCHES = Object.freeze({
  OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
  OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_AUTOUPDATE: '1',
});
// Inline configuration or permission in the environment would override the generated file.
const OPENCODE_OVERRIDES = Object.freeze(['OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_CONFIG_DIR', 'OPENCODE_PERMISSION']);
// What a subagent must never be allowed to do through the CLI's own tools.
const OPENCODE_NATIVE_TOOLS = Object.freeze(['bash', 'edit', 'write', 'patch', 'read', 'glob', 'grep', 'list',
  'webfetch', 'websearch', 'codesearch', 'task', 'skill', 'todowrite', 'todoread', 'lsp', 'external_directory',
  'question', 'plan_enter', 'plan_exit', 'doom_loop', 'some_other_server_tool']);
const OPENCODE_PROBES = Object.freeze(['*', 'x', 'git status', '/etc/passwd', 'https://example.com', 'rm -rf /']);

const ACP_PROFILES = Object.freeze({
  opencode: Object.freeze({
    id: 'opencode', displayName: 'OpenCode', command: 'opencode', loginCommand: 'opencode auth login',
    args: Object.freeze(['acp', '--pure']),
    // OpenCode advertises one method, which only says to run its own login command.
    authMethodIds: Object.freeze([]),
    switches: OPENCODE_SWITCHES, overrides: OPENCODE_OVERRIDES,
    inspect: Object.freeze({ config: Object.freeze(['debug', 'config']), agent: Object.freeze(['debug', 'agent', 'build']),
      skills: Object.freeze(['debug', 'skill']) }),
    settingsFile: 'opencode.json',
    // `ambient` is the configuration OpenCode reports with the switches on and no generated file.
    prepare({ nodeFolder, ambient }) {
      const serverName = `fleet-${crypto.createHash('sha256').update(String(nodeFolder)).digest('hex').slice(0, 8)}`;
      const file = path.join(nodeFolder, this.settingsFile);
      const others = Object.keys(ambient && typeof ambient.mcp === 'object' && ambient.mcp ? ambient.mcp : {});
      const config = { $schema: 'https://opencode.ai/config.json', default_agent: 'build', share: 'disabled',
        autoupdate: false, snapshot: false, plugin: [],
        mcp: Object.fromEntries(others.map(name => [name, { enabled: false }])),
        permission: { '*': 'deny', [`${serverName}_*`]: 'allow' } };
      return { serverName, toolNamePrefix: `${serverName}_`, args: [...this.args],
        env: { ...this.switches, OPENCODE_CONFIG: file }, removeEnv: [...this.overrides],
        files: [{ file, text: `${JSON.stringify(config)}\n` }] };
    },
    // Judges what OpenCode reports with the generated file in place; returns a sentence, or null when it is confined.
    confirm({ config, agent, skills, serverName }) {
      if (!config || typeof config !== 'object' || !agent || !Array.isArray(agent.permission)) {
        return 'OpenCode did not report its configuration.';
      }
      // A skill is text that steers the model: only OpenCode's own built-in skills may be loaded, from the
      // person's folders or from the project (which a project can plant).
      if (!Array.isArray(skills)) return 'OpenCode did not report its skills.';
      const outside = skills.findIndex(skill => !skill || skill.location !== '<built-in>');
      if (outside >= 0) return `OpenCode would load the skill ${JSON.stringify(String(skills[outside] && skills[outside].name).slice(0, 64))} from outside itself.`;
      if (config.default_agent !== 'build') return 'OpenCode would not start its confined default agent.';
      const open = Object.entries(config.mcp && typeof config.mcp === 'object' ? config.mcp : {})
        .filter(([, entry]) => !entry || entry.enabled !== false).map(([name]) => name);
      if (open.length) return `OpenCode would still start the MCP server ${open.map(name => JSON.stringify(String(name).slice(0, 64))).join(', ')}.`;
      for (const tool of OPENCODE_NATIVE_TOOLS) {
        for (const pattern of OPENCODE_PROBES) {
          if (lastAction(agent.permission, tool, pattern) !== 'deny') return `OpenCode would not deny its own ${tool} tool.`;
        }
      }
      if (lastAction(agent.permission, `${serverName}_task_list`, '*') !== 'allow') return 'OpenCode would not allow Fleet\'s tools.';
      return null;
    }
  })
});

function acpProfile(id) { return Object.hasOwn(ACP_PROFILES, id) ? ACP_PROFILES[id] : null; }
function acpMcpServers(name, entry) {
  return [{ name, command: entry.command, args: entry.args,
    env: Object.entries(entry.env).map(([key, value]) => ({ name: key, value })) }];
}
module.exports = Object.freeze({ ACP_PROFILES, acpProfile, acpMcpServers, lastAction });
