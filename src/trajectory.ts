/**
 * Trajectory wall projection.
 *
 * Converts a live session's append-only event log into small brick cells.
 * Each cell carries a type color/icon and a compact summary; the client can
 * expand a cell into a full row. V3 assistant streams stay nested in their
 * settlement event instead of creating thousands of bricks.
 */
import type { TrajectoryCell, TrajectoryCellDetail, TrajectorySnapshot } from './shared-types.ts'

interface SessionLike {
  id: string
  seq: number
  events: Array<Record<string, any>>
  surface?: { nodes?: number[] }
}

interface SurfaceFacts {
  surfaceOp?: 'append' | { op: 'replace'; startSeq: number; endSeq: number } | undefined
  sourceEventSeqs?: number[]
}

function joinText(content: unknown[] | undefined, kind: 'text' | 'reasoning'): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block && typeof block === 'object' && (block as any).type === kind) {
      parts.push(String((block as any).text ?? ''))
    }
  }
  return parts.join('\n\n')
}

function preview(text: string, max = 160): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`
}

function cellFor(event: Record<string, any>): TrajectoryCell | undefined {
  const type = String(event.type ?? 'unknown')
  const seq = Number(event.seq ?? 0)
  const time = Number(event.time ?? 0)
  const data = (event.data ?? {}) as Record<string, any>
  const base = { seq, time }

  switch (type) {
    case 'turn/start':
      return {
        ...base,
        type,
        kind: 'boundary',
        turn: Number(data.turn),
        summary: `turn ${String(data.turn)} start`,
        color: '#94a3b8',
        icon: '▶',
        inSurface: false,
        shadowed: false,
        replacedBy: [],
        replacementOf: [],
        expanded: { seq, type, time, turn: Number(data.turn) },
      }
    case 'turn/end':
      return {
        ...base,
        type,
        kind: 'boundary',
        turn: Number(data.turn),
        summary: `turn ${String(data.turn)} end`,
        color: '#64748b',
        icon: '■',
        inSurface: false,
        shadowed: false,
        replacedBy: [],
        replacementOf: [],
        expanded: { seq, type, time, turn: Number(data.turn), raw: data.reason },
      }
    case 'step/start':
      return {
        ...base,
        type,
        kind: 'boundary',
        turn: Number(data.turn),
        step: Number(data.step),
        summary: `step ${String(data.turn)}/${String(data.step)} start`,
        color: '#cbd5e1',
        icon: '▷',
        inSurface: false,
        shadowed: false,
        replacedBy: [],
        replacementOf: [],
        expanded: { seq, type, time, turn: Number(data.turn), step: Number(data.step) },
      }
    case 'step/end':
      return {
        ...base,
        type,
        kind: 'boundary',
        turn: Number(data.turn),
        step: Number(data.step),
        summary: `step ${String(data.turn)}/${String(data.step)} end`,
        color: '#cbd5e1',
        icon: '□',
        inSurface: false,
        shadowed: false,
        replacedBy: [],
        replacementOf: [],
        expanded: { seq, type, time, turn: Number(data.turn), step: Number(data.step) },
      }
    case 'user/message': {
      const message = (data as any).message ?? data
      const text = joinText(message.content, 'text')
      const reasoning = joinText(message.content, 'reasoning')
      return {
        ...base,
        type,
        kind: 'user',
        summary: preview(text || reasoning),
        color: '#3b82f6',
        icon: '👤',
        inSurface: false,
        shadowed: false,
        replacedBy: [],
        replacementOf: [],
        expanded: {
          seq, type, time, text, reasoning,
          raw: message.source,
        },
      }
    }
    case 'assistant/message': {
      const message = (data as any).message ?? {}
      const text = joinText(message.content, 'text')
      const reasoning = joinText(message.content, 'reasoning')
      const usage = (data as any).usage
      return {
        ...base,
        type,
        kind: 'assistant',
        turn: Number(data.turn),
        step: Number(data.step),
        summary: preview(text || reasoning),
        color: '#22c55e',
        icon: '🤖',
        inSurface: false,
        shadowed: false,
        replacedBy: [],
        replacementOf: [],
        expanded: {
          seq, type, time, text, reasoning,
          provider: message.source?.provider,
          model: message.source?.model,
          usage: usage === undefined ? undefined : { ...usage },
          turn: Number(data.turn),
          step: Number(data.step),
        },
      }
    }
    case 'tool/call': {
      const name = String(data.name)
      const isSubagent = /subagent/.test(name)
      return {
        ...base,
        type,
        kind: isSubagent ? 'subagent' : 'tool-call',
        turn: Number(data.turn),
        step: Number(data.step),
        summary: isSubagent ? `subagent ${name}` : `call ${name}`,
        color: isSubagent ? '#ec4899' : '#f97316',
        icon: isSubagent ? '🧵' : '🔧',
        inSurface: false,
        shadowed: false,
        replacedBy: [],
        replacementOf: [],
        expanded: {
          seq, type, time,
          toolName: name,
          toolArguments: String(data.arguments ?? ''),
          turn: Number(data.turn),
          step: Number(data.step),
        },
      }
    }
    case 'tool/result': {
      const message = (data as any).message ?? {}
      const block = Array.isArray(message.content) ? message.content[0] : undefined
      const resultBlocks = block && block.type === 'tool-result' ? block.content : []
      const text = joinText(resultBlocks, 'text')
      return {
        ...base,
        type,
        kind: 'tool-result',
        turn: Number(data.turn),
        step: Number(data.step),
        summary: preview(text) || `result for ${String(message.source?.callId ?? '')}`,
        color: '#d97706',
        icon: '📦',
        inSurface: false,
        shadowed: false,
        replacedBy: [],
        replacementOf: [],
        expanded: {
          seq, type, time,
          toolResultText: text,
          isError: block?.isError === true,
          callId: String(message.source?.callId ?? ''),
          raw: data.error,
          turn: Number(data.turn),
          step: Number(data.step),
        },
      }
    }
    case 'request/header': {
      const header = (data as any).header ?? {}
      return {
        ...base,
        type,
        kind: 'request-header',
        summary: `request header ${header.config?.provider ?? '?'}/${header.config?.model ?? '?'} (${String(data.reason ?? '')})`,
        color: '#8b5cf6',
        icon: '📋',
        inSurface: false,
        shadowed: false,
        replacedBy: [],
        replacementOf: [],
        expanded: {
          seq, type, time,
          requestHeader: header,
        },
      }
    }
    case 'request/context': {
      return {
        ...base,
        type,
        kind: 'request-context',
        summary: `route ${String(data.provider ?? '?')}/${String(data.model ?? '?')}`,
        color: '#a78bfa',
        icon: '🧭',
        inSurface: false,
        shadowed: false,
        replacedBy: [],
        replacementOf: [],
        expanded: { seq, type, time, raw: data },
      }
    }
    default:
      return {
        ...base,
        type,
        kind: 'other',
        summary: type,
        color: '#e2e8f0',
        icon: '·',
        inSurface: false,
        shadowed: false,
        replacedBy: [],
        replacementOf: [],
        expanded: { seq, type, time, raw: data },
      }
  }
}

export function buildTrajectory(session: SessionLike): TrajectorySnapshot {
  const cells: TrajectoryCell[] = []
  const replacedBy = new Map<number, number[]>()
  const replacementOf = new Map<number, number[]>()
  const assistantMessages: Array<{ seq: number; usage?: Record<string, any> }> = []
  const callNames = new Map<string, string>()

  for (const event of session.events) {
    if (event.type === 'tool/call') {
      const data = (event.data ?? {}) as Record<string, any>
      if (typeof data.callId === 'string' && typeof data.name === 'string') {
        callNames.set(data.callId, data.name)
      }
    }
  }

  for (const event of session.events) {
    const facts = event as SurfaceFacts
    if (facts.surfaceOp !== undefined && typeof facts.surfaceOp === 'object' && facts.surfaceOp.op === 'replace') {
      const sources = facts.sourceEventSeqs ?? []
      replacementOf.set(Number(event.seq), sources)
      for (const source of sources) {
        const list = replacedBy.get(Number(source)) ?? []
        list.push(Number(event.seq))
        replacedBy.set(Number(source), list)
      }
    }
    if (event.type === 'assistant/message') {
      assistantMessages.push({ seq: Number(event.seq), usage: (event.data as any)?.usage })
    }
    const cell = cellFor(event)
    if (cell === undefined) continue
    cells.push(cell)
  }

  const surfaceNodes = new Set(session.surface?.nodes ?? [])
  const previousUsageCount = new Map<string, number>()
  for (const cell of cells) {
    cell.replacedBy = replacedBy.get(cell.seq) ?? []
    cell.shadowed = cell.replacedBy.length > 0
    cell.replacementOf = replacementOf.get(cell.seq) ?? []
    cell.inSurface = surfaceNodes.has(cell.seq)
    if (cell.kind === 'assistant') {
      const usage = (cell.expanded as TrajectoryCellDetail | undefined)?.usage
      const cacheRead = typeof usage?.cacheReadTokens === 'number' ? Number(usage.cacheReadTokens) : undefined
      const input = typeof usage?.inputTokens === 'number' ? Number(usage.inputTokens) : undefined
      const prior = previousUsageCount.get('assistant') ?? 0
      previousUsageCount.set('assistant', prior + 1)
      if (cacheRead !== undefined && input !== undefined && input > 0 && cacheRead === 0 && prior > 0) {
        cell.cacheMiss = true
      }
    }
  }

  // Subagent tool calls/results become a dedicated subagent brick type.
  for (const cell of cells) {
    if (cell.kind === 'tool-call' && cell.expanded?.toolName !== undefined && /subagent/.test(cell.expanded.toolName)) {
      cell.kind = 'subagent'
      cell.color = '#ec4899'
      cell.icon = '🧵'
      cell.summary = `subagent ${cell.expanded.toolName}`
    }
    if (cell.kind === 'tool-result' && cell.expanded?.callId !== undefined) {
      const callName = callNames.get(cell.expanded.callId)
      if (callName !== undefined && /subagent/.test(callName)) {
        cell.kind = 'subagent'
        cell.color = '#ec4899'
        cell.icon = '🧵'
        cell.summary = `subagent result`
        const text = cell.expanded.toolResultText ?? ''
        const match = text.match(/"subagentId"\s*:\s*"([^"]+)"/) ?? text.match(/subagentId[=:]\s*([A-Za-z0-9_-]+)/)
        if (match !== null) cell.expanded.childSessionId = match[1] ?? undefined
      }
    }
  }

  return {
    sessionId: session.id,
    lastSeq: Number(session.seq ?? 0) - 1,
    eventCount: session.events.length,
    cells,
  }
}
