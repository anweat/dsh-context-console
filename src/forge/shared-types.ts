/** Wire types shared by the Host half and the Client half of dsh-assistant-message-forge. */

/** Generic Connection RPC channel mounted by the Host half. */
export const AMF_RPC_CHANNEL = '/dsh-assistant-message-forge'

/** One persisted, editable assistant-message draft. */
export interface AssistantDraft {
  id: string
  title: string
  /** Visible assistant text. */
  content: string
  /** Optional reasoning/thinking text rendered before the visible text. */
  reasoning: string
  /** Provider route recorded on the injected assistant message. */
  provider: string
  /** Model id recorded on the injected assistant message. */
  model: string
  createdAt: number
  updatedAt: number
}

/** Client-supplied upsert input for one draft; the Host fills id/timestamps. */
export interface AssistantDraftInput {
  id?: string
  title?: string
  content?: string
  reasoning?: string
  provider?: string
  model?: string
}

/** Optional token accounting attached to an injected assistant message. */
export interface ForgeUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

/** Message to append to a live session as one synthetic assistant turn. */
export interface InjectMessageInput {
  content: string
  reasoning?: string
  provider?: string
  model?: string
  usage?: ForgeUsage | null
}

/** Result of one `session/inject` RPC call. */
export interface InjectResponse {
  sessionId: string
  turn: number
  step: number
  seq: number
  messageId: string
  flushed: boolean
}

/** Header line (first JSONL record) of an imported session log. */
export interface SessionLogHeader {
  type: 'session'
  version?: number
  id?: string
  createdAt?: number
  cwd?: string
  agentPreset?: string
  [key: string]: unknown
}

/** One recognized surface message/event extracted from an imported session log. */
export interface RecognizedEntry {
  seq: number
  time: number
  type: string
  role?: 'user' | 'assistant'
  turn?: number
  step?: number
  /** Visible text blocks joined with double newlines. */
  text?: string
  /** Reasoning blocks joined with double newlines. */
  reasoning?: string
  provider?: string
  model?: string
  /** Tool call facts (type `tool/call`). */
  callId?: string
  toolName?: string
  toolArguments?: string
  /** Tool result facts (type `tool/result`). */
  isError?: boolean
  /** Assistant usage, when the source event recorded one. */
  usage?: ForgeUsage
  /** Content blocks dropped by the text/reasoning projection (tool calls, images, …). */
  unsupportedBlocks?: number
}

/** Card presentation kind, derived from the raw session event type. */
export type ContextCardKind =
  | 'turn-boundary'
  | 'step-boundary'
  | 'user'
  | 'assistant'
  | 'tool-call'
  | 'tool-result'
  | 'request'
  | 'other'

/**
 * One card-ified record of a parsed live-session event. Text-producing cards
 * carry editable `text` / `reasoning` / `provider` / `model` fields; generic
 * cards keep their `raw` JSON payload for read-only inspection.
 */
export interface ContextCard {
  /** Stable identity within one context snapshot: `<type>:<seq>`. */
  key: string
  seq: number
  time: number
  type: string
  kind: ContextCardKind
  turn?: number
  step?: number
  /** One-line card summary rendered when the card is collapsed. */
  summary: string

  // User / assistant projection (editable).
  role?: 'user' | 'assistant'
  text?: string
  reasoning?: string
  provider?: string
  model?: string
  usage?: ForgeUsage | null
  sourceKind?: string
  /** Non text/reasoning content blocks (tool-call, image, …) kept for detail. */
  otherBlocks?: unknown[]

  // Tool call / result projection (call fields are read-only; args/results editable).
  callId?: string
  toolName?: string
  toolArguments?: string
  toolResultText?: string
  isError?: boolean
  toolError?: { name?: string; code?: string }

  // Request envelope projection (read-only detail).
  requestHeader?: unknown
  systemPrompt?: string
  toolSchemas?: unknown

  // Generic log-only events keep their whole payload for inspection.
  raw?: unknown

  // Editing / application capability.
  editable: boolean
  applyable: boolean

  // Surface-fold status at parse time.
  inSurface: boolean
  shadowed: boolean
  replacedBy: number[]
  replacementOf: number[]
  surfaceOp?: 'append' | { op: 'replace'; start: number; end: number }
}

/** Per-turn rollup used by the client to render boundary headers. */
export interface ContextTurnSummary {
  turn: number
  startSeq: number
  endSeq: number
  startedAt: number
  endedAt?: number
  reason?: unknown
  stepCount: number
  chunkCount: number
  cardCount: number
}

/** Recorded parse of one live session (cards + rollups + surface fold facts). */
export interface ContextSnapshot {
  sessionId: string
  recordedAt: number
  lastSeq: number
  eventCount: number
  surfaceNodes: readonly number[]
  counts: Record<string, number>
  turns: ContextTurnSummary[]
  cards: ContextCard[]
}

/** Editable fields accepted by `records/update`. */
export interface ContextCardPatch {
  text?: string
  reasoning?: string
  provider?: string
  model?: string
  toolName?: string
  toolArguments?: string
  toolResultText?: string
  isError?: boolean
  usage?: ForgeUsage | null
}

/** Result of one `context/apply` RPC call. */
export interface ContextApplyResponse {
  sessionId: string
  replacedSeq: number
  newSeq: number
  type: string
  turn?: number
  step?: number
  flushed: boolean
}

/** Result of one `sessionlog/parse` RPC call. */
export interface SessionLogParseResponse {
  name: string
  /** Whether a zstd frame container was decoded. */
  compressed: boolean
  /** Header record, when the first line was a `type: 'session'` record. */
  header: SessionLogHeader | null
  /** Total decoded storage events (after packed chunk-row expansion). */
  totalEvents: number
  /** Number of recognized surface events in the whole log. */
  recognizedTotal: number
  /** Recognized surface entries, capped for transport. */
  recognized: RecognizedEntry[]
  /** True when `recognized` was capped below `recognizedTotal`. */
  truncated: boolean
  /** Lines/rows that failed to parse. */
  parseIssues: number
  /** Up to three parse-issue messages for display. */
  issueSamples: string[]
  /** Event-type totals over the whole log. */
  counts: Record<string, number>
  /** Conservative integrity/repair preview for this same decoded log. */
  repair?: SessionLogRepairReport
}

/** One later physical branch that rewound an already-decoded logical suffix. */
export interface SessionLogBranchRewind {
  fromSeq: number
  discardedEvents: number
}

/** Why conservative recovery stopped consuming physical rows. */
export interface SessionLogRepairStop {
  line: number
  reason: string
}

/** Auditable preview/result for repairing an imported session log. */
export interface SessionLogRepairReport {
  name: string
  compressed: boolean
  header: SessionLogHeader | null
  originalEventCount: number
  repairedEventCount: number
  branchRewinds: SessionLogBranchRewind[]
  closersAdded: string[]
  stopped: SessionLogRepairStop | null
  repairable: boolean
  validationError: string | null
}

/** Result of creating a new repaired session without modifying the source log. */
export interface SessionLogRepairCreateResponse {
  sessionId: string
  flushed: boolean
  report: SessionLogRepairReport
}
