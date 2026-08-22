/**
 * Simulated-message injection.
 *
 * Supports several message kinds:
 *   - assistant: full synthetic assistant turn
 *   - user: append a user message (surface append)
 *   - tool-call / tool-result: append inside a synthetic step
 *   - raw: hand-written JSON event object, appended as-is (session invariants
 *     still validate it; use this for formats we do not model yet)
 */
import { randomUUID } from 'node:crypto'
import { createAssistantMessage, createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { MessageEditPatch, MessageEditResult, SimMessageInput, SimMessageResult, SimMessageType } from './shared-types.ts'

interface CtxLike {
  sessions: {
    get(id: string): any
    flush(session: any): Promise<boolean>
  }
  logger?: { warn?: (msg: string) => void }
}

function executionState(session: any): { open: boolean; nextTurn: number } {
  let openTurn: number | null = null
  let openStep: number | null = null
  let maxTurn = 0
  for (const event of session.events ?? []) {
    const type = String(event.type ?? '')
    const data = event.data ?? {}
    if (type === 'turn/start') {
      openTurn = Number(data.turn)
      openStep = null
      maxTurn = Math.max(maxTurn, Number(data.turn))
    } else if (type === 'step/start') {
      if (openTurn === Number(data.turn)) openStep = Number(data.step)
    } else if (type === 'step/end') {
      if (openTurn === Number(data.turn) && openStep === Number(data.step)) openStep = null
    } else if (type === 'turn/end') {
      if (openTurn === Number(data.turn)) {
        openTurn = null
        openStep = null
      }
    }
  }
  return { open: openTurn !== null || openStep !== null, nextTurn: maxTurn + 1 }
}

async function flush(ctx: CtxLike, session: any): Promise<boolean> {
  try {
    return await ctx.sessions.flush(session)
  } catch (error) {
    ctx.logger?.warn?.(`[dsh-context-console] flush after sim inject failed: ${String(error)}`)
    return false
  }
}

export async function injectSimulatedMessage(
  ctx: CtxLike,
  sessionId: string,
  input: SimMessageInput,
): Promise<SimMessageResult> {
  const session = ctx.sessions.get(sessionId)
  if (session === undefined) {
    throw new Error(`session "${sessionId}" is not live in this process`)
  }
  const type: SimMessageType = input.type ?? 'assistant'
  const state = executionState(session)
  const turn = state.nextTurn
  const step = 1

  switch (type) {
    case 'assistant': {
      if (state.open) {
        throw new Error('session has an open turn; wait until the current turn ends before injecting a synthetic turn')
      }
      const content = (input.content ?? '').trim()
      const reasoning = (input.reasoning ?? '').trim()
      if (content === '' && reasoning === '') {
        throw new Error('assistant message must have visible content or reasoning text')
      }
      const blocks: ContentBlock[] = []
      if (reasoning !== '') blocks.push({ type: 'reasoning', text: reasoning })
      blocks.push({ type: 'text', text: content === '' ? '(empty visible content)' : content })
      const assistantMessage = createAssistantMessage({
        content: blocks,
        source: {
          provider: (input.provider ?? 'context-console').trim() || 'context-console',
          model: (input.model ?? 'simulated').trim() || 'simulated',
        },
      })
      session.append('turn/start', { turn })
      session.append('step/start', { turn, step })
      const event = session.append('assistant/message', {
        turn,
        step,
        message: assistantMessage,
        ...(input.usage == null ? {} : { usage: input.usage as unknown as TokenUsage }),
      }, { surfaceOp: 'append' })
      session.append('step/end', { turn, step })
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
      const flushed = await flush(ctx, session)
      return { sessionId, turn, step, seq: event.seq, messageId: assistantMessage.id, flushed }
    }

    case 'user': {
      const content = (input.content ?? '').trim()
      if (content === '') throw new Error('user message content cannot be empty')
      const userMessage = createUserMessage({
        content: [{ type: 'text', text: content }],
        source: { kind: 'plugin', plugin: 'context-console' },
      })
      const event = session.append('user/message', userMessage, { surfaceOp: 'append' })
      const flushed = await flush(ctx, session)
      return { sessionId, turn: 0, step: 0, seq: event.seq, messageId: (userMessage as any).id ?? '', flushed }
    }

    case 'tool-call':
    case 'tool-result': {
      if (state.open) {
        throw new Error('session has an open turn; wait until the current turn ends before injecting a synthetic tool event')
      }
      const callId = input.callId?.trim() || `sim-${randomUUID()}`
      session.append('turn/start', { turn })
      session.append('step/start', { turn, step })
      let event: any
      if (type === 'tool-call') {
        const name = (input.toolName ?? '').trim()
        if (name === '') throw new Error('tool-call requires toolName')
        event = session.append('tool/call', {
          turn,
          step,
          callId,
          name,
          arguments: input.toolArguments ?? '{}',
        })
      } else {
        const text = (input.toolResultText ?? '').trim()
        if (text === '') throw new Error('tool-result requires toolResultText')
        const message = {
          id: randomUUID(),
          role: 'tool',
          content: [{
            type: 'tool-result',
            content: [{ type: 'text', text }],
            ...(input.isError === undefined ? {} : { isError: input.isError }),
          }],
          source: { callId },
        }
        event = session.append('tool/result', {
          turn,
          step,
          message,
        }, { surfaceOp: 'append' })
      }
      session.append('step/end', { turn, step })
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
      const flushed = await flush(ctx, session)
      return { sessionId, turn, step, seq: event.seq, messageId: callId, flushed }
    }

    case 'raw': {
      if (state.open) {
        throw new Error('session has an open turn; wait until the current turn ends before injecting a raw event')
      }
      if (input.raw === undefined || input.raw === null) throw new Error('raw event payload is required')
      const raw = input.raw as Record<string, any>
      const eventType = String(raw.type ?? '')
      if (eventType === '') throw new Error('raw event must include a type')
      const data = raw.data ?? {}
      const surfaceOp = raw.surfaceOp
      const event = surfaceOp === undefined
        ? session.append(eventType, data)
        : session.append(eventType, data, { surfaceOp })
      const flushed = await flush(ctx, session)
      return { sessionId, turn: 0, step: 0, seq: event.seq, messageId: '', flushed }
    }

    default:
      throw new Error(`unsupported simulated message type "${type}"`)
  }
}

export async function editMessage(
  ctx: CtxLike,
  sessionId: string,
  seq: number,
  patch: MessageEditPatch,
): Promise<MessageEditResult> {
  const session = ctx.sessions.get(sessionId)
  if (session === undefined) {
    throw new Error(`session "${sessionId}" is not live in this process`)
  }
  const original = session.events[seq]
  if (original === undefined) throw new Error(`session event #${seq} does not exist`)
  const type = String(original.type ?? '')
  const data = (original.data ?? {}) as Record<string, any>
  const surfaceOp = original.surfaceOp
  if (surfaceOp === undefined) throw new Error(`event #${seq} is not a surface append/replace event`)

  let open = false
  for (const event of session.events ?? []) {
    if (event.type === 'turn/start') open = true
    else if (event.type === 'turn/end') open = false
  }
  if (open) throw new Error('session has an open turn; wait until the current turn ends before editing a message')

  let event: any
  if (type === 'assistant/message') {
    const text = (patch.text ?? '').trim()
    const reasoning = (patch.reasoning ?? '').trim()
    if (text === '' && reasoning === '') throw new Error('edited assistant message must have text or reasoning')
    const blocks: ContentBlock[] = []
    if (reasoning !== '') blocks.push({ type: 'reasoning', text: reasoning })
    blocks.push({ type: 'text', text: text === '' ? '(empty visible content)' : text })
    const message = createAssistantMessage({
      content: blocks,
      source: {
        provider: (patch.provider ?? 'context-console').trim() || 'context-console',
        model: (patch.model ?? 'simulated').trim() || 'simulated',
      },
    })
    event = session.append('assistant/message', {
      turn: Number(data.turn),
      step: Number(data.step),
      message,
      ...(patch.usage == null ? {} : { usage: patch.usage as unknown as TokenUsage }),
    }, {
      surfaceOp: { op: 'replace', start: seq, end: seq },
      sourceEventSeqs: [seq],
    })
  } else if (type === 'user/message') {
    const text = (patch.text ?? '').trim()
    if (text === '') throw new Error('edited user message must have text')
    const originalMessage = data as any
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: originalMessage.source ?? { kind: 'plugin', plugin: 'context-console' },
    })
    event = session.append('user/message', message, {
      surfaceOp: { op: 'replace', start: seq, end: seq },
      sourceEventSeqs: [seq],
    })
  } else if (type === 'tool/result') {
    const text = (patch.toolResultText ?? '').trim()
    const originalMessage = data.message as any
    const originalBlock = Array.isArray(originalMessage?.content) ? originalMessage.content[0] : undefined
    const message = freezeMessage({
      ...originalMessage,
      content: [{
        ...originalBlock,
        content: [{ type: 'text', text }],
      }] as typeof originalMessage.content,
    })
    event = session.append('tool/result', {
      turn: Number(data.turn),
      step: Number(data.step),
      message,
      ...(data.error === undefined ? {} : { error: data.error }),
    }, {
      surfaceOp: { op: 'replace', start: seq, end: seq },
      sourceEventSeqs: [seq],
    })
  } else {
    throw new Error(`event #${seq} (${type}) is not editable`)
  }

  const flushed = await flush(ctx, session)
  return {
    sessionId,
    replacedSeq: seq,
    newSeq: event.seq,
    type,
    flushed,
  }
}
