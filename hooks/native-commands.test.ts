import { test, expect, mock } from 'claude-code/testing'

const presentation = { isFullscreen: false, columns: 120 }
const plugin = 'toolsenabled-fleet'
const workspace = '/home/person/native-fleet-fixture'
const treeId = 'toolsenabled-fleet-tree'
const ledgerId = 'toolsenabled-fleet-ledger'
const page = {
  schema: 'ai.toolsenabled/fleet-ledger/v1', revision: 1, updatedAt: null, view: 'open',
  records: [{ id: 'T1', kind: 'T', title: 'Native fixture task', words: 'Local ledger detail', status: 'open',
    filedAt: '2026-10-02T00:00:00Z', filedBy: 'codex', scope: 'global', scopeKey: null, completedAt: null, answer: null }],
  total: 1, offset: 0, limit: 10, nextOffset: null, grantsAuthority: false,
}

function world(on: any) {
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/home/person', PATH: '/usr/bin' })
  const registered: any[] = [], opened: any[] = [], calls: any[] = []
  let state: any
  let revision = 0
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('session.end', (_: any, e: any) => ({ sessionId: e.sessionId }))
  on('session.version', () => ({ value: { version: '2.1.287' } }))
  on('session.cwd', () => ({ value: workspace }))
  on('command.register', (_: any, e: any) => { registered.push(e); return { value: { command: e.name } } })
  on('state.get', () => ({ value: { value: state, version: revision } }))
  on('state.set', (_: any, e: any) => { state = e.value; return { value: { isSet: true, version: ++revision } } })
  on('ui.open', (_: any, e: any) => { opened.push(e); return { value: { isPlaced: true } } })
  on('ui.status', () => ({ value: undefined }))
  on('process.run', (_: any, e: any) => {
    calls.push(e)
    return { value: { exitCode: 0, stdout: JSON.stringify(page), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  // Guard the action path, not just the rendered text. Local readers are the
  // only work allowed by these commands; a Claude/model/tool call fails.
  on('mcp.call', () => { throw new Error('Native Fleet must not call MCP') })
  on('tool.call', () => { throw new Error('Native Fleet must not call tools') })
  on('prompt.submit', () => { throw new Error('Native Fleet must not submit prompts') })
  on('turn.start', () => { throw new Error('Native Fleet must not start Claude') })
  on('turn.step', async function* () { throw new Error('Native Fleet must not request a model'); yield undefined })
  on('process.spawn', async function* () { return { value: { code: 0, signal: null } } })
  return { clock, registered, opened, calls }
}

const run = ($: any, command: string, args = '', kind = 'composer') => $.command.run({ command, args, origin: { kind }, presentation })
const mount = ($: any, requestId: string) => $.ui.mount({ plugin, surface: 'desktop', component: 'Pane', requestId,
  props: { title: 'Fleet', bodyColumns: 100 }, viewport: { columns: 120, rows: 24 } })

test('the panes add-on registers /fleet and /ledger as immediate commands and leaves /tefleet to the plugin', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: workspace, surface: 'desktop', isInteractive: true })
  await w.clock.settle()
  for (const name of ['fleet', 'ledger']) expect(w.registered.some(entry => entry.name === name && entry.immediate === true)).toBe(true)
  expect(w.registered.some(entry => entry.name === 'tefleet')).toBe(false)
  const result = await run($, 'fleet')
  expect(result.text).toBe('Fleet subagents pane opened.')
  expect(w.opened[w.opened.length - 1].id).toBe(treeId)
  expect(w.opened[w.opened.length - 1].closeOnEscape).toBe(true)
  const ui = await mount($, treeId)
  expect(JSON.stringify(await ui.drawn())).toContain('Fleet subagents')
  await ui.unmount()
  expect(w.calls.length).toBe(0)
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'fixture', resume: {} })
})

test('/ledger draws the ledger directly and keeps detail out of command output', async ($, on) => {
  const w = world(on)
  const result = await run($, 'ledger')
  expect(result.text).toBe('Ledger pane opened.')
  expect(result.text.includes('Local ledger detail')).toBe(false)
  expect(w.calls.length).toBe(1)
  expect(w.calls[0].argv[1]).toMatch(/\/toolsenabled-fleet\/ledger-entry\.js$/)
  expect(w.opened[0].id).toBe(ledgerId)
  const ui = await mount($, ledgerId)
  expect(JSON.stringify(await ui.drawn())).toContain('Native fixture task')
  await $.ui.press({ plugin, surface: 'desktop', requestId: ledgerId, key: 'ledger-row-T1' })
  expect(JSON.stringify(await ui.drawn())).toContain('Local ledger detail')
  await w.clock.advance(60000)
  expect(w.calls.length).toBe(1)
})

test('/fleet with other words gives local help that names /tefleet, with no work', async ($, on) => {
  const w = world(on)
  for (const args of ['spawn a worker', 'ledger done T1', 'status --all']) {
    const result = await run($, 'fleet', args)
    expect(result.text).toContain('/tefleet')
  }
  expect(w.calls.length).toBe(0)
  expect(w.opened.length).toBe(0)
})

test('/fleet setup keeps the human confirmation boundary', async ($, on) => {
  const w = world(on)
  const result = await run($, 'fleet', 'setup', 'sdk')
  expect(result.text).toContain('yourself')
  expect(w.calls.length).toBe(0)
  expect(w.opened.length).toBe(0)
})
