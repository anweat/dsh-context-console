/**
 * Shared wire types for dsh-context-console.
 * This module must stay browser-safe (no node imports).
 */

export const CONTEXT_CONSOLE_RPC_CHANNEL = '/dsh-context-console'

export type Category = 'prompt' | 'skill' | 'mcp' | 'tools'
export type InsertionMode = 'tail' | 'system-prefix'

export interface TrajectoryCell {
  seq: number
  type: string
  kind: 'user' | 'assistant' | 'reasoning' | 'tool-call' | 'tool-result' | 'subagent' | 'request-header' | 'request-context' | 'boundary' | 'other'
  turn?: number
  step?: number
  time: number
  color: string
  icon: string
  summary: string
  expanded?: TrajectoryCellDetail
  inSurface: boolean
  shadowed: boolean
  replacedBy: number[]
  replacementOf: number[]
  cacheMiss?: boolean
}

export interface TrajectoryCellDetail {
  seq: number
  type: string
  time: number
  raw?: unknown
  text?: string
  reasoning?: string
  provider?: string
  model?: string
  toolName?: string
  toolArguments?: string
  toolResultText?: string
  isError?: boolean
  usage?: Record<string, unknown>
  requestHeader?: Record<string, unknown>
  callId?: string
  childSessionId?: string
  turn?: number
  step?: number
}

export interface TrajectorySnapshot {
  sessionId: string
  lastSeq: number
  eventCount: number
  cells: TrajectoryCell[]
}

export interface InventoryItem {
  id: string
  category: Category
  name: string
  description: string
  source: 'builtin' | 'discovered' | 'custom' | 'template'
  state: 'available' | 'active'
  insertion: InsertionMode
  cacheImpact: 'none' | 'prefix-destructive'
  meta: Record<string, unknown>
}

export interface InventorySnapshot {
  categories: Record<Category, {
    available: InventoryItem[]
    active: InventoryItem[]
  }>
}

export interface CacheOverview {
  sessionId: string
  requestCount: number
  missCount: number
  lastCacheRead?: number
  lastCacheWrite?: number
  lastHeaderReason?: string
  lastHeaderChangeAt?: number
  lastMissAt?: number
}

export interface HistoryEntry {
  id: number
  ts: number
  kind: string
  sessionId?: string
  category?: string
  action?: string
  payload?: unknown
}

export type SimMessageType = 'assistant' | 'user' | 'tool-call' | 'tool-result' | 'raw'

export interface SimMessageInput {
  type?: SimMessageType
  content?: string
  reasoning?: string
  provider?: string
  model?: string
  usage?: Record<string, number> | null
  toolName?: string
  toolArguments?: string
  toolResultText?: string
  isError?: boolean
  callId?: string
  raw?: unknown
}

export interface SimMessageResult {
  sessionId: string
  turn: number
  step: number
  seq: number
  messageId: string
  flushed: boolean
}

export interface MessageEditPatch {
  text?: string
  reasoning?: string
  provider?: string
  model?: string
  toolResultText?: string
  isError?: boolean
  usage?: Record<string, number> | null
}

export interface MessageEditResult {
  sessionId: string
  replacedSeq: number
  newSeq: number
  type: string
  flushed: boolean
}

export interface ConsoleOverview {
  promptCount: number
  skillCount: number
  mcpCount: number
  toolCount: number
  cacheMissCount: number
  historyCount: number
}
