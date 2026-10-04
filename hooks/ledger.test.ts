import { test, expect, mock } from 'claude-code/testing'

const PANE = 'toolsenabled-fleet-ledger'
const presentation = { isFullscreen: false, columns: 120 }
const row = (n: number) => ({ id: `T${n}`, kind: 'T', title: `Synthetic task ${n}`, words: `Detail for task ${n}\nSecond line`,
  status: 'open', filedAt: '2026-10-01T00:00:00Z', filedBy: 'codex', scope: 'global', scopeKey: null, completedAt: null, answer: null })
function page(offset = 0, view = 'open') {
  return { schema: 'ai.toolsenabled/fleet-ledger/v1', revision: 7, updatedAt: null, view,
    records: Array.from({ length: Math.min(10, 61 - offset) }, (_, i) => row(offset + i + 1)),
    total: 61, offset, limit: 10, nextOffset: offset + 10 < 61 ? offset + 10 : null, grantsAuthority: false }
}
function world(on: any, respond: (e: any) => any) {
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/home/person', PATH: '/usr/bin', TOOLSENABLED_FLEET_STATE_ROOT: '/private/test state', SSL_CERT_FILE: '/private/ca.pem' })
  const opened: any[] = [], closed: any[] = [], calls: any[] = []
  on('process.run', (_: any, e: any) => { calls.push(e); return { value: respond(e) } })
  on('mcp.call', () => { throw new Error('Ledger must never call MCP') })
  on('tool.call', () => { throw new Error('Ledger must never call model tools') })
  on('ui.open', (_: any, e: any) => { opened.push(e); return { value: { isPlaced: true } } })
  on('ui.close', (_: any, e: any) => { closed.push(e); return { value: undefined } })
  return { opened, closed, calls, clock }
}
const ok = (value: any) => ({ exitCode: 0, stdout: JSON.stringify(value), stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
const failure = (text: string) => ({ exitCode: 1, stdout: '', stderr: text, isStdoutTruncated: false, isStderrTruncated: false })
async function open($: any) {
  await $.command.run({ command: 'ledger', args: '', origin: { kind: 'composer' }, presentation })
  return $.ui.mount({ plugin: 'toolsenabled-fleet', surface: 'terminal', component: 'Pane', requestId: PANE,
    props: { title: 'Ledger', bodyColumns: 100 }, viewport: { columns: 120, rows: 24 } })
}
async function press($: any, key: string) { await $.ui.press({ plugin: 'toolsenabled-fleet', key, requestId: PANE, surface: 'terminal' }) }

test('ledger opens focused with real-client Escape close contract and setup guidance', async ($, on) => {
  const w = world(on, () => failure('HOST_SETUP_REQUIRED: Run /fleet setup'))
  const ui = await open($)
  expect(JSON.stringify(await ui.drawn())).toContain('Run /fleet setup first')
  expect(w.opened[0].closeOnEscape).toBe(true)
  expect(w.opened[0].focus).toBe(true)
  expect(w.calls.length).toBe(1)
  expect(w.calls[0].argv[1]).toMatch(/\/toolsenabled-fleet\/ledger-entry\.js$/)
  expect(w.calls[0].init.env.TOOLSENABLED_FLEET_STATE_ROOT).toBe('/private/test state')
  expect(w.calls[0].init.env.SSL_CERT_FILE).toBe('/private/ca.pem')
  await press($, 'ledger-close')
  expect(w.closed.length).toBe(1)
})

test('empty ledger uses exact calm message and never polls', async ($, on) => {
  const w = world(on, e => ok({ ...page(0, e.argv.includes('--all') ? 'all' : 'open'), records: [], total: 0, nextOffset: null }))
  const ui = await open($)
  const drawing = JSON.stringify(await ui.drawn())
  expect(drawing).toContain('Nothing open on the ledger.')
  expect(drawing).toContain('Show all')
  await w.clock.advance(65000)
  expect(w.calls.length).toBe(1)
  await press($, 'ledger-filter')
  expect(JSON.stringify(await ui.drawn())).toContain('Nothing open on the ledger.')
})

test('ledger pages beyond fifty at one revision and opens read-only detail', async ($, on) => {
  const w = world(on, e => {
    const offset = Number(e.argv[e.argv.indexOf('--offset') + 1])
    return ok(page(offset, e.argv.includes('--all') ? 'all' : 'open'))
  })
  const ui = await open($)
  for (let n = 0; n < 6; n++) { await ui.drawn(); await press($, 'ledger-next') }
  const drawing = JSON.stringify(await ui.drawn())
  expect(drawing).toContain('T61')
  expect(drawing).toContain('Synthetic task 61')
  expect(drawing).toContain('open')
  expect(drawing).toContain('Age')
  for (const call of w.calls.slice(1)) expect(call.argv.slice(-2)).toEqual(['--revision', '7'])
  await press($, 'ledger-row-T61')
  const detail = JSON.stringify(await ui.drawn())
  expect(detail).toContain('Detail for task 61')
  expect(detail).toContain('Second line')
  expect(detail.includes('Complete task')).toBe(false)
  expect(detail.includes('File task')).toBe(false)
  expect(w.calls.length).toBe(7)
  await press($, 'ledger-back')
  await ui.drawn()
  await press($, 'ledger-filter')
  expect(w.calls[7].argv.includes('--all')).toBe(true)
  expect(w.calls[7].argv.includes('--revision')).toBe(false)
  expect(JSON.stringify(await ui.drawn())).toContain('Show open')
})

test('ledger changed revision clears old rows and waits for explicit reload', async ($, on) => {
  let changed = false
  const w = world(on, () => changed ? failure('LEDGER_PAGE_CHANGED: The ledger changed. Reload from offset 0.') : ok(page()))
  const ui = await open($)
  await ui.drawn()
  changed = true
  await press($, 'ledger-next')
  const drawing = JSON.stringify(await ui.drawn())
  expect(drawing).toContain('The ledger changed. Reload')
  expect(drawing.includes('Synthetic task 1')).toBe(false)
  await w.clock.advance(60000)
  expect(w.calls.length).toBe(2)
  changed = false
  await press($, 'ledger-reload')
  expect(w.calls[2].argv.includes('--revision')).toBe(false)
})

test('ledger access denial stops, malformed or wrong page is never displayed', async ($, on) => {
  let mode = 'denied'
  const w = world(on, () => mode === 'denied' ? failure('EACCES permission denied') : ok({ ...page(), offset: 50 }))
  const ui = await open($)
  expect(JSON.stringify(await ui.drawn())).toContain('Ledger access denied')
  await w.clock.advance(60000)
  expect(w.calls.length).toBe(1)
  mode = 'bad'
  await press($, 'ledger-reload')
  const text = JSON.stringify(await ui.drawn())
  expect(text).toContain('Ledger unavailable')
  expect(text.includes('Synthetic task')).toBe(false)
})

test('ledger does not accept a mutation as slash-command arguments', async ($, on) => {
  const w = world(on, () => { throw new Error('Unexpected runtime read') })
  const result = await $.command.run({ command: 'ledger', args: 'done T1', origin: { kind: 'composer' }, presentation })
  expect(result.text).toContain('read-only')
  expect(w.calls.length).toBe(0)
})

test('ledger renders all three kinds and plain answer detail without putting bodies in command output', async ($, on) => {
  world(on, () => ok({ ...page(), total: 3, nextOffset: null, records: [
    { ...row(1), id: 'R1.1', kind: 'R', title: 'Synthetic rule', words: 'Rule detail' },
    row(2),
    { ...row(3), id: 'A3', kind: 'A', title: 'Synthetic ask', words: '<literal>\x1b[31m', answer: { words: 'Synthetic answer', at: null } },
  ] }))
  const response = await $.command.run({ command: 'ledger', args: '', origin: { kind: 'composer' }, presentation })
  expect(response.text).toBe('Ledger pane opened.')
  const ui = await $.ui.mount({ plugin: 'toolsenabled-fleet', surface: 'terminal', component: 'Pane', requestId: PANE,
    props: { title: 'Ledger', bodyColumns: 100 }, viewport: { columns: 120, rows: 24 } })
  const text = JSON.stringify(await ui.drawn())
  expect(text).toContain('R1.1 · R')
  expect(text).toContain('T2 · T')
  expect(text).toContain('A3 · A')
  await press($, 'ledger-row-A3')
  const detail = JSON.stringify(await ui.drawn())
  expect(detail).toContain('<literal>�[31m')
  expect(detail).toContain('Synthetic answer')
})

function lines(node: any, out: string[] = []): string[] {
  if (node === null || node === undefined) return out
  if (typeof node === 'string') { out.push(node); return out }
  if (Array.isArray(node)) { for (const n of node) lines(n, out); return out }
  if (node.props?.label) out.push(node.props.label)
  const kids = Array.isArray(node.children) ? node.children : node.children === undefined ? [] : [node.children]
  if (kids.length && kids.every((k: any) => typeof k === 'string')) out.push(kids.join(''))
  else for (const k of kids) lines(k, out)
  return out
}

test('Previous keeps the revision pin and the count line names the whole view', async ($, on) => {
  const w = world(on, e => ok(page(Number(e.argv[e.argv.indexOf('--offset') + 1]))))
  const ui = await open($)
  await ui.drawn(); await press($, 'ledger-next'); await ui.drawn(); await press($, 'ledger-next')
  expect(lines(await ui.drawn())).toContain('21–30 of 61')
  await press($, 'ledger-prev')
  expect(lines(await ui.drawn())).toContain('11–20 of 61')
  const last = w.calls[w.calls.length - 1].argv
  expect(last[last.indexOf('--offset') + 1]).toBe('10')
  expect(last.slice(-2)).toEqual(['--revision', '7'])
})

test('a superseded in-flight read never replaces the newer page', async ($, on) => {
  let release: any
  const gate = new Promise(r => { release = r })
  const calls: any[] = []
  mock.clock(on)
  mock.env(on, { HOME: '/home/person', PATH: '/usr/bin' })
  on('process.run', async (_: any, e: any) => {
    calls.push(e)
    if (calls.length === 1) { await gate; return { value: ok({ ...page(), total: 1, nextOffset: null, records: [{ ...row(1), title: 'Stale read' }] }) } }
    return { value: ok({ ...page(), total: 1, nextOffset: null, records: [{ ...row(1), title: 'Fresh read' }] }) }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const first = $.command.run({ command: 'ledger', args: '', origin: { kind: 'composer' }, presentation })
  for (let i = 0; i < 100 && calls.length < 1; i++) await new Promise(r => setTimeout(r, 5))
  await $.command.run({ command: 'ledger', args: '', origin: { kind: 'composer' }, presentation })
  release()
  await first
  const ui = await $.ui.mount({ plugin: 'toolsenabled-fleet', surface: 'terminal', component: 'Pane', requestId: PANE,
    props: { title: 'Ledger', bodyColumns: 100 }, viewport: { columns: 120, rows: 24 } })
  const text = lines(await ui.drawn()).join('\n')
  expect(text.includes('Stale read')).toBe(false)
  expect(text).toContain('Fresh read')
})

test('timestamps with terminal controls still render a usable detail pane', async ($, on) => {
  world(on, () => ok({ ...page(), total: 1, nextOffset: null, records: [{ ...row(1), filedAt: '2026-10-01 (\x1b]0;x\x07)', completedAt: 'Oct 1 2026 (\u202e)' }] }))
  const ui = await open($)
  await ui.drawn()
  await press($, 'ledger-row-T1')
  const text = lines(await ui.drawn()).join('\n')
  expect(text).toContain('Detail for task 1')
  expect(/[\x1b\u202e]/.test(text)).toBe(false)
})

test('an old runtime tells the person to update, not reload', async ($, on) => {
  world(on, () => failure('LEDGER_UNAVAILABLE: This Fleet runtime lacks the ledger reader. Update the plugin.'))
  const ui = await open($)
  expect(lines(await ui.drawn())).toContain('Update the Fleet plugin to read the ledger.')
})

test('long display fields are truncated without hiding other ledger rows', async ($, on) => {
  world(on, () => ok({ ...page(), total: 2, nextOffset: null, records: [
    { ...row(1), title: 'x'.repeat(201), words: 'w'.repeat(16385), filedBy: 'f'.repeat(81), scopeKey: 's'.repeat(129),
      answer: { words: '😀'.repeat(8193), at: null } }, row(2),
  ] }))
  const ui = await open($)
  const text = lines(await ui.drawn()).join('\n')
  expect(text).toContain('Synthetic task 2')
  expect(text).toContain('…')
  await press($, 'ledger-row-T1')
  const detail = lines(await ui.drawn()).join('\n')
  expect(detail).toContain('w'.repeat(100))
  expect(detail).toContain('😀'.repeat(100))
  expect(detail).toContain('Answer')
  expect(detail.includes('Ledger unavailable')).toBe(false)
})

for (const field of ['words', 'answer']) test(`odd-offset Unicode in ${field} survives text chunk boundaries`, async ($, on) => {
  const value = 'a' + '😀'.repeat(6000)
  const record = { ...row(1), ...(field === 'words' ? { words: value } : { answer: { words: value, at: null } }) }
  world(on, () => ok({ ...page(), total: 1, nextOffset: null, records: [record] }))
  const ui = await open($)
  await ui.drawn()
  await press($, 'ledger-row-T1')
  const detail = lines(await ui.drawn()).join('\n')
  expect(detail).toContain('a😀')
  expect(detail.includes('\ufffd')).toBe(false)
  expect((detail.match(/😀/gu) || []).length).toBe(6000)
})

test('the Close button discards ledger rows', async ($, on) => {
  world(on, e => ok(page(Number(e.argv[e.argv.indexOf('--offset') + 1]))))
  const ui = await open($)
  await ui.drawn()
  await press($, 'ledger-close')
  await ui.unmount()
  const afterClose = await $.ui.mount({ plugin: 'toolsenabled-fleet', surface: 'terminal', component: 'Pane', requestId: PANE,
    props: { title: 'Ledger', bodyColumns: 101 }, viewport: { columns: 121, rows: 24 } })
  expect(lines(await afterClose.drawn()).join('\n').includes('Synthetic task')).toBe(false)
})

test('oversized valid JSON is refused before row rendering', async ($, on) => {
  world(on, () => ok({ ...page(), padding: ' '.repeat(1000000) }))
  const ui = await open($)
  expect(lines(await ui.drawn()).join('\n')).toContain('Ledger unavailable')
})
