import { test, expect, mock } from 'claude-code/testing'

const workspace = '/home/person/project with spaces'
const presentation = { isFullscreen: false, columns: 120 }
function ok(value: any) {
  return { value: { exitCode: 0, stdout: JSON.stringify(value), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
}
function leadTree() {
  return { treeKey: 'claude', live: true, reportsReady: 0, nodes: [
    { nodeId: 'root', displayName: 'Lead', parent: null, provider: 'claude', role: 'lead', state: 'idle', startedAt: '2026-10-02T05:00:00Z' },
  ] }
}
function sessionFrame(trees: any[] = [leadTree()]) {
  return JSON.stringify({ schema: 'ai.toolsenabled/fleet-tree/v1', trees,
    session: trees.length === 1 ? { treeKey: trees[0].treeKey, startedAt: trees[0].nodes[0].startedAt } : null }) + '\n'
}

function world(on: any, versionText = '2.1.287', configured = '', tools: any[] = []) {
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/home/person', PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/private/automation', TOOLSENABLED_FLEET_STATE_ROOT: configured })
  let mcpCalls = 0
  let currentWorkspace = workspace
  let hasBinding = true
  let reportsReady: unknown = undefined
  let state: any = undefined
  let version = 0
  const status: string[] = []
  const toasts: string[] = []
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('session.end', (_: any, e: any) => ({ sessionId: e.sessionId }))
  on('turn.start', (_: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', (_: any, e: any) => ({ text: e.answer }))
  on('ui.toast', (_: any, e: any) => { toasts.push(e.text); return { value: undefined } })
  on('session.version', () => ({ value: { version: versionText } }))
  on('session.cwd', () => ({ value: currentWorkspace }))
  on('command.register', (_: any, e: any) => ({ value: { command: e.name } }))
  on('state.get', () => ({ value: { value: state, version } }))
  on('state.set', (_: any, e: any) => { state = e.value; if (state.notice) status.push(state.notice); return { value: { isSet: true, version: ++version } } })
  on('ui.status', (_: any, e: any) => { expect(e.text).toBe(undefined); return { value: undefined } })
  on('tool.list', () => ({ value: tools }))
  on('mcp.call', () => { mcpCalls++; throw new Error('Background MCP calls are forbidden') })
  on('tool.call', () => { throw new Error('Setup must not open AskUserQuestion or call a model tool') })
  on('ui.close', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  let emit = () => {}
  const frame = () => sessionFrame(hasBinding ? [{ ...leadTree(), reportsReady }] : [])
  return { clock, status, toasts, mcpCalls: () => mcpCalls, frame,
    listen: (listener: () => void) => { emit = listener }, tick: () => emit(),
    setReports: (value: unknown) => { reportsReady = value; emit() },
    setBinding: (value: boolean) => { hasBinding = value; emit() },
    setWorkspace: (value: string) => { currentWorkspace = value } }

}


async function setupPane($: any) {
  return $.ui.mount({ plugin: 'toolsenabled-fleet', surface: 'terminal', component: 'Pane',
    requestId: 'toolsenabled-fleet-setup', props: { title: 'Fleet setup', bodyColumns: 100 }, viewport: { columns: 120, rows: 24 } })
}
async function confirmSetup($: any, inspect: (text: string) => void = () => {}) {
  const response = await $.command.run({ command: 'fleet', args: 'setup', origin: { kind: 'composer' }, presentation })
  expect(response.text).toContain('Review Fleet setup')
  const ui = await setupPane($)
  inspect(JSON.stringify(await ui.drawn()))
  await $.ui.press({ plugin: 'toolsenabled-fleet', key: 'fleet-confirm', requestId: 'toolsenabled-fleet-setup', surface: 'terminal' })
  return { text: JSON.stringify(await ui.drawn()) }
}

for (const configured of ['', '/private/state with spaces']) {
  test(`human setup confirms cwd and uses plugin entries (override=${Boolean(configured)})`, async ($, on) => {
    world(on, '2.1.287', configured)
    const calls: any[] = []
    on('process.run', (_: any, e: any) => {
      calls.push(e)
      if (e.argv[2] === '--check') return ok({ mode: 'host', workspace, providers: ['claude', 'codex'], tier: 'standard' })
      return ok({ setup: 'ready', workspace, tier: 'standard', workers: true, providers: ['claude', 'codex'] })
    })
    const result = await confirmSetup($, drawing => {
      expect(drawing).toContain(workspace)
      expect(drawing).toContain('claude, codex')
      expect(drawing.includes('Chat about this')).toBe(false)
      expect(calls.length).toBe(1)
    })
    expect(result.text).toContain('Fleet ready')
    expect(result.text).toContain('Subagents are on and can use: claude, codex.')
    expect(result.text).toContain('available in this session')
    expect(calls.length).toBe(2)
    expect(calls[1].argv[0]).toBe('node')
    expect(calls[1].argv[1]).toMatch(/\/toolsenabled-fleet\/setup-entry\.js$/)
    expect(calls[1].argv.slice(2)).toEqual(['--setup', workspace])
    expect(calls[1].init.env.TOOLSENABLED_FLEET_STATE_ROOT).toBe(configured)
    expect(calls[1].init.env.CLAUDE_CONFIG_DIR).toBe('/private/automation')
    // Setup accepts only the session's own project, named explicitly.
    expect(calls[0].init.env.CLAUDE_PROJECT_DIR).toBe(workspace)
    expect(calls[1].init.env.CLAUDE_PROJECT_DIR).toBe(workspace)
  })
}

test('setup with no agent CLI still completes with subagents off', async ($, on) => {
  world(on)
  on('process.run', (_: any, e: any) => e.argv[2] === '--check'
    ? ok({ mode: 'host', workspace, providers: [], tier: 'standard', subagents: false })
    : ok({ setup: 'ready', workspace, tier: 'standard', workers: false, providers: [],
      note: 'Subagents are off because no supported agent CLI was found on PATH.' }))
  const result = await confirmSetup($, drawing => {
    expect(drawing).toContain('none found')
    expect(drawing).toContain('Subagents off')
  })
  expect(result.text).toContain('Fleet ready')
  expect(result.text).toContain('Subagents are off')
  expect(result.text).toContain('no supported agent CLI')
})

test('setup names a signed-out agent CLI and uses only the signed-in ones', async ($, on) => {
  world(on)
  const hint = 'claude is installed but not signed in. To use it for subagents, run `claude auth login` once in a terminal, then run /tefleet setup again.'
  on('process.run', (_: any, e: any) => e.argv[2] === '--check'
    ? ok({ mode: 'host', workspace, providers: ['codex'], installed: ['claude', 'codex'], signedOut: ['claude'], tier: 'standard', subagents: true, note: hint })
    : ok({ setup: 'ready', workspace, tier: 'standard', workers: true, providers: ['codex'], note: hint }))
  const result = await confirmSetup($, drawing => {
    expect(drawing).toContain('Agent CLIs: codex')
    expect(drawing).toContain('claude auth login')
  })
  expect(result.text).toContain('Subagents are on and can use: codex.')
  expect(result.text).toContain('claude auth login')
})

test('setup with agent CLIs installed but none signed in says so', async ($, on) => {
  world(on)
  on('process.run', (_: any, e: any) => e.argv[2] === '--check'
    ? ok({ mode: 'host', workspace, providers: [], installed: ['codex'], signedOut: ['codex'], tier: 'standard', subagents: false,
      note: 'codex is installed but not signed in.' })
    : ok({ setup: 'ready', workspace, tier: 'standard', workers: false, providers: [], note: 'codex is installed but not signed in.' }))
  const result = await confirmSetup($, drawing => {
    expect(drawing).toContain('none ready')
    expect(drawing).toContain('Subagents off')
  })
  expect(result.text).toContain('Subagents are off.')
})

test('cancel and non-human origin never run setup', async ($, on) => {
  world(on)
  let calls = 0
  on('process.run', () => { calls++; return ok({ mode: 'host', workspace, providers: ['claude'] }) })
  const refused = await $.command.run({ command: 'fleet', args: 'setup', origin: { kind: 'sdk' }, presentation })
  expect(refused.text).toContain('yourself')
  expect(calls).toBe(0)
  await $.command.run({ command: 'fleet', args: 'setup', origin: { kind: 'composer' }, presentation })
  await setupPane($)
  await $.ui.press({ plugin: 'toolsenabled-fleet', key: 'fleet-cancel', requestId: 'toolsenabled-fleet-setup', surface: 'terminal' })
  expect(calls).toBe(1)
})

test('unavailable tree uses plugin root, backs off, and stops at session end', async ($, on) => {
  const { clock, status } = world(on)
  const times: number[] = []
  on('process.spawn', async function* (_: any, e: any) {
    expect(e.argv[0]).toBe('node')
    expect(e.argv[1]).toMatch(/\/toolsenabled-fleet\/tree-entry\.js$/)
    expect(e.argv.slice(2)).toEqual(['--watch', '--json-lines', '--session'])
    times.push(clock.now())
    yield { stream: 'stderr', text: 'HOST_PLUGIN_REBIND_REQUIRED: Fleet plugin changed.' }
    return { value: { code: 1, signal: null } }
  })
  await $.session.start({ cwd: workspace, surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(times).toEqual([0])
  expect(status).toContain('run /fleet setup again')
  await clock.advance(4999)
  expect(times).toEqual([0])
  await clock.advance(1)
  expect(times).toEqual([0, 5000])
  await clock.advance(9999)
  expect(times).toEqual([0, 5000])
  await clock.advance(1)
  expect(times).toEqual([0, 5000, 15000])
  await clock.advance(20000 + 40000 + 60000)
  expect(times).toEqual([0, 5000, 15000, 35000, 75000, 135000])
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'fixture', resume: {} })
  await clock.advance(120000)
  expect(times.length).toBe(6)
})


// The panes need 2.1.287, as every document says; 2.1.284 to 2.1.286 stay silent too.
for (const older of ['2.1.283', '2.1.284', '2.1.286']) {
  test(`older client ${older} keeps the panes silent, launches nothing and points to the setup command`, async ($, on) => {
    const { clock, status } = world(on, older)
    let launches = 0
    on('process.spawn', async function* () { launches++; return { value: { code: 0, signal: null } } })
    await $.session.start({ cwd: workspace, surface: 'terminal', isInteractive: true })
    await clock.settle()
    expect(status).toEqual([])
    expect(launches).toBe(0)
    const reply = await $.command.run({ command: 'fleet', args: 'setup', origin: { kind: 'composer' }, presentation })
    expect(reply.text).toContain('2.1.287')
    expect(reply.text).toContain('/tefleet')
  })
}

test('healthy empty tree is ready and resets retry delay', async ($, on) => {
  const { clock, status } = world(on)
  const times: number[] = []
  on('process.spawn', async function* () {
    times.push(clock.now())
    if (times.length === 3) yield { stream: 'stdout', text: sessionFrame() }
    return { value: { code: 1, signal: null } }
  })
  await $.session.start({ cwd: workspace, surface: 'terminal', isInteractive: true })
  await clock.settle()
  await clock.advance(15000)
  expect(times).toEqual([0, 5000, 15000])
  expect(status).toContain('0 subagents')
  await clock.advance(5000)
  expect(times).toEqual([0, 5000, 15000, 20000])
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'fixture', resume: {} })
})

test('terminal pane names each subagent provider and the waiting state', async ($, on) => {
  const { clock, status } = world(on)
  on('process.spawn', async function* () {
    yield { stream: 'stdout', text: sessionFrame([{ treeKey: 'claude', live: true, nodes: [
      { nodeId: 'root', displayName: 'Lead', parent: null, provider: 'claude', role: 'lead', state: 'idle', startedAt: '2026-10-02T05:00:00Z' },
      { nodeId: 'worker-c', displayName: 'Claude worker', parent: 'root', provider: 'claude', role: 'worker', state: 'running' },
      { nodeId: 'worker-x', displayName: 'Codex worker', parent: 'root', provider: 'codex', role: 'worker', state: 'waiting' },
    ] }]) }
    return { value: { code: 0, signal: null } }
  })
  await $.session.start({ cwd: workspace, surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(status).toContain('claude 1 · codex 1 — 1 running · 1 waiting')
  const reply = await $.command.run({ command: 'fleet', args: '', origin: { kind: 'composer' }, presentation })
  expect(reply.text).toContain('pane opened')
  const ui = await $.ui.mount({ plugin: 'toolsenabled-fleet', surface: 'terminal', component: 'Pane',
    requestId: 'toolsenabled-fleet-tree', props: { title: 'Fleet', bodyColumns: 80 }, viewport: { columns: 120, rows: 24 } })
  const drawing = JSON.stringify(await ui.drawn())
  expect(drawing).toContain('Fleet subagents')
  expect(drawing.includes('C = Claude')).toBe(false)
  expect(drawing).toContain('"codex"')
  expect(drawing).toContain('Session:')
  expect(drawing).toContain('Claude worker')
  expect(drawing).toContain('Codex worker')
  expect(drawing).toContain('approval')
  expect(drawing).toContain('last known list')
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'fixture', resume: {} })
})

// This assertion uses the real Engine facade with its supplied clock
// scheduler. Do not replace the Timer result with a cancellation function.
test('timer handles cancel pending callbacks', async ($, on) => {
  const { clock } = world(on)
  let calls = 0
  on('command.run', { command: 'timer-contract' }, ($: any) => {
    const after = $.clock.after(10, () => { calls++ })
    const every = $.clock.every(10, () => { calls++ })
    expect(typeof after).toBe('object')
    expect(typeof after.cancel).toBe('function')
    expect(typeof every.cancel).toBe('function')
    after.cancel()
    every.cancel()
    return { text: 'Timer contract passed' }
  })
  const result = await $.command.run({ command: 'timer-contract', args: '', origin: { kind: 'composer' }, presentation })
  expect(result.text).toBe('Timer contract passed')
  await clock.advance(20)
  expect(calls).toBe(0)
})

test('setup with a pending retry and session exit obey Timer.cancel', async ($, on) => {
  const { clock } = world(on)
  on('process.spawn', async function* () {
    yield { stream: 'stderr', text: 'Fleet setup is required.' }
    return { value: { code: 1, signal: null } }
  })
  on('process.run', (_: any, e: any) => e.argv[2] === '--check'
    ? ok({ mode: 'host', workspace, providers: ['claude'] })
    : ok({ setup: 'ready', workspace, tier: 'standard', workers: true }))
  await $.session.start({ cwd: workspace, surface: 'terminal', isInteractive: true })
  await clock.settle()
  const result = await confirmSetup($)
  expect(result.text).toContain('Fleet ready')
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'fixture', resume: {} })
  await clock.advance(120000)
})

for (const mode of ['host']) {
  test(`setup explains old registrations; Fleet is ready in the same session (${mode})`, async ($, on) => {
    const { clock, status } = world(on, '2.1.287', '', [{ name: 'mcp__toolsenabled__system_status', mcp: true }])
    let starts = 0
    let live = false
    let release = () => {}
    on('process.spawn', async function* () {
      starts++
      yield { stream: 'stdout', text: sessionFrame() }
      // After setup the session's stream stays open, as a live Fleet tree does.
      if (live) await new Promise(resolve => { release = resolve })
      return { value: { code: 0, signal: null } }
    })
    on('process.run', (_: any, e: any) => e.argv[2] === '--check'
      ? ok({ mode, workspace, providers: ['claude'] })
      : ok({ setup: 'ready', workspace, tier: 'standard', workers: true }))
    await $.session.start({ cwd: workspace, surface: 'terminal', isInteractive: true })
    await clock.settle()
    const healthy = await $.ui.mount({ plugin: 'toolsenabled-fleet', surface: 'terminal', component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 100, scroll: { offset: 0, bodyRows: 4 }, view: {} }, viewport: { columns: 100, rows: 24 } })
    const drawing = JSON.stringify(await healthy.drawn())
    // The stream ended, so this now warns; the neutral render gets its own test below.
    expect(drawing).toContain('Fleet')
    const reply = await confirmSetup($, drawing => {
      expect(drawing.includes('Git repository')).toBe(false)
      expect(drawing.includes('OpenShell')).toBe(false)
      expect(drawing.includes('older ToolsEnabled server')).toBe(false)
    })
    expect(reply.text).toContain('older ToolsEnabled server')
    expect(reply.text).toContain('Fleet ready')
    expect(reply.text).toContain('available in this session')
    live = true
    await clock.settle()
    await clock.advance(15000)
    expect(status[status.length - 1]).toBe('0 subagents')
    expect(status.includes('ready: restart Claude')).toBe(false)
    release()
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 'fixture', resume: {} })
    const stopped = starts
    await clock.advance(120000)
    expect(starts).toBe(stopped)
  })
}

test('native host prerequisite refusal gives a useful action without retry advice', async ($, on) => {
  world(on)
  on('process.run', (_: any, e: any) => e.argv[2] === '--check'
    ? ok({ mode: 'host', workspace, providers: ['claude'] })
    : { value: { exitCode: 1, stdout: '', stderr: 'Fleet setup failed: LINUX_PROCESS_NATIVE_UNAVAILABLE: unsupported', isStdoutTruncated: false, isStderrTruncated: false } })
  const result = await confirmSetup($)
  expect(result.text).toContain('Linux 5.3+')
  expect(result.text.includes('LINUX_PROCESS_NATIVE_UNAVAILABLE')).toBe(false)
  expect(result.text.includes('Run /fleet setup again')).toBe(false)
})

test('healthy prompt status is neutral and has one Fleet label', async ($, on) => {
  const { clock } = world(on)
  let finish: () => void = () => {}
  const hold = new Promise<void>(resolve => { finish = resolve })
  on('process.spawn', async function* () {
    yield { stream: 'stdout', text: sessionFrame() }
    await hold
    return { value: { code: 0, signal: null } }
  })
  await $.session.start({ cwd: workspace, surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'toolsenabled-fleet', surface: 'terminal', component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 100, scroll: { offset: 0, bodyRows: 4 }, view: {} }, viewport: { columns: 100, rows: 24 } })
  const drawing = JSON.stringify(await ui.drawn())
  expect(drawing).toContain('0 subagents')
  expect(drawing).toContain('dimColor')
  expect(drawing.includes('yellow')).toBe(false)
  expect(drawing.includes('Fleet:')).toBe(false)
  finish()
  await clock.settle()
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'fixture', resume: {} })
})

test('UI refuses an unscoped global frame instead of showing another session', async ($, on) => {
  const { clock, status } = world(on)
  on('process.spawn', async function* () {
    yield { stream: 'stdout', text: JSON.stringify({ schema: 'ai.toolsenabled/fleet-tree/v1', trees: [leadTree(), { ...leadTree(), treeKey: 'other' }] }) + '\n' }
    return { value: { code: 0, signal: null } }
  })
  await $.session.start({ cwd: workspace, surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(status).toContain('subagent list unavailable: check /mcp')
  expect(status.includes('0 subagents')).toBe(false)
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'fixture', resume: {} })
})

test('setup refuses a project change after the local confirmation was drawn', async ($, on) => {
  const { setWorkspace } = world(on)
  let setups = 0
  on('process.run', (_: any, e: any) => {
    if (e.argv[2] === '--setup') setups++
    return ok({ mode: 'host', workspace, providers: ['codex'] })
  })
  const reply = await confirmSetup($, () => { setWorkspace('/different/project') })
  expect(reply.text).toContain('project changed')
  expect(setups).toBe(0)
})

test('cancelled setup buttons cannot be reused to run the backend', async ($, on) => {
  world(on)
  let calls = 0
  on('process.run', () => { calls++; return ok({ mode: 'host', workspace, providers: ['codex'] }) })
  await $.command.run({ command: 'fleet', args: 'setup', origin: { kind: 'composer' }, presentation })
  await setupPane($)
  await $.ui.press({ plugin: 'toolsenabled-fleet', key: 'fleet-cancel', requestId: 'toolsenabled-fleet-setup', surface: 'terminal' })
  // The mounted test view still holds the old button; its handler must refuse.
  await $.ui.press({ plugin: 'toolsenabled-fleet', key: 'fleet-confirm', requestId: 'toolsenabled-fleet-setup', surface: 'terminal' })
  expect(calls).toBe(1)
})

test('missing session identity is unavailable, not a healthy zero count', async ($, on) => {
  const w = world(on)
  w.setBinding(false)
  const end = reportsStream(on, w, $)
  try {
    await $.session.start({ cwd: workspace, surface: 'terminal', isInteractive: true })
    await w.clock.settle()
    await w.clock.advance(10000)
    expect(w.status[w.status.length - 1]).toBe('subagent list unavailable: check /mcp')
    w.setBinding(true)
    await w.clock.advance(5000)
    expect(w.status[w.status.length - 1]).toBe('0 subagents')
  } finally { await end($, w.clock) }
})

// Only lifecycle events are simulated. $.turn and $.ui.toast still use the
// actual 2.1.284 facade; none of these tests runs a model or a worker.
function reportsStream(on: any, world: any, $: any) {
  let stopped = false
  let wake = () => {}
  let pending: string[] = []
  world.listen(() => { pending.push(world.frame()); wake() })
  on('process.spawn', async function* () {
    yield { stream: 'stdout', text: world.frame() }
    while (!stopped) {
      if (!pending.length) await new Promise<void>(resolve => { wake = resolve })
      while (pending.length && !stopped) yield { stream: 'stdout', text: pending.shift() }
    }
    return { value: { code: 0, signal: null } }
  })
  return async ($: any, clock: any) => {
    stopped = true; wake()
    await clock.settle()
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 'fixture', resume: {} })
  }
}
async function finishTurn($: any, turnId: string, agentId?: string) {
  return $.turn.complete({ turnId, answer: 'Synthetic event only', durationMs: 10, isAborted: false, reason: 'answer', ...(agentId ? { agentId } : {}) })
}

test('idle report arrival shows a scoped status, pane and one local notice until drained', async ($, on) => {
  const w = world(on)
  const { clock, status, toasts, setReports } = w
  const end = reportsStream(on, w, $)
  try {
    setReports(0)
    await $.session.start({ cwd: workspace, surface: 'terminal', isInteractive: true })
    await clock.settle()
    expect(status[status.length - 1]).toBe('0 subagents')
    expect(toasts).toEqual([])
    setReports(1)
    await clock.advance(5000)
    expect(status[status.length - 1]).toContain('1 report ready')
    expect(status[status.length - 1]).toContain('say continue')
    expect(toasts).toEqual(['Subagent reports ready, say continue.'])
    const ui = await $.ui.mount({ plugin: 'toolsenabled-fleet', surface: 'terminal', component: 'Pane',
      requestId: 'toolsenabled-fleet-tree', props: { title: 'Fleet', bodyColumns: 100 }, viewport: { columns: 120, rows: 24 } })
    expect(JSON.stringify(await ui.drawn())).toContain('Subagent reports ready, say continue.')
    setReports(2)
    await clock.advance(10000)
    expect(status[status.length - 1]).toContain('2 reports ready')
    expect(toasts.length).toBe(1)
    setReports(0)
    await clock.advance(5000)
    expect(status[status.length - 1]).toBe('0 subagents')
    expect(JSON.stringify(await ui.drawn()).includes('Worker reports ready')).toBe(false)
    setReports(1)
    await clock.advance(5000)
    expect(toasts.length).toBe(2)
  } finally { await end($, clock) }
})

test('reports arriving during a lead turn notify only after that lead becomes idle', async ($, on) => {
  const w = world(on)
  const { clock, status, toasts, setReports } = w
  const end = reportsStream(on, w, $)
  try {
    setReports(0)
    await $.session.start({ cwd: workspace, surface: 'terminal', isInteractive: true })
    await clock.settle()
    await $.turn.start({ turnId: 'lead-1', text: 'Synthetic lifecycle event' })
    setReports(1)
    await clock.advance(5000)
    expect(status[status.length - 1]).toContain('1 report ready')
    expect(toasts).toEqual([])
    await finishTurn($, 'nested-1', 'subagent-1')
    await finishTurn($, 'stale-turn')
    await clock.settle()
    expect(toasts).toEqual([])
    await finishTurn($, 'lead-1')
    w.tick() // A fresh child heartbeat after completion, not the cached count.
    await clock.settle()
    expect(toasts).toEqual(['Subagent reports ready, say continue.'])
    await clock.advance(10000)
    expect(toasts.length).toBe(1)
  } finally { await end($, clock) }
})

test('a report delivered before lead completion causes no stale idle notice', async ($, on) => {
  const w = world(on)
  const { clock, toasts, setReports } = w
  const end = reportsStream(on, w, $)
  try {
    setReports(0)
    await $.session.start({ cwd: workspace, surface: 'terminal', isInteractive: true })
    await clock.settle()
    await $.turn.start({ turnId: 'lead-1', text: 'Synthetic lifecycle event' })
    setReports(1)
    await clock.advance(5000)
    setReports(0)
    await finishTurn($, 'lead-1')
    await clock.settle()
    expect(toasts).toEqual([])
    await clock.advance(5000)
    expect(toasts).toEqual([])
  } finally { await end($, clock) }
  setReports(1)
  await clock.advance(15000)
  expect(toasts).toEqual([])
})

test('missing report metadata or binding never consumes reports or notifies another session', async ($, on) => {
  const w = world(on)
  const { clock, status, toasts, setReports, setBinding } = w
  const end = reportsStream(on, w, $)
  try {
    await $.session.start({ cwd: workspace, surface: 'terminal', isInteractive: true })
    await clock.settle()
    for (const value of [undefined, null, -1, '2', 0.5, 257, Number.MAX_SAFE_INTEGER + 1]) {
      setReports(value)
      await clock.advance(5000)
      expect(toasts).toEqual([])
      expect(status[status.length - 1].includes('report ready')).toBe(false)
    }
    setBinding(false)
    setReports(1)
    await clock.advance(5000)
    expect(toasts).toEqual([])
    setBinding(true)
    await clock.advance(5000)
    expect(toasts.length).toBe(1)
    setBinding(false)
    await clock.advance(5000)
    setBinding(true)
    await clock.advance(5000)
    expect(toasts.length).toBe(1)
  } finally { await end($, clock) }
})


test('lead completion cannot notify from a cached count before a fresh child frame', async ($, on) => {
  const w = world(on)
  const { clock, toasts, setReports } = w
  const end = reportsStream(on, w, $)
  try {
    setReports(0)
    await $.session.start({ cwd: workspace, surface: 'terminal', isInteractive: true })
    await clock.settle()
    await $.turn.start({ turnId: 'lead-1', text: 'Synthetic lifecycle event' })
    setReports(1)
    await clock.settle()
    await finishTurn($, 'lead-1')
    await clock.settle()
    expect(toasts).toEqual([])
    setReports(0)
    await clock.advance(5000)
    expect(toasts).toEqual([])
  } finally { await end($, clock) }
})

// A tool approval is a user interaction, not a background status transport.
test('status never invokes MCP across sixty seconds at default permissions', async ($, on) => {
  const { clock, mcpCalls } = world(on)
  let finish: () => void = () => {}
  const hold = new Promise<void>(resolve => { finish = resolve })
  on('process.spawn', async function* () {
    const root = { nodeId: 'root', displayName: 'Lead', parent: null, provider: 'claude', role: 'lead', state: 'idle', startedAt: '2026-10-02T05:00:00Z' }
    yield { stream: 'stdout', text: JSON.stringify({ schema: 'ai.toolsenabled/fleet-tree/v1', session: { treeKey: 'claude', startedAt: root.startedAt }, trees: [{ treeKey: 'claude', live: true, reportsReady: 0, nodes: [root] }] }) + '\n' }
    await hold
    return { value: { code: 0, signal: null } }
  })
  try {
    await $.session.start({ cwd: workspace, surface: 'terminal', isInteractive: true })
    await clock.settle()
    await clock.advance(60000)
    expect(mcpCalls()).toBe(0)
  } finally {
    finish(); await clock.settle()
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 'fixture', resume: {} })
  }
})

test('denied status child stops retries and leaves one plain message', async ($, on) => {
  const { clock, status } = world(on)
  let calls = 0
  on('process.spawn', async function* () {
    calls++
    yield { stream: 'stderr', text: 'EACCES: permission denied' }
    return { value: { code: 1, signal: null } }
  })
  await $.session.start({ cwd: workspace, surface: 'terminal', isInteractive: true })
  await clock.settle()
  await clock.advance(120000)
  expect(calls).toBe(1)
  expect(status.filter(text => text === 'status access denied; restart Claude to retry').length).toBe(1)
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'fixture', resume: {} })
})

test('Fleet pane opts into Escape close on the real client', async ($, on) => {
  const opened: any[] = []
  on('ui.open', (_: any, e: any) => { opened.push(e); return { value: { isPlaced: true } } })
  on('process.spawn', async function* () { return { value: { code: 0, signal: null } } })
  await $.command.run({ command: 'fleet', args: '', origin: { kind: 'composer' }, presentation })
  expect(opened[0].closeOnEscape).toBe(true)
  expect(opened[0].focus).toBe(true)
})

test('startup binding delay is neutral until a real read succeeds or times out', async ($, on) => {
  const w = world(on)
  w.setBinding(false)
  const end = reportsStream(on, w, $)
  await $.session.start({ cwd: workspace, surface: 'terminal', isInteractive: true })
  await w.clock.settle()
  expect(w.status).toContain('starting')
  expect(w.status[0]).toBe('starting')
  expect(w.status.includes('subagent list unavailable: check /mcp')).toBe(false)
  await w.clock.advance(5000)
  expect(w.status.includes('subagent list unavailable: check /mcp')).toBe(false)
  w.setBinding(true)
  await w.clock.settle()
  expect(w.status[w.status.length - 1]).toContain('0 subagents')
  await end($, w.clock)
})
