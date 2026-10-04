'use strict';

// Host control provides logged access to allowed profile files.
// Path containment, credential exclusions, policy and audit checks still apply.
// The host administrator grants this capability outside the agent transport;
// an agent message alone is never authority.
//
// Files are read and written at this process's ordinary privilege level.
// Credential stores are excluded from file access. The active policy can
// revoke every entry point, and each call records audit intent before it acts.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assertActive } = require('../policy');
const audit = require('../audit');
const auditAdmission = require('../operation-audit');
const { canonicalizeForContainment } = require('../canonical-path');
const { withSharedWrite } = require('../shared-write-guard');

const HOME = process.platform === 'linux' ? os.userInfo().homedir : os.homedir();
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_LIST_ENTRIES = 5000;

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

// A small, extension-bounded set of conventional credential/session stores.
// This intentionally does not reject arbitrary files merely because their
// contents might be sensitive; the known stores above and these common data
// basenames are the protection boundary for this broad host surface.
//
// The password / *_key / private_key+service_account / keystore+kdbx+wallet
// stem groups match egress-preflight.js's CREDENTIAL_NAME_PATTERN, which that
// file's own comment says it mirrors, so a file named password.json,
// access_key.json, service_account.json or wallet.json anywhere inside the
// profile is neither readable through host.read_file nor visible in
// host.list_dir. Stems only: the extension list is bounded, so this does not
// become a rule about arbitrary files.
const COMMON_CREDENTIAL_STORE_PATTERN = /[\\/](?:\.(?:auth|token|tokens|cookie|cookies|credential|credentials|session|sessions|password|passwords|passwd|passphrase|passphrases|keystore|keystores|kdbx|wallet|wallets)|auth|token|tokens|cookie|cookies|credential|credentials|session|sessions|passwords?|passwd|passphrases?|(?:access|refresh|bearer)[._-]?(?:keys?|tokens?)|private[._-]?keys?|service[._-]?accounts?|keystores?|kdbx|wallets?)(?:[._-][^\\/]*)?\.(?:json|jsonl|ya?ml|toml|ini|cfg|conf|db|sqlite3?)$/i;

// A NAME pattern, beside the two above rather than folded into either.
//
// The two patterns above are PATH-shaped: EXCLUDED_PATH_PATTERNS matches
// credential DIRECTORIES, and COMMON_CREDENTIAL_STORE_PATTERN matches a
// conventional basename anchored to a path separator with a narrow extension
// tail that carries no pem/key/p12/pfx. Between them, a file named
// private_key.pem in an ordinary folder inside the profile would be readable
// through host.read_file, refused by neither this sink nor egress.
//
// This is the same four CLEAN stem groups and the same extension tail that
// src/lib/egress-preflight.js's CREDENTIAL_NAME_PATTERN already applies to the
// FILENAME ALONE, kept deliberately in that pattern's shape so the two read as
// the mirrors they are. Egress and read now agree on this class of name, which
// is the whole point: a file that cannot leave should not be readable either.
//
// THREE GROUPS ARE DELIBERATELY NOT PORTED to this name pattern:
//   1. extensionless "credentials" / "secrets"
//   2. the id_rsa family
//   3. stem-agnostic .pem / .jks / .kdbx / .ppk
// Each requires removing the mandatory extension tail (1, 2) or refusing on
// extension alone (3), which widens refusals for every caller of this surface.
// The exact private SSH key names of group 2 (id_rsa, id_ed25519 and the rest,
// not their .pub halves) are refused by EXCLUDED_PATH_PATTERNS above instead,
// as Claude subagents' read rules refuse them; the rest remain readable here
// and are named so the gap is visible rather than assumed closed.
//
// The stems are bounded on both sides so near-misses stay readable: an ordinary
// walletbuilder.pem, passenger.json, keyboard.pem, accessibility.json or
// service.pem is NOT refused. A rule that refuses ordinary work is not a safer
// rule.
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

function isCredentialProtectedPath(candidatePath) {
  return EXCLUDED_PATH_PATTERNS.some(pattern => pattern.test(candidatePath))
    || COMMON_CREDENTIAL_STORE_PATTERN.test(candidatePath)
    || isCredentialShapedName(candidatePath)
    || isProtectedEnvironmentPath(candidatePath);
}

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
  // Claude Code's own protected paths (https://code.claude.com/docs/en/permission-modes,
  // "Protected paths"), which package managers, build tools, editors and
  // dev containers load or run from a project. A Claude subagent cannot write
  // them through Claude Code; no subagent writes them through these tools.
  /[\\/]\.(?:yarn|mvn|cargo)([\\/]|$)/i,
  /[\\/](?:\.gitmodules|\.pnp\.cjs|\.pnp\.loader\.mjs|\.?bunfig\.toml|\.bazelrc|\.bazelversion|\.bazeliskrc|\.lefthook\.ya?ml|gradle-wrapper\.properties|maven-wrapper\.properties|\.devcontainer\.json|\.ripgreprc|pyrightconfig\.json)$/i,
  /[\\/]\.(?:bash_aliases|bash_logout|zlogout)$/i,
  // Agent instruction files, which the next Claude Code, Codex or Gemini
  // session in the project reads as the person's instructions, and build and
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
  // THE CODE-FOLDER RULE ITSELF LIVES IN WRITE_EXCLUDED_CODE_PATTERNS, directly
  // below. It names the folders where each package's own manifest says its
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

// THE PRODUCT CODE FOLDERS, kept apart from the anchors above because they are
// the one rule the person may lift (agent.product_source_writes) for checkouts
// that are not the running product. Same name-anchored convention as the list
// above; the tree-anchored twin is PRODUCT_TREE_CODE_PATTERNS below.
const WRITE_EXCLUDED_CODE_PATTERNS = [
  /[\\/]ToolsEnabled[^\\/]*[\\/](?:src|bin|shell|tools|scripts|sidecars|packages|captures|scratch|tmp)([\\/]|$)/i
];

// THE SAME ANCHORS, RELATIVE TO A RESOLVED PRODUCT TREE ROOT.
//
// Every rule in the list above reads `[\/]ToolsEnabled[^\/]*[\/]<protected>`,
// which requires the protected folder to be the IMMEDIATE CHILD of a directory
// literally named ToolsEnabled*. A checkout one level deeper --
// `.../toolsenabled/engine/config` -- matches none of those rules.
//
// A folder name is not an identity. These rules are anchored on a tree root
// discovered by walking UP from the candidate and asking the filesystem, so
// they hold wherever a checkout is and whatever it is named. The list above
// still covers sibling layouts (ToolsEnabled-copy/config) and the non-repo
// anchors (.gitconfig, Startup).
//
// Root-relative and separator-normalised, so one spelling covers both.
const PRODUCT_TREE_PROTECTED_PATTERNS = [
  /^state(\/|$)/i,
  // The code folders (`bin` and `shell` mirror the same addition in the list
  // above: the entry points each package's own manifest declares) live in
  // PRODUCT_TREE_CODE_PATTERNS below, the rule the person may lift.
  /^logs(\/|$)/i,
  /^\.git(\/|$)/i,
  /^node_modules(\/|$)/i,
  /^reports\/OWNER-REQUEST-LEDGER/i,
  /^STANDING-ORDERS\.md$/i,
  /^CLAUDE\.md$/i,
  /^AGENTS\.md$/i,
  /^GEMINI\.md$/i,
  /^BUILD-QUEUE\.md$/i,
  /^docs\/ROLE-OPERATIONS\.md$/i,
  /^reports\/TOOLSENABLED-SUGGESTIONS\.md$/i,
  /^config\/[^\/]*\.policy\.json$/i, // a policy file is enforcement, not source: anchored whatever the switch says
  /^KILLSWITCH$/i
];

// The tree-anchored twin of WRITE_EXCLUDED_CODE_PATTERNS: the product's code
// folders, root-relative. Refused by default; lifted for a checkout that is not
// the running product when the person turned agent.product_source_writes on.
const PRODUCT_TREE_CODE_PATTERNS = [
  /^(?:src|bin|shell|tools|scripts|sidecars|packages|captures|scratch|tmp)(\/|$)/i
];

// THE LIFTABLE ANCHORS. A checkout's config/ and lockfiles are part of the
// product's source too: an agent that changes a setting's registry row or a
// dependency has to write them. package.json stays an executable control path
// under the unconditional write exclusion above. The others stay refused
// unless the person lifted the code-folder rule (the same switch), and never in
// the running product.
const WRITE_EXCLUDED_LIFTABLE_PATTERNS = [
  /[\\/]ToolsEnabled[^\\/]*[\\/]config([\\/]|$)/i,
  /[\\/]ToolsEnabled[^\\/]*[\\/]package-lock\.json$/i,
  /[\\/]ToolsEnabled[^\\/]*[\\/](?:npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb)$/i
];
const PRODUCT_TREE_LIFTABLE_PATTERNS = [
  /^config(\/|$)/i,
  /^package-lock\.json$/i,
  /^(?:npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb)$/i
];

// Walking the filesystem on every path check would be a real cost, so the
// per-directory answer is memoised. The cache is keyed on the directory, not
// the file, because that is the unit the answer is a property of.
const PRODUCT_TREE_ROOT_CACHE = new Map();
const PRODUCT_TREE_WALK_LIMIT = 64;

// Is this directory the root of a ToolsEnabled tree? Asked of the FILESYSTEM,
// using markers the product itself ships, so it cannot be defeated by renaming
// a folder and does not need to know where a customer keeps their checkout.
//
// THROWS rather than returning false when it cannot tell. An unreadable
// directory is "could not look", not "not a product tree", and the caller
// turns that into a refusal -- the distinction this codebase keeps relearning.
function looksLikeProductTreeRoot(directory) {
  try {
    // Unique to a ToolsEnabled checkout, and cheaper than parsing JSON.
    fs.accessSync(path.join(directory, 'config', 'payload-boundary.json'));
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
  }
  let raw;
  try {
    raw = fs.readFileSync(path.join(directory, 'package.json'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
  // A malformed package.json is not evidence of anything either way, and must
  // not throw: unparseable manifests exist in the wild and refusing every
  // write beneath one would be a denial of service, not a fence.
  try {
    const name = JSON.parse(raw).name;
    return typeof name === 'string' && /^toolsenabled(-|$)/i.test(name);
  } catch { return false; }
}

// The nearest enclosing product tree root, or null when the path is not in
// one. Walks up rather than matching a name.
function productTreeRootFor(candidatePath) {
  let directory = path.dirname(candidatePath);
  const seen = [];
  for (let step = 0; step < PRODUCT_TREE_WALK_LIMIT; step += 1) {
    if (PRODUCT_TREE_ROOT_CACHE.has(directory)) {
      const cached = PRODUCT_TREE_ROOT_CACHE.get(directory);
      for (const entry of seen) PRODUCT_TREE_ROOT_CACHE.set(entry, cached);
      return cached;
    }
    if (looksLikeProductTreeRoot(directory)) {
      for (const entry of seen) PRODUCT_TREE_ROOT_CACHE.set(entry, directory);
      PRODUCT_TREE_ROOT_CACHE.set(directory, directory);
      return directory;
    }
    seen.push(directory);
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  for (const entry of seen) PRODUCT_TREE_ROOT_CACHE.set(entry, null);
  return null;
}

// THE PERSON MAY LET AGENTS EDIT THE PRODUCT'S OWN SOURCE IN A CHECKOUT.
//
// The code-folder rule exists so an agent cannot stage replacement product code
// through this surface. With "Available tool sets" set to Only, an agent writes
// through THIS surface and nothing else, so without a switch the same rule
// would refuse every edit to a checkout the person cloned for agents to work
// in. A fence must not gate the person: at most a warning, and the person
// decides.
//
// So the rule is a SETTING, agent.product_source_writes, off by default and
// read on every call through src/lib/product-source-writes.js (only a true the
// person or the installer chose counts, exactly like outside control). It lifts
// ONLY the code-folder rule, and NEVER for the running product: a candidate
// inside this process's own root, or inside the product tree that contains it
// (the host application's own src/ and shell/ around the packed capability layer),
// stays refused whatever the switch says. state/, config/, KILLSWITCH, .git,
// node_modules, the package manifests and the policy documents are anchors,
// not code folders, and stay refused in every checkout.
let productSourceWritesPolicy = null;

function runningProductRoot() {
  try { return path.resolve(require('../runtime').rootPath()); }
  catch { return null; }
}

function containsOrEquals(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && !relative.split(/[\\/]/).includes('..'));
}

// Is this candidate part of the product that is RUNNING right now? Either it
// sits inside the process's own root, or the nearest product tree around it
// contains that root (the app tree around the packed capability layer). A root
// that cannot be resolved answers "running": the fence fails closed.
function insideRunningProduct(candidatePath, productRoot) {
  const running = runningProductRoot();
  if (!running) return true;
  if (containsOrEquals(running, candidatePath)) return true;
  return productRoot !== null && productRoot !== undefined && containsOrEquals(productRoot, running);
}

function isProductCodeWriteAllowed(candidatePath, productRoot) {
  if (insideRunningProduct(candidatePath, productRoot)) return false;
  let policy;
  try {
    policy = (productSourceWritesPolicy || require('../product-source-writes').productSourceWritesPolicy)();
  } catch {
    // Could not read the person's choice: the rule stands.
    return false;
  }
  return Boolean(policy && policy.enabled === true);
}

// Test seam: hand in a policy function so the fence can be driven both ways
// without a settings file. `null` restores the real reader.
function setProductSourceWritesPolicyForTests(policy) {
  productSourceWritesPolicy = typeof policy === 'function' ? policy : null;
}

class HostControlError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HostControlError';
    this.code = code;
  }
}

function fail(code, message) { throw new HostControlError(code, message); }

function failCouldNotCheck(subject) {
  fail('HOST_PATH_CHECK_FAILED', `${subject} could not be checked; this does NOT claim that the path or entry is absent.`);
}

// Runtime state/control locations are integrity anchors regardless of their
// directory names. Resolve BOTH the selected roots and each candidate, so
// a custom host container, junction, or directory alias cannot grant writes.
// Called again by the byte adapter at staging/publication, not only admission.
function checkRuntimeWriteRoots(candidatePath) {
  let roots, canonical;
  try {
    const runtime = require('../runtime-state-root');
    const state = runtime.resolveStateRoot();
    roots = state.redirected ? [state.root]
      : [...runtime.RUNTIME_STATE_DIRECTORIES, ...runtime.RUNTIME_STATE_FILES].map(name => path.join(state.root, name));
    if (process.env.TOOLSENABLED_RUNTIME_MODE === 'host') {
      if (path.basename(state.root) !== 'capability' || path.dirname(state.root) === path.parse(state.root).root) {
        failCouldNotCheck('host control root');
      }
      roots.push(path.dirname(state.root));
    } else if (process.env.TOOLSENABLED_STATE_ROOT) {
      roots.push(require('../durable-memory-file').resolveServicesRoot());
      // This marker chooses the service/control store; it is an anchor too.
      roots.push(path.join(path.dirname(state.root), '.toolsenabled-local-profile.json'));
    }
    canonical = canonicalizeForContainment(candidatePath);
    roots = roots.flatMap(root => [path.resolve(root), canonicalizeForContainment(path.resolve(root))]);
  } catch { failCouldNotCheck('runtime state and control roots'); }
  if (roots.some(root => containsOrEquals(root, candidatePath) || containsOrEquals(root, canonical))) {
    fail('HOST_PATH_WRITE_PROTECTED', 'Fleet\'s own state and install folders are never writable through its file tools. Change Fleet\'s settings with /tefleet settings.');
  }
}

// The project this server was started for. serveHost() pins it from the
// record it starts with; the record is still read on every call, and once it
// names another project (Fleet was set up elsewhere), this server's file tools
// refuse instead of acting on the new project.
let pinnedHostWorkspace = null;
function pinHostWorkspace(workspaceRoots) {
  pinnedHostWorkspace = Array.isArray(workspaceRoots) && workspaceRoots.length
    ? Object.freeze(workspaceRoots.map(root => path.resolve(root))) : null;
}

function hostWorkspaceRecord() {
  let record;
  try {
    const records = require('../setup/machine-record');
    record = records.readMachineRecord({ servicesRoot: records.resolveServicesRoot({}), adopt: false });
  } catch { failCouldNotCheck('host workspace'); }
  if (!record || !Array.isArray(record.workspaceRoots) || !record.workspaceRoots.length) failCouldNotCheck('host workspace');
  if (pinnedHostWorkspace && (record.workspaceRoots.length !== pinnedHostWorkspace.length
      || record.workspaceRoots.some((root, index) => typeof root !== 'string' || path.resolve(root) !== pinnedHostWorkspace[index]))) {
    fail('HOST_WORKSPACE_CHANGED', 'Fleet is now set up for another project, so this session\'s file tools no longer act. Start a new session in that project.');
  }
  return record;
}

// Host mode has no OS sandbox. The sealed setup record, not a caller path or
// ambient cwd, is its write boundary. A missing/untrusted record fails closed.
// The check runs again at every mediated publication step.
function checkHostWorkspaceBoundary(candidatePath) {
  if (process.env.TOOLSENABLED_RUNTIME_MODE !== 'host') return;
  const record = hostWorkspaceRecord();
  let roots;
  try {
    roots = record.workspaceRoots.map(root => {
      const resolved = path.resolve(root);
      if (fs.lstatSync(resolved).isSymbolicLink()) failCouldNotCheck('host workspace');
      const canonical = canonicalizeForContainment(resolved);
      if (canonical !== resolved) failCouldNotCheck('host workspace');
      return canonical;
    });
  } catch { failCouldNotCheck('host workspace'); }
  if (!roots.some(root => containsOrEquals(root, candidatePath))) {
    fail('HOST_PATH_OUTSIDE_WORKSPACE', 'Host file access must stay inside the saved Fleet workspace.');
  }
}

function defaultHostListDirectory() {
  if (process.env.TOOLSENABLED_RUNTIME_MODE !== 'host') return HOME;
  const record = hostWorkspaceRecord();
  if (record.workspaceRoots.length === 1) return record.workspaceRoots[0];
  failCouldNotCheck('host workspace');
}

function checkExecutablePathDirectory(candidatePath) {
  if (process.env.TOOLSENABLED_RUNTIME_MODE !== 'host' || typeof process.env.PATH !== 'string') return;
  let directories;
  try {
    directories = process.env.PATH.split(path.delimiter)
      .flatMap(directory => [path.resolve(directory || process.cwd()),
        canonicalizeForContainment(path.resolve(directory || process.cwd()))]);
  } catch { failCouldNotCheck('executable search path'); }
  if (directories.some(directory => containsOrEquals(directory, candidatePath))) {
    fail('HOST_PATH_WRITE_PROTECTED', 'Executable search-path directories are not writable through the host file tools.');
  }
}

// Runs the containment + exclusion checks against ONE candidate path string.
// Called twice by resolveHostPath below: once on the lexical (path.resolve)
// form, once on the canonical (reparse-point-resolved) form. A lexical-only
// check is defeated by the legacy profile junctions Windows still creates for
// compatibility (Local Settings ->
// AppData\Local, Application Data -> AppData\Roaming, My Documents ->
// Documents): a caller spelling an excluded target through its legacy alias
// bypassed every pattern below, even though both spellings open the identical
// file. See src/lib/canonical-path.js.
function checkContainmentAndExclusions(candidatePath, { forWrite }) {
  const relativeToHome = path.relative(HOME, candidatePath);
  if (relativeToHome.startsWith('..') || path.isAbsolute(relativeToHome)) {
    fail('HOST_PATH_OUTSIDE_PROFILE', 'path must be inside your home folder.');
  }
  if (isCredentialProtectedPath(candidatePath)) {
    fail('HOST_PATH_FORBIDDEN', 'path holds credentials, sign-in sessions or environment secrets, which Fleet never reads or writes.');
  }
  if (forWrite) checkRuntimeWriteRoots(candidatePath);
  checkHostWorkspaceBoundary(candidatePath);
  if (forWrite) {
    checkExecutablePathDirectory(candidatePath);
    for (const pattern of WRITE_EXCLUDED_PATH_PATTERNS) {
      if (pattern.test(candidatePath)) {
        fail('HOST_PATH_WRITE_PROTECTED', 'path is a protected file, such as version control, CI, editor, package or build settings or a startup file, and Fleet\'s file tools never write it.');
      }
    }
    // The same anchors again, relative to a resolved tree root instead of a
    // folder name. See PRODUCT_TREE_PROTECTED_PATTERNS for why both exist.
    let productRoot;
    try {
      productRoot = productTreeRootFor(candidatePath);
    } catch {
      // COULD NOT LOOK. Refuse: an unreadable ancestor must never read as
      // "not a product tree", which would fail this fence OPEN exactly where
      // the filesystem is least cooperative.
      failCouldNotCheck('path against the product tree');
    }
    let withinTree = null;
    if (productRoot) {
      withinTree = path.relative(productRoot, candidatePath).split(path.sep).join('/');
      for (const pattern of PRODUCT_TREE_PROTECTED_PATTERNS) {
        if (pattern.test(withinTree)) {
          fail('HOST_PATH_WRITE_PROTECTED', 'path is a protected file, such as version control, CI, editor, package or build settings or a startup file, and Fleet\'s file tools never write it.');
        }
      }
    }
    // The code folders, last: refused unless the person lifted the rule for
    // checkouts, and never for the running product. See
    // isProductCodeWriteAllowed above.
    const codeFolder = WRITE_EXCLUDED_CODE_PATTERNS.some(pattern => pattern.test(candidatePath))
      || WRITE_EXCLUDED_LIFTABLE_PATTERNS.some(pattern => pattern.test(candidatePath))
      || (withinTree !== null && (PRODUCT_TREE_CODE_PATTERNS.some(pattern => pattern.test(withinTree))
        || PRODUCT_TREE_LIFTABLE_PATTERNS.some(pattern => pattern.test(withinTree))));
    if (codeFolder && !isProductCodeWriteAllowed(candidatePath, productRoot)) {
      fail('HOST_PATH_WRITE_PROTECTED', 'path is ToolsEnabled source code, which Fleet\'s file tools do not write.');
    }
  }
}

// Resolves a caller path and confirms it is inside the allowed tree (the
// saved project folder in host mode) and not in an excluded location. Absolute
// paths are allowed, but the containment and exclusion checks are not optional.
function resolveHostPath(value, { mustExist = false, forWrite = false } = {}) {
  if (typeof value !== 'string' || !value.trim()) fail('HOST_PATH_INVALID', 'path must be a non-empty string.');
  // A RELATIVE PATH IS NEVER RELATIVE TO process.cwd(), which is wherever this
  // engine process happens to run and nothing an MCP caller can see or name.
  // Host mode's boundary is the saved workspace, so there a relative path is
  // relative to the workspace root; elsewhere it is relative to the profile
  // root, which is what the tools that take one say. Anchoring this way can
  // only produce a path the fence would already admit, while cwd could produce
  // one outside it or silently name a different file. NOTHING IS RELAXED: the
  // lexical and canonical containment and exclusion checks below still run on
  // the result, so `../` out of the tree is refused. It also removes an ambient
  // dependency in the Windows drive-relative spelling: "C:foo" resolves under
  // the root rather than against the process's per-drive current directory.
  const resolved = path.isAbsolute(value) ? path.resolve(value)
    : path.resolve(process.env.TOOLSENABLED_RUNTIME_MODE === 'host' ? defaultHostListDirectory() : HOME, value);
  checkContainmentAndExclusions(resolved, { forWrite });
  // Canonicalize through the real filesystem (resolving any reparse point
  // anywhere in the ancestor chain -- a legacy Windows alias or one created
  // locally after the fact) and re-run the exact same checks against that
  // form. The lexical pass above is necessary but not sufficient; this is
  // what actually closes the bypass. The canonical form is used ONLY for
  // this verification -- resolveHostPath still RETURNS the lexical path, so
  // the OS's own reparse-point handling stays the source of truth for what
  // the caller's read/write/list actually touches.
  let canonical;
  try { canonical = canonicalizeForContainment(resolved); }
  catch { fail('HOST_PATH_INVALID', 'path could not be canonicalized against the real filesystem.'); }
  if (canonical !== resolved) checkContainmentAndExclusions(canonical, { forWrite });
  if (mustExist) {
    try { fs.accessSync(resolved); }
    catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') fail('HOST_PATH_NOT_FOUND', 'path does not exist.');
      failCouldNotCheck('path existence');
    }
  }
  return resolved;
}

// HOST BYTE MEDIATION. host.read_file, host.write_file and
// host.patch_file coordinate through a dedicated ByteAuthority instance
// (store <state>/state/byte-coordination-host, never the repo.* store) when
// the call carries the transport's private file scope. The legacy functions
// below are unchanged and still answer when the kill switch is off or when a
// caller supplies no transport scope. See docs/byte-coordination.md.
const HOST_BYTE_MEDIATION_ENV = 'TOOLSENABLED_HOST_BYTE_MEDIATION';
const HOST_BYTE_STORE = 'byte-coordination-host';

function hostByteMediationEnabled(env = process.env) {
  const value = env[HOST_BYTE_MEDIATION_ENV];
  if (value === undefined) return true;
  return !/^\s*(?:off|0|false|no|disabled)\s*$/i.test(String(value));
}

// The registry passes these two private keys only for a mediated dispatch.
function mediatedCall(dependencies) {
  return Boolean(dependencies) && typeof dependencies === 'object'
    && (Object.hasOwn(dependencies, 'fileToolContext') || Object.hasOwn(dependencies, 'fileToolInvocation'))
    && hostByteMediationEnabled();
}

function readFile(args = {}, dependencies = {}) {
  if (mediatedCall(dependencies)) return readFileMediated(args, dependencies);
  if (args && (args.startByte !== undefined || args.endByte !== undefined)) {
    assertActive('host.read_file');
    fail(hostByteMediationEnabled() ? 'HOST_FILE_SCOPE_REQUIRED' : 'HOST_BYTE_MEDIATION_OFF',
      'Byte-window reads require mediated host file access through a transport-bound file scope.');
  }
  return readFileLegacy(args, dependencies);
}

function writeFile(args = {}, dependencies = {}) {
  if (mediatedCall(dependencies)) return writeFileMediated(args, dependencies);
  return writeFileLegacy(args, dependencies);
}

/* THE FILE MUST STILL HAVE A NAME WHEN ITS BYTES ARE TAKEN.
 *
 * Checked on the OPEN DESCRIPTOR, so the answer describes the bytes actually
 * being read rather than whatever the path meant a moment ago. A descriptor
 * survives unlinking: without this, a file deleted between the check and the
 * read would still be served out of the open handle, disclosing content the
 * workspace no longer contains.
 *
 * MORE THAN ONE NAME IS ALLOWED, DELIBERATELY. An earlier version refused any
 * hard link, reasoning that the second name might sit outside the workspace
 * where no path check can see it. That is true, but it bought little and cost a
 * lot. `fs.protected_hardlinks` is 1 by default, so another account cannot link
 * a file it neither owns nor can write; producing a useful outside-to-inside
 * link needs code already running as the person, which can read the target
 * directly anyway. Git cannot carry a hard link, so a pull request cannot plant
 * one. Meanwhile pnpm stores node_modules as hard links into a shared store, so
 * refusing them refused ordinary dependency reads. Fleet promises PATH-level
 * workspace confinement, not inode-level; see SECURITY-SCOPE.md. */
function assertStillNamed(stat, what) {
  const links = typeof stat.nlink === 'bigint' ? stat.nlink : BigInt(stat.nlink);
  if (links < 1n) {
    fail('HOST_FILE_CHANGED_DURING_READ',
      `${what} was deleted while its bytes were being taken; read it again.`);
  }
}

function readFileLegacy({ path: target } = {}, dependencies = {}) {
  assertActive('host.read_file');
  const resolved = resolveHostPath(target, { mustExist: true });
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink()) fail('HOST_PATH_FORBIDDEN', 'symbolic links are not readable through this tool.');
  if (!stat.isFile()) fail('HOST_PATH_INVALID', 'path is not a regular file.');
  if (stat.size > MAX_FILE_BYTES) fail('HOST_FILE_TOO_LARGE', `file exceeds the ${MAX_FILE_BYTES}-byte limit.`);
  // The file contents are the outward result. Admission must be durable
  // before the read so an unavailable/corrupt audit ledger fails closed.
  // Same pattern as host.exec: validation above still throws
  // synchronously; admission is awaited off this thread before the read.
  //
  // THE DESCRIPTOR IS OPENED BEFORE ADMISSION AND READ AFTER IT. Re-opening by
  // pathname once admission resolved left a window in which the checked name
  // could come to mean a different file, so the bytes now come from the one
  // descriptor that was opened and checked. The open itself follows the path
  // checked a moment earlier; this is the path-level promise, and it does not
  // stop another process of the same account from swapping the file between
  // that check and the open.
  const descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let opened;
  try {
    opened = fs.fstatSync(descriptor);
    if (!opened.isFile()) fail('HOST_PATH_INVALID', 'path is not a regular file.');
    assertStillNamed(opened, 'this file');
    if (opened.size > MAX_FILE_BYTES) fail('HOST_FILE_TOO_LARGE', `file exceeds the ${MAX_FILE_BYTES}-byte limit.`);
  } catch (error) { fs.closeSync(descriptor); throw error; }
  const requireRecordAsync = dependencies.requireRecordAsync || auditAdmission.requireRecordAsync;
  const admitted = requireRecordAsync('host.read_file.intent', resolved, { bytes: opened.size });
  return admitted.then(
    () => {
      try {
        const again = fs.fstatSync(descriptor);
        if (again.ino !== opened.ino || again.dev !== opened.dev) {
          fail('HOST_FILE_CHANGED_DURING_READ', 'The file changed while it was being admitted; read it again.');
        }
        assertStillNamed(again, 'this file');
        return { path: resolved, content: fs.readFileSync(descriptor, 'utf8'), bytes: again.size };
      } finally { fs.closeSync(descriptor); }
    },
    error => { fs.closeSync(descriptor); throw error; }
  );
}

function writeFileLegacy({ path: target, content } = {}, dependencies = {}) {
  assertActive('host.write_file');
  if (typeof content !== 'string') fail('HOST_CONTENT_INVALID', 'content must be a string.');
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) fail('HOST_FILE_TOO_LARGE', `content exceeds the ${MAX_FILE_BYTES}-byte limit.`);
  const resolved = resolveHostPath(target, { forWrite: true });
  let existingIsSymlink = false;
  try { existingIsSymlink = fs.lstatSync(resolved).isSymbolicLink(); }
  catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') failCouldNotCheck('write target');
    /* ENOENT/ENOTDIR means there is no existing symlink to follow. */
  }
  if (existingIsSymlink) fail('HOST_PATH_FORBIDDEN', 'refusing to write through a symbolic link.');
  let canonicalTarget;
  try { canonicalTarget = canonicalizeForContainment(resolved); }
  catch { fail('HOST_PATH_INVALID', 'write target could not be canonicalized for shared-write ownership.'); }
  // Admission happens BEFORE the shared-write lock is taken, not inside its
  // callback: withSharedWrite (src/lib/shared-write-guard.js) releases the
  // lock in a `finally` around a synchronous `operation()` call, so an
  // awaited operation inside it would have its lock released the instant
  // the promise was created, not when the write actually finished.
  const requireRecordAsync = dependencies.requireRecordAsync || auditAdmission.requireRecordAsync;
  const admitted = requireRecordAsync('host.write_file.intent', resolved, { bytes: Buffer.byteLength(content, 'utf8') });
  return admitted.then(() => withSharedWrite(canonicalTarget, () => {
    // Audit admission yielded: recheck aliases and roots before publishing.
    resolveHostPath(resolved, { forWrite: true });
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    const temp = `${resolved}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, content, 'utf8');
    fs.renameSync(temp, resolved);
    return { path: resolved, bytes: Buffer.byteLength(content, 'utf8') };
  }));
}

// ---------------------------------------------------------------------------
// Mediated host file access.
// ---------------------------------------------------------------------------
let hostAuthorityInstance;
let hostAuthorityStateRoot;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const CREATE_OPERATION_ID = /^operation-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function fileToolContexts() { return require('../file-tool-capabilities'); }
function byteAuthorityModule() { return require('../region-holds/byte-authority'); }

// The authority resource is the canonical absolute path. Mediated tools refuse
// a spelling whose canonical form the authority would normalize differently
// (surrounding whitespace), so the resource and the published file never differ.
function hostResource(resolved) {
  let canonical;
  try { canonical = canonicalizeForContainment(resolved); }
  catch { fail('HOST_PATH_INVALID', 'path could not be canonicalized against the real filesystem.'); }
  if (canonical !== canonical.trim() || path.basename(canonical) !== path.basename(canonical).trim()) {
    fail('HOST_PATH_INVALID', 'mediated host file tools refuse paths that begin or end with whitespace.');
  }
  return canonical;
}

// The authority's comparison key is case-folded on Windows (resourceKey);
// filesystem calls use the actual canonical spelling, as repo-files does.
const hostKey = value => process.platform === 'win32' ? String(value).toLowerCase() : String(value);

// Re-runs the host fence on the authority's canonical resource at every
// adapter step (materialization, staging, publication, recovery), so a path
// that became protected or aliased after admission is never touched. Returns
// the canonical spelling to operate on.
function hostAdapterPath(resource, { forWrite = false, publicationPath } = {}) {
  if (publicationPath !== undefined && hostKey(publicationPath) !== hostKey(resource)) {
    fail('HOST_FILE_IDENTITY_CHANGED', 'The publication path is not the coordinated resource.');
  }
  const resolved = resolveHostPath(publicationPath === undefined ? resource : publicationPath, { forWrite });
  const canonical = hostResource(resolved);
  if (hostKey(resolved) !== hostKey(resource) || hostKey(canonical) !== hostKey(resource)) {
    fail('HOST_FILE_IDENTITY_CHANGED', 'The file\'s canonical location changed; read it again.');
  }
  return canonical;
}

function materializeHost(resource) {
  const resolved = hostAdapterPath(resource);
  let descriptor;
  let openedSnapshot = false;
  const same = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);
  try {
    const before = fs.lstatSync(resolved, { bigint: true });
    openedSnapshot = true;
    if (before.isSymbolicLink()) fail('HOST_PATH_FORBIDDEN', 'symbolic links are not readable through this tool.');
    if (!before.isFile()) fail('HOST_PATH_INVALID', 'path is not a regular file.');
    if (before.size > BigInt(MAX_FILE_BYTES)) fail('HOST_FILE_TOO_LARGE', `file exceeds the ${MAX_FILE_BYTES}-byte limit.`);
    descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!same(before, opened)) fail('HOST_FILE_CHANGED_DURING_READ', 'The file changed while opening it; read it again.');
    assertStillNamed(opened, 'this file');
    // One byte beyond the stat size detects a file that grows during the read.
    const buffer = Buffer.allocUnsafe(Number(before.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(descriptor, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    hostAdapterPath(resource);
    if (!same(before, after) || !same(after, fs.lstatSync(resolved, { bigint: true })) || BigInt(length) !== after.size) {
      fail('HOST_FILE_CHANGED_DURING_READ', 'The file changed while its bytes were being observed; read it again.');
    }
    return { bytes: Buffer.from(buffer.subarray(0, length)), identity: `${after.dev}:${after.ino}` };
  } catch (error) {
    if ((error?.code === 'ENOENT' || error?.code === 'ENOTDIR') && !openedSnapshot) return { present: false };
    if (error?.code === 'ENOENT') fail('HOST_FILE_CHANGED_DURING_READ', 'The file disappeared while its bytes were being observed; read it again.');
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function publishHost(publication) {
  // Synchronous by design: withSharedWrite must never release its lock around
  // an unfinished Promise. The key is the canonical target, the same key the
  // legacy writer takes, so legacy and mediated writers exclude each other.
  return withSharedWrite(publication.resource, () => publishHostLocked(publication));
}

function publishHostLocked(publication) {
  const { resource, publicationPath, before, after, beforeSha256, afterSha256, assertCurrent } = publication;
  const resolved = hostAdapterPath(resource, { forWrite: true, publicationPath });
  if (!Buffer.isBuffer(after) || after.length > MAX_FILE_BYTES || sha256(after) !== afterSha256) fail('HOST_FILE_PUBLICATION_INVALID', 'The prepared bytes are invalid.');
  if (typeof assertCurrent !== 'function') fail('HOST_FILE_SCOPE_REQUIRED', 'Publication requires a live private transport scope.');
  if (publication.beforePresent === false) return publishHostCreate(publication);
  const current = materializeHost(resource).bytes;
  if (!current || sha256(current) !== beforeSha256 || !current.equals(before)) fail('HOST_FILE_CHANGED_BEFORE_WRITE', 'The file changed outside mediated coordination; no write was published.');
  assertCurrent();
  const mode = fs.lstatSync(resolved).mode;
  const temporary = path.join(path.dirname(resolved), `.te-replace-${process.pid}-${crypto.randomUUID()}.tmp`);
  let descriptor;
  let temporaryOwned = false;
  try {
    descriptor = fs.openSync(temporary, 'wx', mode);
    temporaryOwned = true;
    fs.writeFileSync(descriptor, after);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor); descriptor = undefined;
    // An unmediated editor is outside the authority lock; observed drift still refuses.
    if (!materializeHost(resource).bytes?.equals(before)) fail('HOST_FILE_CHANGED_BEFORE_WRITE', 'The file changed before publication; no write was published.');
    // No await between this private revocation check and publication.
    assertCurrent();
    fs.renameSync(temporary, resolved);
    temporaryOwned = false;
    return { published: true };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    // Only this call's exact, exclusively-created temporary leaf is removed.
    if (temporaryOwned) {
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}

function hostCreationPaths({ resource, publicationPath, operationId, stagingPath, createPreparation }) {
  if (typeof publicationPath !== 'string') fail('HOST_FILE_CREATE_IDENTITY_INVALID', 'Creation requires the authority publication path.');
  const resolved = hostAdapterPath(resource, { forWrite: true, publicationPath });
  if (typeof operationId !== 'string' || !CREATE_OPERATION_ID.test(operationId)) {
    fail('HOST_FILE_CREATE_IDENTITY_INVALID', 'Creation requires an authority-owned operation identity.');
  }
  // The authority derives the stage from publicationPath; it must be the exact
  // sibling of the canonical target, never an arbitrary cleanup path.
  const expected = path.join(path.dirname(publicationPath), '.te-' + operationId + '.create.tmp');
  if ((stagingPath || createPreparation?.stagingPath) !== expected || path.dirname(expected) !== path.dirname(resolved)) {
    fail('HOST_FILE_CREATE_IDENTITY_INVALID', 'The staged creation path is not the exact operation-owned sibling.');
  }
  return { resolved, stagingPath: expected };
}

function hostCreationStat(filename) {
  try { return fs.lstatSync(filename, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function verifyHostCreationLeaf(filename, preparation, links) {
  const before = hostCreationStat(filename);
  const matches = stat => stat && stat.isFile() && !stat.isSymbolicLink()
    && stat.dev.toString() === preparation.device && stat.ino.toString() === preparation.inode
    && stat.size === BigInt(preparation.bytes) && stat.nlink === BigInt(links);
  if (!matches(before)) fail('HOST_FILE_CREATE_IDENTITY_INVALID', 'The creation leaf no longer has its prepared identity and exact link count.');
  const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (!matches(fs.fstatSync(descriptor, { bigint: true }))) fail('HOST_FILE_CREATE_IDENTITY_INVALID', 'The creation leaf changed while opening.');
    const buffer = Buffer.alloc(preparation.bytes + 1);
    let count = 0;
    while (count < buffer.length) {
      const read = fs.readSync(descriptor, buffer, count, buffer.length - count, null);
      if (!read) break;
      count += read;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    const final = hostCreationStat(filename);
    if (!matches(after) || !matches(final) || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
        || after.mtimeNs !== final.mtimeNs || after.ctimeNs !== final.ctimeNs
        || count !== preparation.bytes || sha256(buffer.subarray(0, count)) !== preparation.sha256) {
      fail('HOST_FILE_CREATE_IDENTITY_INVALID', 'The creation leaf changed while its prepared bytes were verified.');
    }
  } finally { fs.closeSync(descriptor); }
}

function prepareHostCreate(preparation) {
  const { after, afterSha256, assertCurrent } = preparation;
  const located = hostCreationPaths(preparation);
  if (!Buffer.isBuffer(after) || after.length > MAX_FILE_BYTES || sha256(after) !== afterSha256 || typeof assertCurrent !== 'function') {
    fail('HOST_FILE_CREATE_IDENTITY_INVALID', 'Creation requires bounded prepared bytes and a live private scope.');
  }
  assertCurrent();
  // The legacy writer created missing parent directories; so does creation.
  fs.mkdirSync(path.dirname(located.resolved), { recursive: true });
  hostCreationPaths(preparation);
  const descriptor = fs.openSync(located.stagingPath, 'wx');
  // Before PREPARED, a crash can leave an unreferenced exclusive stage. It is
  // never a published target, and recovery must not infer ownership by age.
  try {
    fs.writeFileSync(descriptor, after);
    fs.fsyncSync(descriptor);
    const stat = fs.fstatSync(descriptor, { bigint: true });
    const result = { stagingPath: located.stagingPath, device: stat.dev.toString(), inode: stat.ino.toString(), sha256: afterSha256, bytes: after.length };
    verifyHostCreationLeaf(located.stagingPath, result, 1);
    assertCurrent();
    return result;
  } finally { fs.closeSync(descriptor); }
}

function publishHostCreate(publication) {
  const { resolved, stagingPath } = hostCreationPaths(publication);
  const { createPreparation, assertCurrent } = publication;
  if (publication.op !== 'write' || publication.publicationMode !== 'create-only') {
    fail('HOST_FILE_CREATE_IDENTITY_INVALID', 'Creation must use atomic no-replace publication.');
  }
  verifyHostCreationLeaf(stagingPath, createPreparation, 1);
  hostCreationPaths(publication);
  assertCurrent();
  // link() is an atomic no-replace publication: EEXIST never erases a file
  // another writer created first.
  try { fs.linkSync(stagingPath, resolved); }
  catch (error) {
    if (error && error.code === 'EEXIST') {
      // Proven unapplied: retire only this operation's own verified stage.
      verifyHostCreationLeaf(stagingPath, createPreparation, 1);
      fs.unlinkSync(stagingPath);
      throw Object.assign(new HostControlError('HOST_FILE_CREATE_CONFLICT',
        'Another writer created this file first; nothing was written. Read it with host.read_file and reconcile.'), { publicationNotApplied: true });
    }
    throw error;
  }
  reconcileHostCreate({ ...publication, afterBytes: publication.after.length });
  return { published: true, publicationMode: 'create-only' };
}

function reconcileHostCreate(publication) {
  const { resolved, stagingPath } = hostCreationPaths(publication);
  const { createPreparation: preparation, afterSha256, afterBytes } = publication;
  if (!preparation || preparation.sha256 !== afterSha256 || preparation.bytes !== afterBytes
      || !Number.isSafeInteger(afterBytes) || afterBytes < 0 || afterBytes > MAX_FILE_BYTES) {
    fail('HOST_FILE_CREATE_IDENTITY_INVALID', 'Creation recovery requires the exact bounded prepared digest.');
  }
  const stage = hostCreationStat(stagingPath);
  const target = hostCreationStat(resolved);
  const links = stage && target ? 2 : 1;
  // Matching bytes alone are not this publication's identity. A replaced
  // target, an unrelated hard link or a changed stage remains UNKNOWN.
  if (target) verifyHostCreationLeaf(resolved, preparation, links);
  if (stage) {
    verifyHostCreationLeaf(stagingPath, preparation, links);
    hostCreationPaths(publication);
    fs.unlinkSync(stagingPath);
  }
  if (target) verifyHostCreationLeaf(resolved, preparation, 1);
  return { reconciled: true };
}

function hostByteAuthority(scope) {
  const stateRoot = require('../runtime-state-root').statePath();
  if (!hostAuthorityInstance || hostAuthorityStateRoot !== stateRoot) {
    hostAuthorityInstance = byteAuthorityModule().createByteAuthority({
      stateRoot, storeName: HOST_BYTE_STORE, maxResourceBytes: MAX_FILE_BYTES,
      readSetScope: 'resource', writeRequiresObservation: true, observeOwnWrites: true, pruneCommittedPayloads: true,
      materialize: materializeHost, publish: publishHost,
      prepareCreate: prepareHostCreate, reconcileCreateStage: reconcileHostCreate
    });
    hostAuthorityStateRoot = stateRoot;
  }
  if (scope) {
    const contexts = fileToolContexts();
    const binding = contexts.requireFileToolContext(scope);
    const authority = hostAuthorityInstance;
    contexts.onFileToolContextRetired(scope, authority, reason => authority.closeLaunch({ binding, reason }));
  }
  return hostAuthorityInstance;
}

function decodeHostWindow(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { fail('HOST_FILE_UTF8_BOUNDARY_INVALID', 'The requested byte window is not complete UTF-8 text; use character-aligned startByte/endByte offsets or read the whole file.'); }
}

function describeRepairs(repairs) {
  if (!Array.isArray(repairs) || repairs.length === 0) return '';
  const reasons = {
    UNMEDIATED_CHANGE: 'changed outside mediated tools (a shell command, a native tool or another process)',
    WHOLE_FILE_WRITE: 'replaced by a whole-file write from another session',
    MEDIATED_WRITE: 'patched by another session',
    OBSERVATION_EXPIRED: 'your observation expired',
    OBSERVED_BYTES_CHANGED: 'its bytes changed',
    DEPENDENCY_ABSENT: 'the file was deleted',
    DEPENDENCY_UNREADABLE: 'the file could not be read'
  };
  const shown = repairs.slice(0, 4).map(item => {
    const range = Number.isSafeInteger(item.startByte) && Number.isSafeInteger(item.endByte) && !item.requiresWholeFileRead
      ? ` (bytes ${item.startByte}-${item.endByte})` : '';
    return (reasons[item.reason] || 'stale') + range;
  });
  return ` Detail: ${[...new Set(shown)].join('; ')}${repairs.length > 4 ? '; ...' : ''}.`;
}

// Authority refusals keep their exact meaning; the two an agent must act on
// get a host code and a sentence that says what to do next.
function hostRefusal(error, displayPath, action) {
  const { ByteCoordinationRefusal } = byteAuthorityModule();
  if (!(error instanceof ByteCoordinationRefusal)) throw error;
  if (error.code === 'BYTE_READ_SET_STALE') {
    throw Object.assign(new HostControlError('HOST_FILE_STALE',
      `${displayPath} changed since this session read it (another agent's write, a shell command, a native tool or an external process). Nothing was ${action}. Re-read it with host.read_file (the whole file, or the changed byte window), reconcile your edit with the current content, then retry.${describeRepairs(error.details.repairs)}`),
    { details: { resource: displayPath, repairs: error.details.repairs }, cause: error });
  }
  if (error.code === 'BYTE_READ_REQUIRED') {
    throw Object.assign(new HostControlError('HOST_FILE_READ_REQUIRED',
      `This session has not read the current content of ${displayPath}${action === 'patched' ? ' where this patch applies' : ''}. Nothing was ${action}. Read it with host.read_file first, then retry; for an edit, prefer host.patch_file.`),
    { details: { resource: displayPath }, cause: error });
  }
  if (error.code === 'BYTE_CREATE_CONFLICT') {
    throw Object.assign(new HostControlError('HOST_FILE_STALE',
      `Another writer created ${displayPath} first. Nothing was ${action}. Read it with host.read_file and reconcile, then retry.`),
    { details: { resource: displayPath, repairs: [] }, cause: error });
  }
  throw error;
}

function committedAfterRevocation(applied, resource, what, error) {
  return Object.assign(new HostControlError('BYTE_PUBLICATION_COMMITTED_SCOPE_REVOKED',
    `The ${what} committed before this scope was revoked; inspect before retrying.`), {
    details: { publicationCommitted: true, operationId: applied.receipt.operationId,
      noOp: applied.receipt.noOp, resource, causeCode: error.code || 'SCOPE_REVOKED' }
  });
}

function beginMediated(dependencies, toolName, target) {
  const contexts = fileToolContexts();
  const scope = dependencies.fileToolContext;
  const binding = contexts.requireFileToolContext(scope);
  const invocation = dependencies.fileToolInvocation;
  const currentToolInvocation = contexts.consumeFileToolInvocation(invocation, scope, toolName);
  const assertCurrent = () => {
    assertActive(toolName);
    return contexts.assertFileToolInvocationCurrent(invocation, scope, toolName);
  };
  return { scope, binding, currentToolInvocation, assertCurrent };
}

function checkedWindow(value, field) {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    fail('HOST_INPUT_INVALID', `${field} must be a non-negative integer byte offset.`);
  }
  return value;
}

function readFileMediated({ path: target, startByte, endByte } = {}, dependencies = {}) {
  assertActive('host.read_file');
  checkedWindow(startByte, 'startByte');
  checkedWindow(endByte, 'endByte');
  const resolved = resolveHostPath(target);
  // Existence is asked exactly as the legacy reader asked it (accessSync
  // follows links), so a missing file or dangling link refuses identically.
  let exists = true;
  try { fs.accessSync(resolved); }
  catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') failCouldNotCheck('path existence');
    exists = false;
  }
  if (!exists) {
    let dangling = false;
    try { dangling = fs.lstatSync(resolved).isSymbolicLink(); } catch { /* absent */ }
    if (dangling) fail('HOST_PATH_NOT_FOUND', 'path does not exist.');
    // Observing absence retires this scope's stale observations of a vanished
    // file (so it may create it again); it releases no content.
    const mediated = beginMediated(dependencies, 'host.read_file', resolved);
    const resource = hostResource(resolved);
    return hostByteAuthority(mediated.scope).observeAbsence({ binding: mediated.binding, resource, assertCurrent: mediated.assertCurrent })
      .then(() => fail('HOST_PATH_NOT_FOUND', 'path does not exist.'));
  }
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink()) fail('HOST_PATH_FORBIDDEN', 'symbolic links are not readable through this tool.');
  if (!stat.isFile()) fail('HOST_PATH_INVALID', 'path is not a regular file.');
  if (stat.size > MAX_FILE_BYTES) fail('HOST_FILE_TOO_LARGE', `file exceeds the ${MAX_FILE_BYTES}-byte limit.`);
  const resource = hostResource(resolved);
  const { scope, binding, currentToolInvocation, assertCurrent } = beginMediated(dependencies, 'host.read_file', resolved);
  const windowed = startByte !== undefined || endByte !== undefined;
  // Admission is durable before any byte is read, exactly as in the legacy path.
  const requireRecordAsync = dependencies.requireRecordAsync || auditAdmission.requireRecordAsync;
  const admitted = requireRecordAsync('host.read_file.intent', resolved, windowed
    ? { bytes: stat.size, startByte: startByte ?? 0, endByte: endByte ?? null } : { bytes: stat.size });
  return admitted.then(() => {
    assertCurrent();
    return hostByteAuthority(scope).observeRead({
      binding, resource, startByte, endByte, assertCurrent,
      // A window must be character-aligned UTF-8; a whole file decodes as the
      // legacy reader did (invalid sequences become U+FFFD), never refused.
      validateRead: windowed ? ({ bytes }) => decodeHostWindow(bytes) : undefined
      });
  }).then(observed => {
    assertCurrent();
    const receipt = observed.receipt;
    return {
      path: resolved,
      content: windowed ? decodeHostWindow(observed.bytes) : observed.bytes.toString('utf8'),
      bytes: observed.bytes.length,
      ...(windowed ? { startByte: receipt.startByte, endByte: receipt.endByte, totalBytes: receipt.totalBytes } : {}),
      version: receipt.resourceVersion,
      receipt,
      invalidations: observed.invalidations,
      currentToolInvocation
    };
  }, error => hostRefusal(error, resolved, 'read'));
}

function writeFileMediated({ path: target, content } = {}, dependencies = {}) {
  assertActive('host.write_file');
  if (typeof content !== 'string') fail('HOST_CONTENT_INVALID', 'content must be a string.');
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) fail('HOST_FILE_TOO_LARGE', `content exceeds the ${MAX_FILE_BYTES}-byte limit.`);
  const resolved = resolveHostPath(target, { forWrite: true });
  let existingIsSymlink = false;
  try { existingIsSymlink = fs.lstatSync(resolved).isSymbolicLink(); }
  catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') failCouldNotCheck('write target');
  }
  if (existingIsSymlink) fail('HOST_PATH_FORBIDDEN', 'refusing to write through a symbolic link.');
  const resource = hostResource(resolved);
  const bytes = Buffer.from(content, 'utf8');
  const { scope, binding, currentToolInvocation, assertCurrent } = beginMediated(dependencies, 'host.write_file', resolved);
  const requireRecordAsync = dependencies.requireRecordAsync || auditAdmission.requireRecordAsync;
  const admitted = requireRecordAsync('host.write_file.intent', resolved, { bytes: bytes.length });
  return admitted.then(() => {
    assertCurrent();
    return hostByteAuthority(scope).applyWrite({ binding, resource, bytes, assertCurrent });
  })
    .then(applied => {
      try { assertCurrent(); }
      catch (error) { throw committedAfterRevocation(applied, resolved, 'whole-file write', error); }
      return {
        path: resolved, bytes: bytes.length, created: applied.created,
        version: applied.receipt.resourceVersion, receipt: applied.receipt,
        ...(applied.observation ? { observation: applied.observation } : {}),
        currentToolInvocation
      };
    }, error => hostRefusal(error, resolved, 'written'));
}

function patchFile({ path: target, oldText, newText } = {}, dependencies = {}) {
  assertActive('host.patch_file');
  if (!hostByteMediationEnabled()) {
    fail('HOST_BYTE_MEDIATION_OFF', `host.patch_file requires host byte mediation, which is turned off on this machine (${HOST_BYTE_MEDIATION_ENV}=off). Use host.read_file and host.write_file instead.`);
  }
  if (typeof oldText !== 'string' || oldText.length === 0) fail('HOST_INPUT_INVALID', 'oldText must be a non-empty string.');
  if (typeof newText !== 'string') fail('HOST_INPUT_INVALID', 'newText must be a string.');
  const resolved = resolveHostPath(target, { forWrite: true, mustExist: true });
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink()) fail('HOST_PATH_FORBIDDEN', 'refusing to patch through a symbolic link.');
  if (!stat.isFile()) fail('HOST_PATH_INVALID', 'path is not a regular file.');
  if (stat.size > MAX_FILE_BYTES) fail('HOST_FILE_TOO_LARGE', `file exceeds the ${MAX_FILE_BYTES}-byte limit.`);
  if (!mediatedCall(dependencies)) {
    fail('HOST_FILE_SCOPE_REQUIRED', 'host.patch_file requires the transport-bound file scope of an MCP session; it has no unmediated form.');
  }
  const resource = hostResource(resolved);
  const expected = Buffer.from(oldText, 'utf8');
  const replacement = Buffer.from(newText, 'utf8');
  const { scope, binding, currentToolInvocation, assertCurrent } = beginMediated(dependencies, 'host.patch_file', resolved);
  const requireRecordAsync = dependencies.requireRecordAsync || auditAdmission.requireRecordAsync;
  const admitted = requireRecordAsync('host.patch_file.intent', resolved, {
    replacedBytes: expected.length, replacementBytes: replacement.length
  });
  return admitted.then(() => {
    assertCurrent();
    return hostByteAuthority(scope).applyPatch({
      binding, resource, assertCurrent,
      derivePatch: ({ bytes }) => {
        const first = bytes.indexOf(expected);
        if (first === -1) fail('HOST_FILE_PATCH_MISMATCH', 'oldText was not found in the current file; read it again and retry with an exact span.');
        if (bytes.indexOf(expected, first + 1) !== -1) fail('HOST_FILE_PATCH_AMBIGUOUS', 'oldText occurs more than once; include more surrounding text so the match is unique.');
        if (bytes.length - expected.length + replacement.length > MAX_FILE_BYTES) fail('HOST_FILE_TOO_LARGE', `the patched file would exceed the ${MAX_FILE_BYTES}-byte limit.`);
        return { startByte: first, endByte: first + expected.length, replacement };
      }
      });
  }).then(applied => {
    try { assertCurrent(); }
    catch (error) { throw committedAfterRevocation(applied, resolved, 'patch', error); }
    return { path: resolved, bytes: applied.bytes, replacements: 1, startByte: applied.startByte, endByte: applied.endByte,
      version: applied.receipt.resourceVersion, receipt: applied.receipt, currentToolInvocation };
  }, error => hostRefusal(error, resolved, 'patched'));
}

function listDir({ path: target = defaultHostListDirectory() } = {}, dependencies = {}) {
  assertActive('host.list_dir');
  const resolved = resolveHostPath(target, { mustExist: true });
  if (!fs.lstatSync(resolved).isDirectory()) fail('HOST_PATH_INVALID', 'path is not a directory.');
  // Admission precedes readdirSync and the per-entry metadata reads below.
  const requireRecordAsync = dependencies.requireRecordAsync || auditAdmission.requireRecordAsync;
  const recordAsync = dependencies.recordAsync || auditAdmission.recordAsync;
  const admitted = requireRecordAsync('host.list_dir.intent', resolved, {});
  return admitted.then(() => {
    const entries = listDirEntries(resolved);
    // The result record rides the same off-thread admission as the intent;
    // a failed record write is reported on stderr, redacted, and never turns
    // a completed listing into a lost answer.
    return Promise.resolve()
      .then(() => recordAsync('host.list_dir', resolved, { entries: entries.length }))
      .catch(auditError => {
        process.stderr.write(`Fleet host.list_dir audit write failed: ${audit.redact(auditError && auditError.message || String(auditError))}\n`);
      })
      .then(() => {
        return { path: resolved, entries };
      });
  });
}

function listDirEntries(resolved, snapshot) {
  return (snapshot || fs.readdirSync(resolved, { withFileTypes: true }))
    // Listing a parent must not disclose the names of protected stores (or a
    // harmlessly-named reparse point whose target is one). Fail closed for a
    // child that disappears while the directory is being inspected.
    .filter(entry => {
      const lexicalChild = path.join(resolved, entry.name);
      if (isCredentialProtectedPath(lexicalChild)) return false;
      try {
        const canonicalChild = canonicalizeForContainment(lexicalChild);
        return !isCredentialProtectedPath(canonicalChild);
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
        failCouldNotCheck('directory entry');
      }
    })
    .slice(0, MAX_LIST_ENTRIES)
    .map(entry => {
      const row = { name: entry.name, type: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file' };
      if (row.type === 'file') {
        try { row.bytes = fs.lstatSync(path.join(resolved, entry.name)).size; }
        catch (error) {
          if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') failCouldNotCheck('directory entry metadata');
          row.bytes = null;
        }
      }
      return row;
    });
}

module.exports = {
  HostControlError, HOME, MAX_FILE_BYTES, EXCLUDED_PATH_PATTERNS,
  HOST_BYTE_MEDIATION_ENV, HOST_BYTE_STORE, hostByteMediationEnabled,
  isCredentialProtectedPath, pinHostWorkspace,
  resolveHostPath, readFile, writeFile, patchFile, listDir,
  // Test seam for the person's product-source switch; never a registered tool.
  setProductSourceWritesPolicyForTests,
  // Internal adapter seam for tests, never a registered tool or serialized capability.
  hostCoordination: Object.freeze({
    authority: hostByteAuthority, materialize: materializeHost, publish: publishHost,
    prepareCreate: prepareHostCreate, reconcileCreateStage: reconcileHostCreate
  })
};
