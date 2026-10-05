'use strict';
const path = require('node:path');

// Protected names shared by native workspace file rules and Fleet file tools.
// The CLI rules prepend **/ so nested copies match alongside top-level files.
const PROTECTED_EDIT_PATTERNS = Object.freeze([
  // Version control, including a .git file that points at another git folder.
  '.git', '.git/**', '.hg/**', '.svn/**', '.bzr/**', '.pijul/**', '.fossil-settings/**',
  '*.git/hooks/**', '*.git/config', '.gitconfig', '.gitmodules', '.config/git/**',
  // Editors, dev containers and CI.
  '.vscode/**', '.idea/**', '.zed/**', '.cursor/**', '.windsurf/**', '.devcontainer/**', '.devcontainer.json',
  '.github/workflows/**', '.github/actions/**', '.circleci/**', '.gitlab-ci.yml', '.gitlab-ci.yaml',
  // Hooks and task runners.
  '.husky/**', '.githooks/**', 'lefthook*.yml', 'lefthook*.yaml', '.lefthook.yml', '.lefthook.yaml',
  '.pre-commit-config.yml', '.pre-commit-config.yaml',
  'package.json', 'GNUmakefile', 'Makefile', 'makefile', 'Justfile', 'justfile', 'Taskfile', 'Taskfile.yml', 'Taskfile.yaml',
  'Gruntfile.js', 'Gruntfile.cjs', 'Gruntfile.mjs', 'gulpfile.js', 'gulpfile.cjs', 'gulpfile.mjs',
  'tox.ini', 'noxfile.py', 'pyproject.toml', 'Procfile', 'Dockerfile', 'compose.yml', 'compose.yaml',
  // Package managers and toolchains that load project files as code or config.
  '.npmrc', '.yarnrc*', '.yarn/**', '.pnp.cjs', '.pnp.loader.mjs', '.pnpmfile.cjs', 'bunfig.toml', '.bunfig.toml',
  '.cargo/**', '.mvn/**', 'maven-wrapper.properties', 'gradle-wrapper.properties',
  '.bazelrc', '.bazelversion', '.bazeliskrc', 'mise.toml', '.mise.toml', '.ripgreprc', 'pyrightconfig.json',
  // Programs on PATH or loaded at interpreter start.
  'node_modules/.bin/**', '.venv/bin/**', 'venv/bin/**', 'env/bin/**', '.local/bin/**',
  'site-packages/*.pth', 'sitecustomize.py', 'conftest.py',
  // Shell and login files.
  '.envrc', '.bashrc', '.bash_profile', '.bash_login', '.bash_aliases', '.bash_logout', '.profile',
  '.zshrc', '.zshenv', '.zprofile', '.zlogin', '.zlogout', '.kshrc', '.cshrc', '.tcshrc', '.inputrc',
  '.xprofile', '.xinitrc', '.pam_environment',
  // Agent configuration and the instruction files the next agent session reads.
  '.claude/**', '.claude.json', '.codex/**', '.gemini/**', '.mcp.json',
  'CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'AGENTS.override.md', 'GEMINI.md',
  '.cursorrules', '.cursorrules/**', '.windsurfrules', '.windsurfrules/**', '.clinerules', '.clinerules/**',
  '.agents/**', '.github/copilot-instructions.md', '.github/instructions/**',
  // Build and environment files that run code on the next build, install,
  // `cd` (direnv, Nix) or editor start.
  'setup.py', 'usercustomize.py', 'build.rs', 'Cargo.toml', 'build.gradle', 'build.gradle.kts',
  'settings.gradle', 'settings.gradle.kts', 'gradle.properties', 'gradlew', 'gradlew.bat', 'buildSrc/**',
  'mvnw', 'mvnw.cmd', 'pom.xml', 'Pipfile', 'Gemfile', '*.gemspec', 'Rakefile', 'CMakeLists.txt', 'meson.build',
  'composer.json', 'deno.json', 'deno.jsonc', 'Vagrantfile', 'Earthfile', 'flake.nix', 'shell.nix', 'default.nix',
  '.direnv/**', '.vimrc', '.exrc', '.nvimrc', '.nvim.lua', '.lazy.lua',
  // Startup folders a profile runs from.
  'Documents/WindowsPowerShell/**', 'Documents/PowerShell/**',
  'AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/**',
  // Credential and tool configuration stores, several of which name programs
  // to run (Docker credential helpers, kubeconfig exec plugins).
  '.config/**', '.ssh/**', '.aws/**', '.gnupg/**', '.docker/**', '.kube/**', '.netrc', '.git-credentials',
  '.pgpass', '.my.cnf', '.vault-token', '.pypirc', '.m2/settings.xml',
]);
// Read-protected names. Credential files cannot be edited either.
const CREDENTIAL_DATA_EXTENSIONS = Object.freeze(['json*', 'y*ml', 'toml', 'ini', 'cfg', 'conf', 'db', 'sqlite*',
  'env', 'pem', 'key', 'p12', 'pfx']);
// Stems refused only as the whole name or before a separator, so an ordinary
// tokenizer.json or authors.yml stays readable.
const CREDENTIAL_EXACT_STEMS = Object.freeze(['auth', 'token', 'tokens']);
// Stems refused anywhere in a name with a data or key extension.
const CREDENTIAL_STEMS = Object.freeze(['cookie', 'credential', 'session', 'passw', 'passphrase', 'keystore', 'kdbx', 'wallet',
  ...['access', 'refresh', 'bearer'].flatMap(kind => ['key', 'token'].flatMap(item => [`${kind}[._-]${item}`, `${kind}${item}`])),
  'private[._-]key', 'privatekey', 'service[._-]account', 'serviceaccount']);
const PROTECTED_READ_PATTERNS = Object.freeze([
  // Version control internals, a vendored repository's included.
  '.git/**',
  // Environment files.
  '.env', '.env.*',
  // Credential, key and tool configuration stores.
  'vault/**', '.ssh/**', '.aws/**', '.gnupg/**', '.docker/**', '.kube/**', '.azure/**', '.config/**', '.terraform.d/**',
  '.claude/**', '.claude.json', '.codex/**', '.gemini/**', '.netrc', '.git-credentials', '.pgpass', '.my.cnf',
  '.vault-token', '.Xauthority', 'key4.db', 'Login Data', 'login.keyring', 'kaggle.json', '.m2/settings.xml',
  '.cargo/credentials', '.cargo/credentials.toml', '.gem/credentials', '.npmrc', '.pypirc', 'NuGet.Config',
  'ConsoleHost_history.txt', '*_history', 'profiles/chrome/**',
  '.nuget/NuGet.Config',
  'AppData/Local/Microsoft/Credentials/**', 'AppData/Roaming/Microsoft/Crypto/**',
  'AppData/Roaming/Microsoft/Protect/**', 'AppData/Roaming/gcloud/**',
  // Private SSH keys by their usual names.
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'id_ecdsa_sk', 'id_ed25519_sk',
  // Shell and login files, which commonly export keys.
  '.bashrc', '.bash_profile', '.bash_login', '.profile', '.zshrc', '.zshenv', '.zprofile', '.zlogin', '.kshrc', '.cshrc',
  '.tcshrc', '.inputrc', '.xprofile', '.xinitrc', '.pam_environment', '.envrc',
  // Credential-shaped names.
  '*credential*', '*private[._-]key*', '*privatekey*',
  ...CREDENTIAL_EXACT_STEMS.flatMap(stem => CREDENTIAL_DATA_EXTENSIONS.flatMap(extension =>
    [`${stem}.${extension}`, `.${stem}.${extension}`, `${stem}[._-]*.${extension}`, `.${stem}[._-]*.${extension}`])),
  ...CREDENTIAL_STEMS.flatMap(stem => CREDENTIAL_DATA_EXTENSIONS.map(extension => `*${stem}*.${extension}`)),
]);
// Match the same relative-name globs against a resolved host path. The CLI
// permissions use these globs directly; Fleet's file tools use this matcher.
function globSource(glob) {
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === '*' && glob[index + 1] === '*') { source += '.*'; index += 1; }
    else if (character === '*') source += '[^/]*';
    else if (character === '?') source += '[^/]';
    else if (character === '[') {
      const end = glob.indexOf(']', index);
      if (end < 0) throw new Error('Invalid protected-name glob');
      source += glob.slice(index, end + 1);
      index = end;
    } else source += character.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return source;
}
const COMPILED = new Map();
function compiled(glob) {
  if (!COMPILED.has(glob)) COMPILED.set(glob, new RegExp(`(?:^|/)${globSource(glob)}(?:/.*)?$`, 'i'));
  return COMPILED.get(glob);
}
// Windows opens a name with trailing dots or spaces, or with an alternate data
// stream suffix, as the plain name, so such a spelling is matched as the plain
// name too. On Linux these are different names; protecting them as well costs nothing.
function windowsResolved(normalized) {
  return normalized.split('/').map(segment => segment.replace(/:.*$/, '').replace(/[. ]+$/, '')).join('/');
}
function matches(glob, filename) {
  const normalized = filename.replace(/\\/g, '/');
  const pattern = compiled(glob);
  if (pattern.test(normalized)) return true;
  const resolved = windowsResolved(normalized);
  return resolved !== normalized && pattern.test(resolved);
}
function protectedReadName(filename) { return PROTECTED_READ_PATTERNS.some(glob => matches(glob, filename)); }
function protectedEditName(filename) { return PROTECTED_EDIT_PATTERNS.some(glob => matches(glob, filename)); }
// The native rules are written relative to the project, so a folder above the
// project never counts as part of a name. Without a base, the path is matched as given.
function projectRelative(candidatePath, base) {
  if (!base) return candidatePath;
  const relative = path.relative(base, candidatePath);
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) ? relative : candidatePath;
}
// Excluded from the FILE surface regardless of how the path is spelled --
// READ and WRITE both. Treat this list as "every place a credential, session
// token, or capability secret is known to live on a real machine," not just
// "the ones this feature happened to touch": AI-tool and cloud-CLI credential
// stores on an ordinary developer profile (.codex/auth.json,
// .claude/.credentials.json, .gemini/oauth_creds.json and gcloud's
// application_default_credentials.json), and the product's state/ folder,
// whose helper tokens and capability files would let a caller escalate past
// this whole module by reading them. Credential-store folders and the Windows
// DPAPI material are excluded outright. .ssh/.aws/.gnupg/.docker/.kube and the
// browser profiles are the same class of thing: long-lived credentials and
// authenticated session state that no file-read capability should hand over
// wholesale (profiles/chrome additionally carries remembered-device MFA
// state, which can stand for a year or more and cannot be recreated without a
// human physically approving a fresh push).
const EXCLUDED_PATH_PATTERNS = [
  /[\\/]vault([\\/]|$)/i,
  /[\\/]\.ssh([\\/]|$)/i,
  /[\\/]\.aws([\\/]|$)/i,
  /[\\/]\.gnupg([\\/]|$)/i,
  /[\\/]\.docker([\\/]|$)/i,
  /[\\/]\.kube([\\/]|$)/i,
  /[\\/]\.netrc$/i,
  /[\\/]\.git-credentials$/i,
  /[\\/](?:\.pgpass|\.my\.cnf|\.claude\.json|\.vault-token|\.Xauthority|key4\.db|Login Data|login\.keyring)$/i,
  /[\\/]kaggle\.json$/i,
  // Private SSH keys by their usual exact names (never the .pub halves).
  /[\\/]id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?$/i,
  /[\\/]\.m2[\\/]settings\.xml$/i,
  /[\\/]\.(?:cargo|gem)[\\/]credentials(?:\.toml)?$/i,
  /[\\/][^\\/]*_history$/i,
  // Package-manager and infrastructure CLI credential files. Keep these
  // exact/bounded: an ordinary profile file must remain usable even when it
  // lives beside one of these stores.
  /[\\/]\.npmrc$/i,
  /[\\/]\.pypirc$/i,
  /[\\/]NuGet[\\/]NuGet\.Config$/i,
  /[\\/]\.nuget[\\/]NuGet\.Config$/i,
  /[\\/]\.azure[\\/](?:azureProfile\.json|AzureRmContext\.json|accessTokens\.json|msal_token_cache\.bin)$/i,
  /[\\/]\.terraform\.d[\\/]credentials\.tfrc\.json$/i,
  /[\\/]\.config[\\/]gh[\\/]hosts\.ya?ml$/i,
  /[\\/]WindowsPowerShell[\\/]PSReadLine[\\/]ConsoleHost_history\.txt$/i,
  /[\\/]PowerShell[\\/]PSReadLine[\\/]ConsoleHost_history\.txt$/i,
  /[\\/]ConsoleHost_history\.txt$/i,
  /[\\/]\.(?:bash_history|zsh_history|fish_history|python_history)$/i,
  // Shell and login files commonly export provider keys. They are also
  // executable inputs, so neither reads nor writes belong to a model tool.
  /[\\/]\.(?:bashrc|bash_profile|bash_login|profile|zshrc|zshenv|zprofile|zlogin|kshrc|cshrc|tcshrc|inputrc|xprofile|xinitrc|pam_environment|envrc)$/i,
  /[\\/]profiles[\\/]chrome([\\/]|$)/i,
  /[\\/]AppData[\\/]Local[\\/]Google[\\/]Chrome([\\/]|$)/i,
  /[\\/]AppData[\\/]Local[\\/]Microsoft[\\/]Credentials([\\/]|$)/i,
  /[\\/]AppData[\\/]Roaming[\\/]Microsoft[\\/]Crypto([\\/]|$)/i,
  /[\\/]AppData[\\/]Roaming[\\/]Microsoft[\\/]Protect([\\/]|$)/i,
  // AI CLI / cloud CLI OAuth and API-key stores; every one carries a live
  // refresh token or API key.
  /[\\/]\.codex([\\/]|$)/i,
  /[\\/]\.claude([\\/]|$)/i,
  /[\\/]\.gemini([\\/]|$)/i,
  /[\\/]\.config([\\/]|$)/i,
  /[\\/]AppData[\\/]Roaming[\\/]gcloud([\\/]|$)/i,
  // state/ holds helper tokens and capability files; reading one is a direct
  // escalation past this module. Matches a ToolsEnabled checkout AND every
  // ToolsEnabled-* sibling (see the WRITE_EXCLUDED comment below for why the
  // name must be a prefix match, not an exact segment match).
  /[\\/]ToolsEnabled[^\\/]*[\\/]state([\\/]|$)/i
];

// Retain bounded host path patterns for platform-specific stores. The shared
// name globs above close the former difference between file surfaces.
const COMMON_CREDENTIAL_STORE_PATTERN = /[\\/](?:\.(?:auth|token|tokens|cookie|cookies|credential|credentials|session|sessions|password|passwords|passwd|passphrase|passphrases|keystore|keystores|kdbx|wallet|wallets)|auth|token|tokens|cookie|cookies|credential|credentials|session|sessions|passwords?|passwd|passphrases?|(?:access|refresh|bearer)[._-]?(?:keys?|tokens?)|private[._-]?keys?|service[._-]?accounts?|keystores?|kdbx|wallets?)(?:[._-][^\\/]*)?\.(?:json|jsonl|ya?ml|toml|ini|cfg|conf|db|sqlite3?)$/i;

// This additional file-name pattern preserves host restrictions for key data
// extensions. Read and edit refusals also apply the shared glob list above.
const CREDENTIAL_SHAPED_NAME_PATTERN = /(?:^|[._-])(?:passwords?|passwd|passphrases?|(?:access|refresh|bearer)[._-]?(?:keys?|tokens?)|private[._-]?keys?|service[._-]?accounts?|keystores?|kdbx|wallets?)(?:[._-][^./\\]*)?\.(?:json|jsonl|ya?ml|toml|ini|cfg|conf|env|pem|key|p12|pfx|db|sqlite3?)$/i;

function isProtectedEnvironmentPath(candidatePath) {
  const basename = path.basename(candidatePath).toLowerCase();
  if (basename === '.env') return true;
  if (!basename.startsWith('.env.')) return false;
  return !['.env.example', '.env.template', '.env.sample'].includes(basename);
}

function isCredentialShapedName(candidatePath) {
  return CREDENTIAL_SHAPED_NAME_PATTERN.test(path.basename(candidatePath));
}

// Places and names that hold credentials, sign-in sessions or environment secrets.
function isCredentialStorePath(candidatePath) {
  return EXCLUDED_PATH_PATTERNS.some(pattern => pattern.test(candidatePath))
    || COMMON_CREDENTIAL_STORE_PATTERN.test(candidatePath)
    || isCredentialShapedName(candidatePath)
    || isProtectedEnvironmentPath(candidatePath);
}

// Everything no file tool reads: the stores above and every name the native
// read rules refuse.
function isCredentialProtectedPath(candidatePath, base) {
  return protectedReadName(projectRelative(candidatePath, base)) || isCredentialStorePath(candidatePath);
}
function isProtectedEditPath(candidatePath, base) { return protectedEditName(projectRelative(candidatePath, base)); }


// WRITE-ONLY exclusions: readable, but never writable through this surface.
// These are the integrity anchors that decide whether this capability is
// itself still constrained -- if the caller can write them, it can rewrite
// its own limits, and every other check here becomes decorative.
//
// Path segments read "ToolsEnabled[^\\/]*" rather than an exact "ToolsEnabled"
// match, so sibling checkouts such as ToolsEnabled-<name> are covered too: a
// forged standing-orders or policy file planted in one would otherwise be read
// as authoritative by anything whose rootPath resolved there.
//
// config/ carries the policy and model floor: a caller able to write it could
// flip approvals.enabled or repoint killswitchFile with no audit trail.
// logs/ and reports/ are the audit-adjacent record; node_modules and the
// global git/npm config files are execution-persistence vectors (a crafted
// diff driver or textconv in ~/.gitconfig runs on the next `git diff`/`git
// log -p`/`git show` ANY local process makes).
const WRITE_EXCLUDED_PATH_PATTERNS = [
  // A normal project can execute these on the next shell, Git, editor, CI or
  // task-runner action. Protect them even when the project is not Fleet's own.
  /[\\/]\.(?:git|hg|svn|bzr|pijul|fossil-settings)([\\/]|$)/i,
  /[\\/]\.(?:vscode|idea|zed|cursor|windsurf|devcontainer)([\\/]|$)/i,
  /[\\/]\.github[\\/]workflows([\\/]|$)/i,
  /[\\/]\.github[\\/]actions([\\/]|$)/i,
  /[\\/](?:\.husky|\.githooks|\.circleci)([\\/]|$)/i,
  /[\\/][^\\/]+\.git[\\/](?:hooks|config)([\\/]|$)/i,
  /[\\/](?:\.gitlab-ci\.ya?ml|lefthook[^\\/]*\.ya?ml|mise\.toml|\.yarnrc[^\\/]*|\.cargo[\\/]config[^\\/]*)$/i,
  /[\\/]node_modules[\\/]\.bin([\\/]|$)/i,
  /[\\/]\.venv[\\/]bin([\\/]|$)/i,
  /[\\/](?:venv|env)[\\/]bin([\\/]|$)/i,
  /[\\/]site-packages[\\/][^\\/]+\.pth$/i,
  /[\\/](?:\.mcp\.json|\.mise\.toml|\.pnpmfile\.cjs|sitecustomize\.py|conftest\.py)$/i,
  /[\\/](?:package\.json|GNUmakefile|Makefile|[Jj]ustfile|Taskfile(?:\.ya?ml)?|Gruntfile\.[cm]?js|gulpfile\.[cm]?js|tox\.ini|noxfile\.py|pyproject\.toml|Procfile|Dockerfile|compose\.ya?ml|\.pre-commit-config\.ya?ml)$/i,
  /[\\/]\.local[\\/]bin([\\/]|$)/i,
  // Package managers, build tools, editors and dev containers load or run
  // these paths from a project.
  /[\\/]\.(?:yarn|mvn|cargo)([\\/]|$)/i,
  /[\\/](?:\.gitmodules|\.pnp\.cjs|\.pnp\.loader\.mjs|\.?bunfig\.toml|\.bazelrc|\.bazelversion|\.bazeliskrc|\.lefthook\.ya?ml|gradle-wrapper\.properties|maven-wrapper\.properties|\.devcontainer\.json|\.ripgreprc|pyrightconfig\.json)$/i,
  /[\\/]\.(?:bash_aliases|bash_logout|zlogout)$/i,
  // Agent instruction files, which the next agent session in the project
  // reads as the person's instructions, and build and
  // environment files that run code on the next build, install, `cd` (direnv,
  // Nix) or editor start (exrc). A subagent must not plant either for the
  // person or for the next agent.
  /[\\/](?:CLAUDE(?:\.local)?|AGENTS(?:\.override)?|GEMINI)\.md$/i,
  /[\\/](?:\.cursorrules|\.windsurfrules|\.clinerules|\.agents)([\\/]|$)/i,
  /[\\/]\.github[\\/](?:copilot-instructions\.md$|instructions([\\/]|$))/i,
  /[\\/](?:setup\.py|usercustomize\.py|build\.rs|Cargo\.toml|(?:build|settings)\.gradle(?:\.kts)?|gradle\.properties|gradlew(?:\.bat)?|mvnw(?:\.cmd)?|pom\.xml|Pipfile|Gemfile|[^\\/]+\.gemspec|Rakefile|CMakeLists\.txt|meson\.build|composer\.json|deno\.jsonc?|Vagrantfile|Earthfile|(?:flake|shell|default)\.nix)$/i,
  /[\\/](?:buildSrc|\.direnv)([\\/]|$)/i,
  /[\\/](?:\.vimrc|\.exrc|\.nvimrc|\.nvim\.lua|\.lazy\.lua)$/i,
  /[\\/]ToolsEnabled[^\\/]*[\\/]state([\\/]|$)/i,
  /[\\/]ToolsEnabled[^\\/]*[\\/]config[\\/][^\\/]*\.policy\.json$/i,
  // Generic host writes must not stage replacement code or runtime artifacts
  // in any ToolsEnabled checkout.
  //
  // The code-folder rule lives in host-control's WRITE_EXCLUDED_CODE_PATTERNS.
  // It names the folders where each package's own manifest says its
  // code starts (bin and shell as well as src), not just a convention. It is
  // the one rule the person may lift for their own checkouts
  // (agent.product_source_writes), and the anchors in this list are not. See
  // isProductCodeWriteAllowed() for the exact rule.
  /[\\/]ToolsEnabled[^\\/]*[\\/]logs([\\/]|$)/i,
  /[\\/]ToolsEnabled[^\\/]*[\\/]\.git([\\/]|$)/i,
  /[\\/]ToolsEnabled[^\\/]*[\\/]node_modules([\\/]|$)/i,
  /[\\/]ToolsEnabled[^\\/]*[\\/]reports[\\/]OWNER-REQUEST-LEDGER/i,
  /[\\/]ToolsEnabled[^\\/]*[\\/]STANDING-ORDERS\.md$/i,
  /[\\/]ToolsEnabled[^\\/]*[\\/]CLAUDE\.md$/i,
  /[\\/]ToolsEnabled[^\\/]*[\\/]AGENTS\.md$/i,
  /[\\/]ToolsEnabled[^\\/]*[\\/]GEMINI\.md$/i,
  /[\\/]ToolsEnabled[^\\/]*[\\/]BUILD-QUEUE\.md$/i,
  /[\\/]ToolsEnabled[^\\/]*[\\/]docs[\\/]ROLE-OPERATIONS\.md$/i,
  /[\\/]ToolsEnabled[^\\/]*[\\/]reports[\\/]TOOLSENABLED-SUGGESTIONS\.md$/i,
  /[\\/]ToolsEnabled[^\\/]*[\\/]package(-lock)?\.json$/i,
  /[\\/]ToolsEnabled[^\\/]*[\\/](?:npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb)$/i,
  /[\\/]ToolsEnabled[^\\/]*[\\/]KILLSWITCH$/i,
  /[\\/]\.gitconfig$/i,
  /[\\/]\.npmrc$/i,
  // BOTH PowerShell editions. Windows PowerShell 5.1 reads
  // Documents\WindowsPowerShell; PowerShell 6/7+ reads Documents\PowerShell --
  // a different folder, the same autorun, profile and Modules\ alike (a module
  // dropped in Modules\ is auto-discovered by name, no profile edit needed).
  // Anchored on the segment, so a folder merely starting with "PowerShell" is
  // not swept in.
  /[\\/]Documents[\\/](?:WindowsPowerShell|PowerShell)([\\/]|$)/i,
  // Anything that gets executed on a schedule or at logon is a persistence
  // and privilege-escalation path, not an ordinary file.
  /[\\/]AppData[\\/]Roaming[\\/]Microsoft[\\/]Windows[\\/]Start Menu[\\/]Programs[\\/]Startup([\\/]|$)/i
];


module.exports = Object.freeze({ WRITE_EXCLUDED_PATH_PATTERNS, EXCLUDED_PATH_PATTERNS, isCredentialProtectedPath, isCredentialStorePath, isProtectedEditPath, PROTECTED_READ_PATTERNS, PROTECTED_EDIT_PATTERNS,
  matchesProtectedGlob: matches, protectedReadName, protectedEditName });
