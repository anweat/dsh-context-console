/**
 * Detailed live-session context parsing, recording, and surface replacement.
 *
 * The parser walks the append-only session log and card-ifies every
 * conversation-relevant event:
 *   - turn/start / turn/end / step/start / step/end  -> boundary cards
 *   - user/message, assistant/message               -> editable message cards
 *   - tool/call, tool/result                        -> editable tool cards
 *   - request/header, request/context               -> request cards (read-only)
 *   - every other log-only event                    -> generic raw-JSON cards
 *
 * `assistant/chunk` is the only folded event family: chunks are counted per
 * turn instead of becoming thousands of cards. Surface-fold facts
 * (`inSurface`, `shadowed`, `replacedBy`, `replacementOf`) are computed so an
 * applied edit is visible as "original shadowed, replacement active".
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  createAssistantMessage, createUserMessage, freezeMessage,
} from '@deepseek-ai/dsh-llm'
import type { ContentBlock, MessageSource, TokenUsage, ToolResultMessage } from '@deepseek-ai/dsh-llm'
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import {
  type ContextApplyResponse, type ContextCard, type ContextCardPatch,
  type ContextSnapshot, type ContextTurnSummary, type ForgeUsage,
} from './shared-types.ts'

const RECORD_PREFIX = 'context-'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeSessionId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, '_')
}

function joinTextBlocks(content: readonly ContentBlock[], kind: 'text' | 'reasoning'): string {
  const parts: string[] = []
  for (const block of content) {
    if (block.type === kind) parts.push(block.text)
  }
  return parts.join('\n\n')
}

function otherBlocksOf(content: readonly ContentBlock[]): ContentBlock[] {
  return content.filter(block => block.type !== 'text' && block.type !== 'reasoning')
}

function usageOf(usage: TokenUsage): ForgeUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
    ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
  }
}

function preview(text: string, max = 160): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`
}

function cardFor(event: SessionEvent): ContextCard | undefined {
  switch (event.type) {
    case 'turn/start': {
      const data = event.data as { turn: number }
      return {
        key: `${event.type}:${event.seq}`,
        seq: event.seq,
        time: event.time,
        type: event.type,
        kind: 'turn-boundary',
        turn: data.turn,
        summary: `turn ${data.turn} start`,
        editable: false,
        applyable: false,
        inSurface: false,
        shadowed: false,
        replacedBy: [],
        replacementOf: [],
      }
    }
    case 'turn/end': {
      const data = event.data as { turn: number; reason: unknown }
      return {
        key: `${event.type}:${event.seq}`,
        seq: event.seq,
        time: event.time,
        type: event.type,
        kind: 'turn-boundary',
        turn: data.turn,
        summary: `turn ${data.turn} end`,
        raw: data.reason,
        editable: false,
        applyable: false,
        inSurface: false,
        shadowed: false,
        replacedBy: [],
        replacementOf: [],
      }
    }
    case 'step/start': {
      const data = event.data as { turn: number; step: number }
      return {
        key: `${event.type}:${event.seq}`,
        seq: event.seq,
        time: event.time,
        type: event.type,
        kind: 'step-boundary',
        turn: data.turn,
        step: data.step,
        summary: `step ${data.turn}/${data.step} start`,
        editable: false,
        applyable: false,
        inSurface: false,
        shadowed: false,
        replacedBy: [],
        replacementOf: [],
      }
    }
    case 'step/end': {
      const data = event.data as { turn: number; step: number }
      return {
        key: `${event.type}:${event.seq}`,
        seq: event.seq,
        time: event.time,
        type: event.type,
        kind: 'step-boundary',
        turn: data.turn,
        step: data.step,
        summary: `step ${data.turn}/${data.step} end`,
        editable: false,
        applyable: false,
        inSurface: false,
        shadowed: false,
        replacedBy: [],
        replacementOf: [],
      }
    }
    case 'user/message': {
      const message = event.data
      const text = joinTextBlocks(message.content, 'text')
      const reasoning = joinTextBlocks(message.content, 'reasoning')
      const otherBlocks = otherBlocksOf(message.content)
      return {
        key: `${event.type}:${event.seq}`,
        seq: event.seq,
        time: event.time,
        type: event.type,
        kind: 'user',
        role: 'user',
        text,
        reasoning,
        summary: preview(text === '' ? reasoning : text),
        sourceKind: message.source.kind,
        ...(otherBlocks.length > 0 ? { otherBlocks } : {}),
        editable: true,
        applyable: true,
        inSurface: false,
        shadowed: false,
        replacedBy: [],
        replacementOf: [],
      }
    }
    case 'assistant/message': {
      const data = event.data as {
        turn: number
        step: number
        message: { content: ContentBlock[]; source: { provider: string; model: string } }
        usage?: TokenUsage
      }
      const text = joinTextBlocks(data.message.content, 'text')
      const reasoning = joinTextBlocks(data.message.content, 'reasoning')
      const otherBlocks = otherBlocksOf(data.message.content)
      return {
        key: `${event.type}:${event.seq}`,
        seq: event.seq,
        time: event.time,
        type: event.type,
        kind: 'assistant',
        role: 'assistant',
        turn: data.turn,
        step: data.step,
        text,
        reasoning,
        summary: preview(text === '' ? reasoning : text),
        provider: data.message.source.provider,
        model: data.message.source.model,
        sourceKind: 'model',
        ...(data.usage !== undefined ? { usage: usageOf(data.usage) } : {}),
        ...(otherBlocks.length > 0 ? { otherBlocks } : {}),
        editable: true,
        applyable: true,
        inSurface: false,
        shadowed: false,
        replacedBy: [],
        replacementOf: [],
      }
    }
    case 'tool/call': {
      const data = event.data as {
        turn: number; step: number; callId: string; name: string; arguments: string
      }
      return {
        key: `${event.type}:${event.seq}`,
        seq: event.seq,
        time: event.time,
        type: event.type,
        kind: 'tool-call',
        turn: data.turn,
        step: data.step,
        callId: data.callId,
        toolName: data.name,
        toolArguments: data.arguments,
        summary: `call ${data.name}`,
        editable: true,
        applyable: false,
        inSurface: false,
        shadowed: false,
        replacedBy: [],
        replacementOf: [],
      }
    }
    case 'tool/result': {
      const data = event.data as {
        turn: number
        step: number
        message: {
          content: [{ type: 'tool-result'; content: ContentBlock[]; isError?: boolean }]
          source: { callId: string }
        }
        error?: { name: string; code: string }
      }
      const block = data.message.content[0]
      const resultBlocks = block !== undefined && block.type === 'tool-result' ? block.content : []
      const text = joinTextBlocks(resultBlocks, 'text')
      return {
        key: `${event.type}:${event.seq}`,
        seq: event.seq,
        time: event.time,
        type: event.type,
        kind: 'tool-result',
        turn: data.turn,
        step: data.step,
        callId: data.message.source.callId,
        toolResultText: text,
        isError: block?.isError === true,
        ...(data.error !== undefined ? { toolError: data.error } : {}),
        summary: preview(text) || `result for ${data.message.source.callId}`,
        editable: true,
        applyable: true,
        inSurface: false,
        shadowed: false,
        replacedBy: [],
        replacementOf: [],
      }
    }
    case 'request/header': {
      const data = event.data as {
        header: {
          config?: { provider?: string; model?: string }
          system?: string
          tools?: unknown
          adapterDefaults?: unknown
        }
        reason?: string
      }
      return {
        key: `${event.type}:${event.seq}`,
        seq: event.seq,
        time: event.time,
        type: event.type,
        kind: 'request',
        summary: data.header.config === undefined
          ? 'request header'
          : `request header ${data.header.config.provider ?? ''}/${data.header.config.model ?? ''}`,
        requestHeader: data.header,
        systemPrompt: data.header.system,
        toolSchemas: data.header.tools,
        raw: data.reason,
        editable: false,
        applyable: false,
        inSurface: false,
        shadowed: false,
        replacedBy: [],
        replacementOf: [],
      }
    }
    case 'request/context': {
      const data = event.data as { provider?: string; model?: string; contextWindow?: number }
      return {
        key: `${event.type}:${event.seq}`,
        seq: event.seq,
        time: event.time,
        type: event.type,
        kind: 'request',
        summary: `route ${data.provider ?? '?'}/${data.model ?? '?'}`,
        raw: data,
        editable: false,
        applyable: false,
        inSurface: false,
        shadowed: false,
        replacedBy: [],
        replacementOf: [],
      }
    }
    case 'assistant/chunk':
      // Folded into per-turn counts; chunk-level cards would drown the UI.
      return undefined
    default:
      return {
        key: `${event.type}:${event.seq}`,
        seq: event.seq,
        time: event.time,
        type: event.type,
        kind: 'other',
        summary: event.type,
        raw: event.data,
        editable: false,
        applyable: false,
        inSurface: false,
        shadowed: false,
        replacedBy: [],
        replacementOf: [],
      }
  }
}

/** Parse one live session into the card-ified context snapshot. */
export function parseContext(session: Session): ContextSnapshot {
  const cards: ContextCard[] = []
  const counts: Record<string, number> = {}
  const turns: ContextTurnSummary[] = []
  const turnByNumber = new Map<number, ContextTurnSummary>()
  const replacedBy = new Map<number, number[]>()
  const replacementOf = new Map<number, number[]>()

  for (const event of session.events) {
    counts[event.type] = (counts[event.type] ?? 0) + 1
    const surfaceFacts = event as SessionEvent & {
      surfaceOp?: 'append' | { op: 'replace'; start: number; end: number }
      sourceEventSeqs?: number[]
    }
    if (surfaceFacts.surfaceOp !== undefined && typeof surfaceFacts.surfaceOp === 'object' && surfaceFacts.surfaceOp.op === 'replace') {
      const sources = surfaceFacts.sourceEventSeqs ?? []
      replacementOf.set(event.seq, sources)
      for (const source of sources) {
        const list = replacedBy.get(source) ?? []
        list.push(event.seq)
        replacedBy.set(source, list)
      }
    }

    if (event.type === 'turn/start') {
      const summary: ContextTurnSummary = {
        turn: event.data.turn,
        startSeq: event.seq,
        endSeq: event.seq,
        startedAt: event.time,
        stepCount: 0,
        chunkCount: 0,
        cardCount: 0,
      }
      turns.push(summary)
      turnByNumber.set(event.data.turn, summary)
    } else if (event.type === 'turn/end') {
      const summary = turnByNumber.get(event.data.turn)
      if (summary !== undefined) {
        summary.endSeq = event.seq
        summary.endedAt = event.time
        summary.reason = event.data.reason
      }
    } else if (event.type === 'step/start') {
      const summary = turnByNumber.get(event.data.turn)
      if (summary !== undefined) summary.stepCount += 1
    } else if (event.type === 'assistant/chunk') {
      const data = event.data as { turn: number }
      const summary = turnByNumber.get(data.turn)
      if (summary !== undefined) summary.chunkCount += 1
    }

    const card = cardFor(event)
    if (card === undefined) continue
    const turnSummary = card.turn === undefined ? undefined : turnByNumber.get(card.turn)
    if (turnSummary !== undefined) turnSummary.cardCount += 1
    if (surfaceFacts.surfaceOp !== undefined) card.surfaceOp = surfaceFacts.surfaceOp
    cards.push(card)
  }

  // Replacement arrows can point both directions, so fill them after the
  // complete log pass (an earlier original may be shadowed by a later event).
  const surface = new Set(session.surface.nodes)
  for (const card of cards) {
    card.replacedBy = replacedBy.get(card.seq) ?? []
    card.shadowed = card.replacedBy.length > 0
    card.replacementOf = replacementOf.get(card.seq) ?? []
    card.inSurface = surface.has(card.seq)
  }

  return {
    sessionId: session.id,
    recordedAt: Date.now(),
    lastSeq: session.seq - 1,
    eventCount: session.events.length,
    surfaceNodes: session.surface.nodes,
    counts,
    turns,
    cards,
  }
}

interface ContextRecordFile {
  snapshot: ContextSnapshot
  overrides: Record<string, ContextCard>
}

/** Merge one persisted card override onto a freshly parsed card. */
function mergeOverride(fresh: ContextCard, override: ContextCard): ContextCard {
  return {
    ...fresh,
    text: override.text ?? fresh.text,
    reasoning: override.reasoning ?? fresh.reasoning,
    provider: override.provider ?? fresh.provider,
    model: override.model ?? fresh.model,
    toolName: override.toolName ?? fresh.toolName,
    toolArguments: override.toolArguments ?? fresh.toolArguments,
    toolResultText: override.toolResultText ?? fresh.toolResultText,
    isError: override.isError ?? fresh.isError,
    usage: override.usage === undefined ? fresh.usage : override.usage,
  }
}

function mergedSnapshot(fresh: ContextSnapshot, overrides: Record<string, ContextCard>): ContextSnapshot {
  return {
    ...fresh,
    cards: fresh.cards.map(card => overrides[card.key] === undefined ? card : mergeOverride(card, overrides[card.key] as ContextCard)),
  }
}

/**
 * Durable context-recording store. One JSON file per session keeps the last
 * parsed snapshot plus any card overrides, so "记录" survives reloads and
 * re-parses until the edited card is actually applied to the session.
 */
export class ContextRecordStore {
  private readonly dir: string

  constructor(dataDir: string) {
    this.dir = dataDir
    mkdirSync(this.dir, { recursive: true })
  }

  private file(sessionId: string): string {
    return join(this.dir, `${RECORD_PREFIX}${safeSessionId(sessionId)}.json`)
  }

  private read(sessionId: string): ContextRecordFile | null {
    let raw: string
    try {
      raw = readFileSync(this.file(sessionId), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    if (raw.trim() === '') return null
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed) || !isRecord(parsed.snapshot) || !isRecord(parsed.overrides)) {
      throw new Error(`corrupt context record for session "${sessionId}"`)
    }
    return parsed as unknown as ContextRecordFile
  }

  private write(sessionId: string, record: ContextRecordFile): void {
    const file = this.file(sessionId)
    const tmp = `${file}.tmp`
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    try {
      renameSync(tmp, file)
    } catch {
      writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    }
  }

  /** Last recorded (override-merged) snapshot, or null when never parsed. */
  load(sessionId: string): ContextSnapshot | null {
    const record = this.read(sessionId)
    return record === null ? null : mergedSnapshot(record.snapshot, record.overrides)
  }

  /** Re-parse the session and record the fresh snapshot, preserving overrides. */
  record(session: Session): ContextSnapshot {
    const fresh = parseContext(session)
    const previous = this.read(session.id)
    const overrides = previous?.overrides ?? {}
    this.write(session.id, { snapshot: fresh, overrides })
    return mergedSnapshot(fresh, overrides)
  }

  /** Update one card override and return the re-merged snapshot. */
  updateCard(sessionId: string, key: string, patch: ContextCardPatch): ContextSnapshot {
    const record = this.read(sessionId)
    if (record === null) throw new Error('no recorded context yet; refresh the parse first')
    const freshCard = record.snapshot.cards.find(card => card.key === key)
    if (freshCard === undefined) throw new Error(`unknown context card "${key}"`)
    if (!freshCard.editable) throw new Error(`card "${key}" is not editable`)

    const previous = record.overrides[key] ?? freshCard
    const usage = patch.usage === undefined ? previous.usage : patch.usage
    const next: ContextCard = {
      ...previous,
      text: patch.text === undefined ? previous.text : patch.text,
      reasoning: patch.reasoning === undefined ? previous.reasoning : patch.reasoning,
      provider: patch.provider === undefined ? previous.provider : patch.provider,
      model: patch.model === undefined ? previous.model : patch.model,
      toolName: patch.toolName === undefined ? previous.toolName : patch.toolName,
      toolArguments: patch.toolArguments === undefined ? previous.toolArguments : patch.toolArguments,
      toolResultText: patch.toolResultText === undefined ? previous.toolResultText : patch.toolResultText,
      isError: patch.isError === undefined ? previous.isError : patch.isError,
      usage,
    }
    const overrides = { ...record.overrides, [key]: next }
    this.write(sessionId, { snapshot: record.snapshot, overrides })
    return mergedSnapshot(record.snapshot, overrides)
  }

  /** Forget every card override for one session (the parse returns to raw log). */
  resetOverrides(sessionId: string): ContextSnapshot | null {
    const record = this.read(sessionId)
    if (record === null) return null
    this.write(sessionId, { snapshot: record.snapshot, overrides: {} })
    return record.snapshot
  }

  /** Remove one override after it has been applied to the live session. */
  private clearOverride(sessionId: string, key: string): void {
    const record = this.read(sessionId)
    if (record === null) return
    const overrides = { ...record.overrides }
    delete overrides[key]
    this.write(sessionId, { snapshot: record.snapshot, overrides })
  }

  /**
   * Replace one recorded surface card in the live session with its edited
   * content. Only append-origin surface cards can be replaced; shadowed cards
   * (compaction, or an earlier applied edit) are refused.
   */
  async apply(ctx: Context, sessionId: string, key: string): Promise<ContextApplyResponse> {
    const snapshot = this.load(sessionId)
    if (snapshot === null) throw new Error('no recorded context yet; refresh the parse first')
    const card = snapshot.cards.find(candidate => candidate.key === key)
    if (card === undefined) throw new Error(`unknown context card "${key}"`)
    if (!card.applyable) throw new Error(`card "${key}" (${card.type}) cannot be applied to the session`)
    if (!card.inSurface) throw new Error(`card "${key}" is not an active surface node (compacted, replaced, or not a surface event)`)
    if (card.shadowed) throw new Error(`card "${key}" is already shadowed by replacement seq(s) ${card.replacedBy.join(', ')}`)

    const session = ctx.sessions.get(sessionId as SessionId)
    if (session === undefined) throw new Error(`session "${sessionId}" is not live in this process`)

    let open = false
    for (const event of session.events) {
      if (event.type === 'turn/start') open = true
      else if (event.type === 'turn/end') open = false
    }
    if (open) throw new Error('session has an open turn; wait until the current turn ends before applying an edit')

    const original = session.events[card.seq]
    if (original === undefined || original.type !== card.type || !isAppendSurfaceEvent(original)) {
      throw new Error(`session event #${card.seq} is not an append-origin ${card.type}`)
    }

    let event: SessionEvent
    switch (card.kind) {
      case 'assistant': {
        const data = original.data as { turn: number; step: number }
        const text = card.text?.trim() ?? ''
        const reasoning = card.reasoning?.trim() ?? ''
        if (text === '' && reasoning === '') throw new Error('edited assistant message must have text or reasoning')
        const blocks: ContentBlock[] = []
        if (reasoning !== '') blocks.push({ type: 'reasoning', text: reasoning })
        blocks.push({ type: 'text', text: text === '' ? '(empty visible content)' : text })
        const message = createAssistantMessage({
          content: blocks,
          source: {
            provider: (card.provider ?? 'assistant-message-forge').trim() || 'assistant-message-forge',
            model: (card.model ?? 'test').trim() || 'test',
          },
        })
        event = session.append('assistant/message', {
          turn: data.turn,
          step: data.step,
          message,
          ...(card.usage === undefined || card.usage === null ? {} : { usage: card.usage as TokenUsage }),
        }, {
          surfaceOp: { op: 'replace', start: card.seq, end: card.seq },
          sourceEventSeqs: [card.seq],
        })
        break
      }
      case 'user': {
        const originalMessage = original.data as { source: MessageSource }
        const text = card.text?.trim() ?? ''
        const reasoning = card.reasoning?.trim() ?? ''
        if (text === '' && reasoning === '') throw new Error('edited user message must have text or reasoning')
        const blocks: ContentBlock[] = []
        if (reasoning !== '') blocks.push({ type: 'reasoning', text: reasoning })
        blocks.push({ type: 'text', text })
        const message = createUserMessage({
          content: blocks,
          source: originalMessage.source,
        })
        event = session.append('user/message', message, {
          surfaceOp: { op: 'replace', start: card.seq, end: card.seq },
          sourceEventSeqs: [card.seq],
        })
        break
      }
      case 'tool-result': {
        const data = original.data as {
          turn: number
          step: number
          message: ToolResultMessage
          error?: { name: string; code: string }
        }
        // Core surface validation restricts a tool/result rewrite to its
        // content blocks: message id, source, isError, and the error wrapper
        // must all stay byte-identical, so clone the original message instead
        // of minting a new one.
        const originalMessage = data.message
        const originalBlock = originalMessage.content[0]
        const message = freezeMessage({
          ...originalMessage,
          content: [{
            ...originalBlock,
            content: [{ type: 'text', text: card.toolResultText ?? '' }],
          }] as typeof originalMessage.content,
        })
        event = session.append('tool/result', {
          turn: data.turn,
          step: data.step,
          message,
          ...(data.error === undefined ? {} : { error: data.error }),
        }, {
          surfaceOp: { op: 'replace', start: card.seq, end: card.seq },
          sourceEventSeqs: [card.seq],
        })
        break
      }
      default:
        throw new Error(`card "${key}" is not a replaceable surface card`)
    }

    let flushed = false
    try {
      flushed = await ctx.sessions.flush(session)
    } catch (error) {
      ctx.logger?.warn(`[dsh-assistant-message-forge] flush after apply failed: ${String(error)}`)
    }
    this.clearOverride(session.id, key)

    return {
      sessionId: session.id,
      replacedSeq: card.seq,
      newSeq: event.seq,
      type: card.type,
      turn: card.turn,
      step: card.step,
      flushed,
    }
  }
}
