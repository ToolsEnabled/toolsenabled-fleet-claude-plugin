export type FleetNode = {
  nodeId: string
  displayName: string
  parent: string | null
  provider: string
  model: string | null
  role: 'lead' | 'worker'
  state: 'running' | 'waiting' | 'idle' | 'done' | 'failed'
  startedAt: string | null
  lastTurn: { status: string; completedAt: string | null } | null
}
export type FleetTree = { treeKey: string; live: boolean; nodes: FleetNode[]; reportsReady: number | null }
export type FleetSnapshot = { trees: FleetTree[]; at: number; error: string; notice: string; warning: boolean; reportsReady: number | null }

declare module 'claude-code' {
  interface PluginState {
    'toolsenabled-fleet': { snapshot: FleetSnapshot }
  }
}
