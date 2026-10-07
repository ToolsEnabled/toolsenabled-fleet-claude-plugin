import { atom, read, update } from 'claude-code'
import type { Register, Timer } from 'claude-code'
import type { FleetSnapshot, FleetTree } from '../types'
import { parsePage, age } from './ledger-view.mjs'
import { parseSessionLine, rows, summary, panesSupported, REPORT_NOTICE } from './view.mjs'

const PANE = 'toolsenabled-fleet-tree'
const SETUP_PANE = 'toolsenabled-fleet-setup'
const PANES_NEED = "Fleet's panes need Claude Code 2.1.287 or newer in a terminal. Everything else works with /tefleet: setup, settings and ledger."
const EMPTY: FleetSnapshot = { trees: [], at: 0, error: '', notice: 'run /fleet setup', warning: true, reportsReady: null }
const snapshot = atom({ plugin: 'toolsenabled-fleet', key: 'snapshot' } as const, EMPTY)
const MARK: Record<string, string> = { running: '●', waiting: '◐', idle: '○', done: '✓', failed: '✗' }
const COLOR: Record<string, string> = { running: 'green', waiting: 'yellow', idle: 'gray', done: 'cyan', failed: 'red' }

type SetupPreview = { workspace: string; names: string; subagents: boolean; note: string; env: Record<string, string>; duplicate: string }
let pendingSetup: SetupPreview | null = null
let setupResult = ''

let lastFrame: FleetTree[] = []
let refreshing = false
let startupUntil = 0
let hasFrame = false
let accessDenied = false
let leadTurn: string | null = null
let turnRevision = 0
let reportSession = ''
let reportNotified = false

let active: AsyncGenerator<any, any> | null = null
let generation = 0
let alive = false
let supported = true
let settingUp = false
let restartNeeded = false
let retryDelay = 5000
let stopRetry: Timer | null = null
let stopClock: Timer | null = null

// The programs started here inherit Claude Code's own environment, as every program a plugin starts does;
// Fleet reads none of it. No credential value enters argv.

async function setStatus($: any, text: string, warning = false) {
  await update($, snapshot, previous => ({ ...previous, notice: text, warning }))
  // ui.status is always a yellow warning on 2.1.287. Render our own neutral
  // healthy line at the documented AbovePrompt site instead.
  $.ui.status(undefined)
  $.ui.invalidate('ui.render')
}

async function publish($: any, trees: FleetTree[], fresh = true) {
  lastFrame = trees
  if (refreshing) return
  refreshing = true
  const mine = generation
  const turnAtRead = turnRevision
  try {
    const binding = trees.length === 1 ? trees[0] : null
    const startedAt = binding?.nodes.find(node => node.role === 'lead')?.startedAt
    if (!binding?.live || !startedAt) {
      if (!hasFrame && await $.clock.now() < startupUntil) { await setStatus($, 'starting'); return }
      throw new Error('Session binding unavailable')
    }
    hasFrame = true
    if (mine !== generation || !alive) return
    const selected = [binding]
    // The child reads a fresh, exact-owner canonical projection. No tool calls.
    const reportsReady = binding.reportsReady
    const identity = `${binding.treeKey}:${startedAt}`
    if (reportSession !== identity) { reportSession = identity; reportNotified = false }
    if (reportsReady === 0) reportNotified = false
    retryDelay = 5000
    const at = await $.clock.now()
    await update($, snapshot, previous => ({ ...previous, trees: selected, at, error: '', reportsReady }))
    const reports = reportsReady > 0 ? ` · ${reportsReady} report${reportsReady === 1 ? '' : 's'} ready — say continue` : ''
    await setStatus($, restartNeeded ? 'ready: restart Claude' : summary(selected) + reports, restartNeeded)
    if (fresh && mine === generation && alive && !settingUp && !restartNeeded && leadTurn === null
        && turnAtRead === turnRevision && reportsReady > 0 && !reportNotified) {
      reportNotified = true
      // 2.1.287 ui.notice attaches to a tool use; ui.toast is the local idle UI.
      // It neither submits a prompt nor adds report text to model context.
      $.ui.toast(REPORT_NOTICE, { timeoutMs: 10000 })
    }
  } catch {
    if (mine !== generation || !alive) return
    await update($, snapshot, previous => ({ ...previous, trees: [], reportsReady: null, error: 'Subagent list unavailable; check /mcp.' }))
    await setStatus($, restartNeeded ? 'ready: restart Claude' : 'subagent list unavailable: check /mcp', true)
  } finally {
    refreshing = false
  }
}

async function unavailable($: any, detail = '') {
  const message = /REBIND_REQUIRED|plugin changed/i.test(detail)
    ? 'run /fleet setup again'
    : /SETUP_REQUIRED|setup is required/i.test(detail) ? 'run /fleet setup'
      : 'unavailable: /fleet setup to check'
  const at = await $.clock.now()
  await update($, snapshot, previous => ({ ...previous, error: message, at, reportsReady: null }))
  await setStatus($, restartNeeded ? 'ready: restart Claude' : message, true)
}

async function streamTree($: any) {
  if (active || !alive || settingUp || accessDenied) return
  const mine = ++generation
  lastFrame = []
  let pending = ''
  let detail = ''
  try {
    if (mine !== generation || !alive || settingUp) return
    const stream = $.process.spawn({ argv: ['node', `${$.plugin.root}/tree-entry.js`, '--watch', '--json-lines', '--session'] })
    active = stream
    for await (const chunk of stream) {
      if (mine !== generation) break
      if (chunk.stream === 'stderr') { detail = (detail + chunk.text).slice(-2048); continue }
      if (chunk.stream !== 'stdout') continue
      pending += chunk.text
      if (pending.length > 1_000_000) throw new Error('Tree frame too large')
      let boundary
      while ((boundary = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, boundary)
        pending = pending.slice(boundary + 1)
        const trees = parseSessionLine(line)
        if (trees === null) hasFrame = true // malformed/global data is a real read failure
        await publish($, trees || [])
      }
    }
  } catch (error) { detail += error instanceof Error ? error.message : String(error) }
  finally {
    if (mine === generation) {
      active = null
      if (alive && !settingUp && /EACCES|EPERM|denied|not allowed|refused by (?:user|policy)/i.test(detail)) {
        accessDenied = true
        lastFrame = []
        stopClock?.cancel()
        stopClock = null
        await update($, snapshot, previous => ({ ...previous, trees: [], reportsReady: null, error: 'Status access denied.' }))
        await setStatus($, 'status access denied; restart Claude to retry', true)
      } else if (alive && !settingUp) {
        await unavailable($, detail)
        stopRetry = $.clock.after(retryDelay, () => { stopRetry = null; void streamTree($) })
        retryDelay = Math.min(60000, retryDelay * 2)
      }
    }
  }
}

async function closeTree() {
  generation += 1
  lastFrame = []
  stopRetry?.cancel()
  stopRetry = null
  const stream = active
  active = null
  if (stream) try { await stream.return?.(undefined) } catch { /* module unload also ends it */ }
}

function resultJson(result: any) {
  if (result.exitCode !== 0 || result.isStdoutTruncated || result.isStderrTruncated) {
    const detail = String(result.stderr || 'Runtime command failed.').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 800)
    throw new Error(detail)
  }
  return JSON.parse(result.stdout)
}

async function setupError($: any, error: unknown) {
  const detail = error instanceof Error ? error.message : 'Setup could not finish.'
  if (detail.includes('LINUX_PROCESS_NATIVE_UNAVAILABLE')) {
    await setStatus($, 'subagents unavailable on this system', true)
    return 'Fleet subagents need Linux 5.3+ with permitted pidfd support, which this system does not allow. Retrying setup on this system will not enable it.'
  }
  await setStatus($, 'run /fleet setup again', true)
  return `Fleet setup did not finish: ${detail.replace(/^Fleet setup failed:\s*/, '')}\nRun /fleet setup again after resolving this.`
}

async function setupFleet($: any) {
  if (settingUp) return { text: 'Fleet setup is already running.' }
  try {
    const workspace = await $.session.cwd()
    // Setup accepts only the session's own project; name it, so a stale
    // CLAUDE_PROJECT_DIR in Claude Code's environment cannot stand in for it.
    const env = { CLAUDE_PROJECT_DIR: workspace }
    const preview = resultJson(await $.process.run(['node', `${$.plugin.root}/setup-entry.js`, '--check', workspace], { cwd: workspace, env }))
    const found = Array.isArray(preview.providers) ? preview.providers.filter((name: unknown) => typeof name === 'string') : []
    const anyInstalled = Array.isArray(preview.installed) && preview.installed.length > 0
    const names = found.length ? found.join(', ') : anyInstalled ? 'none ready' : 'none found'
    const note = typeof preview.note === 'string' ? preview.note.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, ' ').slice(0, 2000) : ''
    const tools = await $.tool.list()
    const legacy = tools.some((tool: any) => tool.mcp && /^mcp__toolsenabled(?:[_-]fleet[_-]host)?__/.test(tool.name))
    const duplicate = legacy ? '\nAn older ToolsEnabled server is also connected. Check /mcp and remove the old user-scope registration with claude mcp remove --scope user toolsenabled (or its exact old name).' : ''
    pendingSetup = { workspace, names, subagents: found.length > 0, note, env, duplicate }
    setupResult = ''
    await $.ui.open({ id: SETUP_PANE, title: 'Fleet setup', focus: true })
    return { text: 'Review Fleet setup in the pane. Choose Set up Fleet or Cancel.' }
  } catch (error) {
    return { text: await setupError($, error) }
  }
}

async function confirmSetup($: any, preview: SetupPreview) {
  // A stale button from a replaced/cancelled pane cannot run setup.
  if (settingUp || pendingSetup !== preview) return
  settingUp = true
  pendingSetup = null
  setupResult = 'Setting up Fleet…'
  $.ui.invalidate('ui.render')
  try {
    if (await $.session.cwd() !== preview.workspace) throw new Error('The project changed. Confirm it again with /fleet setup.')
    await closeTree()
    const result = resultJson(await $.process.run(['node', `${$.plugin.root}/setup-entry.js`, '--setup', preview.workspace],
      { cwd: preview.workspace, env: preview.env, timeoutMs: 30000 }))
    if (result.setup !== 'ready' || result.workspace !== preview.workspace || result.tier !== 'standard' || typeof result.workers !== 'boolean') {
      throw new Error('Fleet setup returned an unexpected result; run /fleet setup again.')
    }
    retryDelay = 5000
    restartNeeded = false
    await setStatus($, 'ready')
    const using = Array.isArray(result.providers) ? result.providers.filter((name: unknown) => typeof name === 'string').join(', ') : ''
    setupResult = `Fleet ready in ${preview.workspace}. Subagents are ${result.workers ? `on and can use: ${using}` : 'off'}.${result.note ? `\n${result.note}` : ''}\nFleet's tools are available in this session now; open /fleet to see subagents.${preview.duplicate}`
  } catch (error) {
    setupResult = await setupError($, error)
  } finally {
    settingUp = false
    $.ui.log(setupResult)
    $.ui.invalidate('ui.render')
    if (alive) void streamTree($)
  }
}

const LEDGER_PANE = 'toolsenabled-fleet-ledger'
const LEDGER_LIMIT = 10
let serial = 0
let all = false
let loading = false
let error = ''
let page: ReturnType<typeof parsePage> | null = null
let detail: any = null
const redrawLedger = ($: any) => $.ui.invalidate('ui.render')
const resetLedger = () => { serial++; loading = false; page = null; detail = null; error = ''; all = false }
async function loadLedger($: any, offset = 0, revision?: number) {
  const mine = ++serial
  const query = { all, offset, limit: LEDGER_LIMIT, revision }
  loading = true; error = ''; detail = null; page = null; redrawLedger($)
  try {
    const argv = ['node', `${$.plugin.root}/ledger-entry.js`, '--offset', String(offset), '--limit', String(LEDGER_LIMIT),
      ...(all ? ['--all'] : []), ...(revision === undefined ? [] : ['--revision', String(revision)])]
    const result = await $.process.run(argv, { timeoutMs: 10000 })
    if (mine !== serial) return
    if (result.exitCode !== 0 || result.isStdoutTruncated || result.isStderrTruncated) {
      const stderr = String(result.stderr || '')
      if (/lacks the ledger reader/i.test(stderr)) error = 'Update the Fleet plugin to read the ledger.'
      else if (/REBIND_REQUIRED|plugin changed/i.test(stderr)) error = 'Run /fleet setup again for this plugin.'
      else if (/SETUP_REQUIRED|Run \/fleet setup|setup is required/i.test(stderr)) error = 'Run /fleet setup first'
      else if (/LEDGER_PAGE_CHANGED/.test(stderr)) error = 'The ledger changed. Reload to read the current items.'
      else if (/EACCES|EPERM|denied|not allowed/i.test(stderr)) error = 'Ledger access denied. Check access, then reopen /ledger.'
      else error = 'Ledger unavailable. Reload to try again.'
      return
    }
    if (typeof result.stdout !== 'string' || result.stdout.length > 1000000) throw new Error('Oversized ledger page')
    page = parsePage(JSON.parse(result.stdout), query)
  } catch { if (mine === serial) error = 'Ledger unavailable. Reload to try again.' }
  finally { if (mine === serial) { loading = false; redrawLedger($) } }
}

// These commands dispatch directly to plugin UI and local readers. They never
// invoke a skill, submit a prompt, call MCP, or start an assistant turn.
async function openLedger($: any, e: any) {
  if (!supported) return { text: PANES_NEED }
  if (e.args.trim()) return { text: 'The ledger pane is read-only. Type /ledger to view it.' }
  resetLedger()
  await $.ui.open({ id: LEDGER_PANE, title: 'Ledger', focus: true, closeOnEscape: true, rows: 20, columns: 90 })
  await loadLedger($)
  // Ledger bodies stay in the pane, never command output/model context.
  return { text: 'Ledger pane opened.' }
}

async function openFleet($: any, e: any) {
  if (!supported) return { text: PANES_NEED }
  if (e.args.trim() === 'setup') {
    if (!['composer', 'bridge'].includes(e.origin.kind)) return { text: 'Type /fleet setup yourself to confirm the workspace.' }
    return setupFleet($)
  }
  if (e.args.trim()) return { text: 'Use /fleet to see subagents, /ledger for the ledger, or /tefleet for setup, settings and ledger changes.' }
  await $.ui.open({ id: PANE, title: 'Fleet', focus: true, closeOnEscape: true })
  if (!active && !stopRetry) void streamTree($)
  return { text: 'Fleet subagents pane opened.' }
}

export const register: Register = (on) => {
  on('ui.close', { id: LEDGER_PANE }, async ($, e, next) => { resetLedger(); return next(e) })
  on('command.run', { command: 'ledger' }, openLedger)
  on('ui.render', { component: 'Pane', requestId: LEDGER_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const now = await $.clock.now()
    const current = page
    const selected = detail
    // A plugin's own close call does not pass through its ui.close hook.
    const close = async () => { resetLedger(); await $.ui.close({ id: LEDGER_PANE }) }
    // Each text child is limited to 10,000 UTF-16 units in Claude 2.1.287.
    // 4,000 Unicode code points fit even when every point is astral.
    if (selected) return <Box flexDirection="column">
      <Text bold>Fleet ledger · {selected.id} · {selected.kind}</Text>
      <Text>{selected.status} · Age {age(selected.filedAt, now)} · {selected.scope}{selected.scopeKey ? `: ${selected.scopeKey}` : ''}</Text>
      <Text dimColor>Filed: {selected.filedAt || 'unknown'}{selected.filedBy ? ` · ${selected.filedBy === 'owner' ? 'you' : selected.filedBy}` : ''}</Text>
      {selected.words.match(/[\s\S]{1,4000}/gu)?.map((part: string) => <Text>{part}</Text>)}
      {selected.answer ? <Box flexDirection="column"><Text bold>Answer</Text>
        {selected.answer.words.match(/[\s\S]{1,4000}/gu)?.map((part: string) => <Text>{part}</Text>)}
      </Box> : null}
      {selected.completedAt ? <Text>Completed: {selected.completedAt}</Text> : null}
      <Box><Button key="ledger-back" hotkey="b" onPress={() => { detail = null; redrawLedger($) }}>Back</Button>
        <Button key="ledger-close" hotkey="q" onPress={close}>Close</Button></Box>
      <Text dimColor>Read-only · Esc closes</Text>
    </Box>
    return <Box flexDirection="column">
      <Text bold>Fleet ledger · {all ? 'All items' : 'Open items'}</Text>
      <Text dimColor>ID · Kind · Title · State · Age</Text>
      {loading ? <Text dimColor>Loading…</Text> : error ? <Text>{error}</Text> : null}
      {current && !current.records.length ? <Text>Nothing open on the ledger.</Text> : null}
      {current?.records.map((row: any, index: number) => <Button key={`ledger-row-${row.id}`} hotkey={String((index + 1) % 10)}
        onPress={() => { if (page !== current) return; detail = row; redrawLedger($) }}>
        {`${row.id} · ${row.kind} · ${row.title} · ${row.status} · ${age(row.filedAt, now)}`}
      </Button>)}
      {current && current.total > 0 ? <Text dimColor>{current.offset + 1}–{current.offset + current.records.length} of {current.total}</Text> : null}
      {!loading ? <Box>
        <Button key="ledger-filter" hotkey="a" onPress={async () => { all = !all; await loadLedger($) }}>{all ? 'Show open' : 'Show all'}</Button>
        {current && current.offset > 0 ? <Button key="ledger-prev" hotkey="p" onPress={async () => {
          if (page === current) await loadLedger($, Math.max(0, current.offset - LEDGER_LIMIT), current.revision)
        }}>Previous</Button> : null}
        {current?.nextOffset !== null && current?.nextOffset !== undefined ? <Button key="ledger-next" hotkey="n" onPress={async () => {
          if (page === current) await loadLedger($, current.nextOffset, current.revision)
        }}>Next</Button> : null}
        <Button key="ledger-reload" hotkey="r" onPress={async () => { await loadLedger($) }}>Reload</Button>
        <Button key="ledger-close" hotkey="q" onPress={close}>Close</Button>
      </Box> : null}
      <Text dimColor>Read-only · Select a row for details · Esc closes</Text>
    </Box>
  })

  on('session.start', async ($, e, next) => {
    resetLedger()
    // /tefleet is the plugin's own command (every surface); these two open panes here.
    await $.command.register({ name: 'ledger', description: 'Open Fleet\'s ledger pane: rules, tasks and questions', immediate: true })
    await $.command.register({ name: 'fleet', description: 'Open the Fleet subagents pane; /fleet setup sets up this project', immediate: true })
    alive = false
    pendingSetup = null
    setupResult = ''
    restartNeeded = false
    accessDenied = false
    leadTurn = null
    turnRevision += 1
    reportSession = ''
    reportNotified = false
    stopClock?.cancel()
    await closeTree()
    await update($, snapshot, () => ({ ...EMPTY, notice: '' }))
    const { version } = await $.session.version()
    supported = panesSupported(version)
    // Older Claude Code: stay silent; Fleet's tools and /tefleet still work.
    if (!supported) return next(e)
    alive = true
    hasFrame = false
    startupUntil = await $.clock.now() + 10000
    retryDelay = 5000
    await setStatus($, 'starting')
    const result = await next(e)
    void streamTree($)
    stopClock = $.clock.every(5000, async () => {
      if (active) {
        await publish($, lastFrame, false)
      }
    })
    return result
  })

  on('session.end', async ($, e, next) => {
    resetLedger()
    if (e.reason === 'clear' || e.reason === 'resume') return next(e)
    alive = false
    pendingSetup = null
    stopClock?.cancel()
    stopClock = null
    await closeTree()
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) { leadTurn = e.turnId; turnRevision += 1 }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    // Nested agents and late completion events cannot make the lead idle.
    if (!e.agentId && e.turnId === leadTurn) {
      leadTurn = null
      turnRevision += 1
      // A fresh child heartbeat decides idle notification; cached counts cannot.
    }
    return result
  })

  on('command.run', { command: 'fleet' }, openFleet)

  on('ui.render', { component: 'Pane', requestId: SETUP_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const preview = pendingSetup
    if (!preview) return <Box flexDirection="column"><Text>{setupResult || 'Setup cancelled; nothing changed.'}</Text></Box>
    return <Box flexDirection="column">
      <Text bold>Set up Fleet</Text>
      <Text>Project: {preview.workspace}</Text>
      <Text>{`Agent CLIs: ${preview.names} · Standard permissions · Subagents ${preview.subagents ? 'on' : 'off'}`}</Text>
      {preview.note ? <Text dimColor>{preview.note}</Text> : null}
      <Text>Subagents run on this computer with your account permissions and network, limited to this project's files.</Text>
      <Box>
        <Button key="fleet-confirm" onPress={async () => { await confirmSetup($, preview) }}>Set up Fleet</Button>
        <Button key="fleet-cancel" onPress={async () => {
          if (pendingSetup !== preview) return
          pendingSetup = null
          setupResult = 'Setup cancelled; nothing changed.'
          await $.ui.close({ id: SETUP_PANE })
        }}>Cancel</Button>
      </Box>
    </Box>
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Text } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    return snap.warning
      ? <Text color="yellow">Fleet · {snap.notice}</Text>
      : <Text dimColor>Fleet · {snap.notice}</Text>
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    if (!snap.trees.length) {
      return (
        <Box flexDirection="column">
          <Text bold>Fleet subagents · Session: {snap.trees[0]?.treeKey || 'this Claude session'}</Text>
          <Text dimColor>Session = this lead and its subagents</Text>
          {(snap.reportsReady ?? 0) > 0 ? <Text bold>{REPORT_NOTICE} ({snap.reportsReady})</Text> : null}
          <Text dimColor>{snap.error || 'No subagents yet.'}</Text>
          <Text dimColor>Run /fleet setup, then ask Claude to start a subagent.</Text>
        </Box>
      )
    }
    const visible = rows(snap.trees, snap.at)
    const room = Math.max(1, (e.viewport?.rows ?? 24) - 4 - ((snap.reportsReady ?? 0) > 0 ? 1 : 0))
    return (
      <Box flexDirection="column">
        <Text bold>Fleet subagents · Session: {snap.trees[0]?.treeKey || 'this Claude session'}</Text>
        <Text dimColor>Session = this lead and its subagents</Text>
        {(snap.reportsReady ?? 0) > 0 ? <Text bold>{REPORT_NOTICE} ({snap.reportsReady})</Text> : null}
        {snap.error ? <Text color="yellow">{snap.error} (last known list)</Text> : null}
        {visible.slice(0, room).map(row => row.kind === 'collapsed' ? (
          <Text dimColor>{'  '.repeat(row.depth)}{`+ ${row.count} finished`}</Text>
        ) : (
          <Text wrap="truncate-end">
            {'  '.repeat(row.depth)}
            <Text color={COLOR[row.node.state] || 'white'}>{MARK[row.node.state] || '·'}</Text>
            {' '}
            <Text dimColor>{row.node.provider}</Text>
            {' '}
            <Text bold={row.node.role === 'lead'}>{row.node.displayName}</Text>
            <Text dimColor>{row.node.role === 'lead' ? `  Session: ${row.treeKey}`
              : `  ${row.node.model || row.node.provider} · ${row.node.state === 'waiting' ? 'approval' : row.node.state}`}</Text>
          </Text>
        ))}
      </Box>
    )
  })
}
