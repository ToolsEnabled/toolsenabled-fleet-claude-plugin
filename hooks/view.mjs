export const SCHEMA = 'ai.toolsenabled/fleet-tree/v1'
export const DONE_COLLAPSE_MS = 30_000
export const REPORT_NOTICE = 'Subagent reports ready, say continue.'
// The first Claude Code version whose mod API the panes are written for.
export const PANES_MINIMUM = [2, 1, 287]

// Whether this Claude Code version runs Fleet's panes.
export function panesSupported(version) {
  const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(typeof version === 'string' ? version : '')
  if (!parts) return false
  for (let at = 0; at < 3; at++) {
    const part = Number(parts[at + 1])
    if (part !== PANES_MINIMUM[at]) return part > PANES_MINIMUM[at]
  }
  return true
}

const STATE = new Set(['running', 'waiting', 'idle', 'done', 'failed'])
const PROVIDER = /^[a-z0-9][a-z0-9_-]{0,31}$/
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/
const LABEL = /^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,79}$/
const MODEL = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/

function safe(value, pattern, fallback) {
  return typeof value === 'string' && pattern.test(value) ? value : fallback
}

function date(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)
    && Number.isFinite(Date.parse(value)) ? value : null
}

export function parseLine(line) {
  if (typeof line !== 'string' || line.length > 1_000_000) return null
  let value
  try { value = JSON.parse(line) } catch { return null }
  if (!value || value.schema !== SCHEMA || !Array.isArray(value.trees) || value.trees.length > 32) return null
  const trees = []
  for (const raw of value.trees) {
    if (!raw || !ID.test(raw.treeKey || '') || !Array.isArray(raw.nodes) || raw.nodes.length > 257) return null
    const nodes = []
    const ids = new Set()
    for (const item of raw.nodes) {
      if (!item || !ID.test(item.nodeId || '') || ids.has(item.nodeId)) return null
      ids.add(item.nodeId)
      nodes.push({
        nodeId: item.nodeId,
        displayName: safe(item.displayName, LABEL, 'Subagent'),
        parent: item.parent === null ? null : safe(item.parent, ID, 'root'),
        provider: safe(item.provider, PROVIDER, 'unknown'),
        model: safe(item.model, MODEL, null),
        role: item.role === 'lead' ? 'lead' : 'worker',
        state: STATE.has(item.state) ? item.state : 'failed',
        startedAt: date(item.startedAt),
        lastTurn: item.lastTurn && typeof item.lastTurn === 'object'
          ? { status: safe(item.lastTurn.status, LABEL, 'unknown'), completedAt: date(item.lastTurn.completedAt) }
          : null,
      })
    }
    // Missing metadata means an older engine, not an empty report queue.
    const reportsReady = Number.isSafeInteger(raw.reportsReady) && raw.reportsReady >= 0 && raw.reportsReady <= 256 ? raw.reportsReady : null
    trees.push({ treeKey: raw.treeKey, live: raw.live === true, nodes, reportsReady })
  }
  return trees
}

// Only the plugin child resolves the exact MCP owner through process identity.
// A global tree stream must never be accepted as a session-scoped UI frame.
export function parseSessionLine(line) {
  const trees = parseLine(line)
  if (!trees) return null
  const { session } = JSON.parse(line)
  if (session === null && trees.length === 0) return []
  if (!session || trees.length !== 1 || session.treeKey !== trees[0].treeKey
      || !trees[0].live || !session.startedAt
      || session.startedAt !== trees[0].nodes.find(node => node.role === 'lead')?.startedAt) return null
  return trees
}

// Explicit bindings never select a global slot or a reused tree identity.
export function sessionTrees(trees, binding) {
  if (!binding?.live) return []
  const startedAt = binding.nodes.find(node => node.role === 'lead')?.startedAt
  if (!startedAt) return []
  return trees.filter(tree => tree.live && tree.treeKey === binding.treeKey
    && tree.nodes.find(node => node.role === 'lead')?.startedAt === startedAt)
}

export function summary(trees) {
  const workers = trees.filter(tree => tree.live).flatMap(tree => tree.nodes)
    .filter(node => node.role === 'worker' && ['running', 'waiting', 'idle'].includes(node.state))
  if (!workers.length) return '0 subagents'
  const labels = ['running', 'waiting', 'idle', 'done', 'failed']
  const parts = labels.map(state => [workers.filter(node => node.state === state).length, state])
    .filter(([count]) => count > 0).map(([count, state]) => `${count} ${state}`)
  const names = [...new Set(workers.map(node => node.provider))].sort()
  const providers = names.map(name => `${name} ${workers.filter(node => node.provider === name).length}`)
  return `${providers.join(' · ')} — ${parts.join(' · ')}`
}

export function rows(trees, now = Date.now()) {
  const result = []
  for (const tree of trees) {
    const nodes = tree.nodes
    const children = new Map()
    for (const node of nodes) {
      const parent = node.parent || ''
      children.set(parent, [...(children.get(parent) || []), node])
    }
    const seen = new Set()
    let collapsed = 0
    const walk = (parent, depth) => {
      for (const node of children.get(parent) || []) {
        if (seen.has(node.nodeId)) continue
        seen.add(node.nodeId)
        const finished = Date.parse(node.lastTurn?.completedAt || '')
        if (node.state === 'done' && Number.isFinite(finished) && now - finished >= DONE_COLLAPSE_MS) {
          collapsed += 1
        } else {
          result.push({ kind: 'node', treeKey: tree.treeKey, depth, node })
          walk(node.nodeId, depth + 1)
        }
      }
    }
    walk('', 0)
    // Malformed parent links from a future contract must not hide subagents.
    for (const node of nodes) if (!seen.has(node.nodeId)) walk(node.parent || '', 0)
    if (collapsed) result.push({ kind: 'collapsed', treeKey: tree.treeKey, depth: 1, count: collapsed })
  }
  return result
}
