/**
 * dsh-assistant-message-forge — Host half.
 *
 * The Host owns the durable draft list, the recorded session-context snapshots,
 * and every session mutation:
 *   - `/dsh-assistant-message-forge` generic Connection RPC channel
 *     (loopback authority) with drafts.* / session.inject / sessionlog.parse /
 *     context.* / records.* endpoints;
 *   - context/refresh parses the live session in detail and card-ifies every
 *     turn/step boundary, message, tool call/result, request header and
 *     log-only event into a recorded snapshot;
 *   - records/update edits one card's override in the recording;
 *   - context/apply writes an edited surface card back into the session with a
 *     surface `replace` operation (original is shadowed for model context);
 *   - injection appends one complete synthetic turn (turn/start, step/start,
 *     assistant/message, step/end, turn/end) to the selected live session;
 *   - sessionlog.parse decodes session.jsonl or session.jsonl.zstd uploads and
 *     recognizes the surface events for reuse as drafts or direct injection.
 */
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, TokenUsage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { ContextRecordStore } from './context.ts'
import { DraftStore } from './store.ts'
import { parseSessionLogBytes, repairSessionLogBytes } from './sessionlog.ts'
import {
  AMF_RPC_CHANNEL,
  type AssistantDraftInput, type ContextCardPatch, type ForgeUsage,
  type InjectMessageInput, type InjectResponse, type SessionLogRepairCreateResponse,
} from './shared-types.ts'

export const name = 'dsh-assistant-message-forge'

/** Services required: the generic RPC transport and the live-session store. */
export const inject = ['connection', 'sessions']

const MAX_IMPORT_BASE64_CHARS = 192 * 1024 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`)
  return value
}

function readOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`${field} must be a string`)
  return value
}

function readUsage(value: unknown): TokenUsage | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) throw new Error('usage must be an object')
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
  const numeric = (field: keyof ForgeUsage): number | undefined => {
    const raw = value[field]
    if (raw === undefined) return undefined
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
      throw new Error(`usage.${field} must be a non-negative finite number`)
    }
    return raw
  }
  const inputTokens = numeric('inputTokens')
  const outputTokens = numeric('outputTokens')
  if (inputTokens !== undefined) usage.inputTokens = inputTokens
  if (outputTokens !== undefined) usage.outputTokens = outputTokens
  const cacheReadTokens = numeric('cacheReadTokens')
  const cacheWriteTokens = numeric('cacheWriteTokens')
  const reasoningTokens = numeric('reasoningTokens')
  if (cacheReadTokens !== undefined) usage.cacheReadTokens = cacheReadTokens
  if (cacheWriteTokens !== undefined) usage.cacheWriteTokens = cacheWriteTokens
  if (reasoningTokens !== undefined) usage.reasoningTokens = reasoningTokens
  return usage
}

/** Current execution enclosure, derived from the append-only log. */
function executionState(session: Session): { open: boolean; nextTurn: number } {
  let openTurn: number | null = null
  let openStep: number | null = null
  let maxTurn = 0
  for (const event of session.events) {
    switch (event.type) {
      case 'turn/start':
        openTurn = event.data.turn
        openStep = null
        maxTurn = Math.max(maxTurn, event.data.turn)
        break
      case 'step/start':
        if (openTurn === event.data.turn) openStep = event.data.step
        break
      case 'step/end':
        if (openTurn === event.data.turn && openStep === event.data.step) openStep = null
        break
      case 'turn/end':
        if (openTurn === event.data.turn) {
          openTurn = null
          openStep = null
        }
        break
      default:
        break
    }
  }
  return { open: openTurn !== null || openStep !== null, nextTurn: maxTurn + 1 }
}

function draftInput(payload: unknown): AssistantDraftInput {
  if (!isRecord(payload) || !isRecord(payload.draft)) throw new Error('payload.draft must be an object')
  const draft = payload.draft
  const input: AssistantDraftInput = {}
  if (draft.id !== undefined) input.id = readString(draft.id, 'draft.id')
  input.title = readOptionalString(draft.title, 'draft.title')
  input.content = readOptionalString(draft.content, 'draft.content')
  input.reasoning = readOptionalString(draft.reasoning, 'draft.reasoning')
  input.provider = readOptionalString(draft.provider, 'draft.provider')
  input.model = readOptionalString(draft.model, 'draft.model')
  return input
}

function sessionIdOf(payload: unknown): string {
  if (!isRecord(payload)) throw new Error('payload must be an object')
  return readString(payload.sessionId, 'sessionId')
}

function cardPatchInput(payload: unknown): { sessionId: string; key: string; patch: ContextCardPatch } {
  if (!isRecord(payload)) throw new Error('payload must be an object')
  const sessionId = readString(payload.sessionId, 'sessionId')
  const key = readString(payload.key, 'key')
  if (!isRecord(payload.patch)) throw new Error('payload.patch must be an object')
  const patchValue = payload.patch
  const patch: ContextCardPatch = {}
  if (patchValue.text !== undefined) patch.text = readString(patchValue.text, 'patch.text')
  if (patchValue.reasoning !== undefined) patch.reasoning = readString(patchValue.reasoning, 'patch.reasoning')
  if (patchValue.provider !== undefined) patch.provider = readString(patchValue.provider, 'patch.provider')
  if (patchValue.model !== undefined) patch.model = readString(patchValue.model, 'patch.model')
  if (patchValue.toolName !== undefined) patch.toolName = readString(patchValue.toolName, 'patch.toolName')
  if (patchValue.toolArguments !== undefined) patch.toolArguments = readString(patchValue.toolArguments, 'patch.toolArguments')
  if (patchValue.toolResultText !== undefined) patch.toolResultText = readString(patchValue.toolResultText, 'patch.toolResultText')
  if (patchValue.isError !== undefined) {
    if (typeof patchValue.isError !== 'boolean') throw new Error('patch.isError must be a boolean')
    patch.isError = patchValue.isError
  }
  if (patchValue.usage !== undefined) {
    patch.usage = patchValue.usage === null ? null : readUsage(patchValue.usage) as ForgeUsage
  }
  return { sessionId, key, patch }
}

function cardKeyInput(payload: unknown): { sessionId: string; key: string } {
  if (!isRecord(payload)) throw new Error('payload must be an object')
  return {
    sessionId: readString(payload.sessionId, 'sessionId'),
    key: readString(payload.key, 'key'),
  }
}

function injectInput(payload: unknown): { sessionId: string; message: InjectMessageInput } {
  if (!isRecord(payload)) throw new Error('payload must be an object')
  const sessionId = readString(payload.sessionId, 'sessionId')
  if (!isRecord(payload.message)) throw new Error('payload.message must be an object')
  const message = payload.message
  return {
    sessionId,
    message: {
      content: readString(message.content, 'message.content'),
      reasoning: readOptionalString(message.reasoning, 'message.reasoning'),
      provider: readOptionalString(message.provider, 'message.provider'),
      model: readOptionalString(message.model, 'message.model'),
      usage: readUsage(message.usage),
    },
  }
}

/** Append one complete synthetic assistant turn to a live session. */
async function injectMessage(ctx: Context, payload: unknown): Promise<InjectResponse> {
  const { sessionId, message } = injectInput(payload)
  const content = message.content.trim()
  const reasoning = (message.reasoning ?? '').trim()
  if (content === '' && reasoning === '') {
    throw new Error('message must have visible content or reasoning text')
  }
  const session = ctx.sessions.get(sessionId as SessionId)
  if (session === undefined) {
    throw new Error(`session "${sessionId}" is not live in this process`)
  }
  const state = executionState(session)
  if (state.open) {
    throw new Error('session has an open turn; wait until the current turn ends before injecting a synthetic turn')
  }

  const blocks: ContentBlock[] = []
  if (reasoning !== '') blocks.push({ type: 'reasoning', text: reasoning })
  blocks.push({ type: 'text', text: content === '' ? '(empty visible content)' : content })
  const assistantMessage = createAssistantMessage({
    content: blocks,
    source: {
      provider: (message.provider ?? 'assistant-message-forge').trim() || 'assistant-message-forge',
      model: (message.model ?? 'test').trim() || 'test',
    },
  })

  const turn = state.nextTurn
  const step = 1
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step })
  const event = session.append('assistant/message', {
    turn,
    step,
    message: assistantMessage,
    ...(message.usage === undefined || message.usage === null ? {} : { usage: message.usage }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })

  let flushed = false
  try {
    flushed = await ctx.sessions.flush(session)
  } catch (error) {
    ctx.logger?.warn(`[dsh-assistant-message-forge] flush after inject failed: ${String(error)}`)
  }

  return {
    sessionId,
    turn,
    step,
    seq: event.seq,
    messageId: assistantMessage.id,
    flushed,
  }
}

function parseImportPayload(payload: unknown): { name: string; bytes: Buffer } {
  if (!isRecord(payload)) throw new Error('payload must be an object')
  const name = readString(payload.name, 'name')
  const base64 = readString(payload.dataBase64, 'dataBase64')
  if (base64.length > MAX_IMPORT_BASE64_CHARS) {
    throw new Error('session log upload exceeds the 128 MiB import limit')
  }
  return { name, bytes: Buffer.from(base64, 'base64') }
}

/** Create a new validated session from a repaired imported log; never overwrite the source artifact. */
async function createRepairedSession(ctx: Context, payload: unknown): Promise<SessionLogRepairCreateResponse> {
  const { name, bytes } = parseImportPayload(payload)
  const repaired = repairSessionLogBytes(name, bytes)
  if (!repaired.report.repairable) {
    throw new Error(`session log is not safely repairable: ${repaired.report.validationError ?? 'unknown validation error'}`)
  }
  const header = repaired.report.header
  if (header === null) throw new Error('session log header is missing')

  const sourceId = typeof header.id === 'string' && header.id.trim() !== ''
    ? SessionId(header.id)
    : undefined
  const sessionId = SessionId(`session-repaired-${randomUUID()}`)
  const session = ctx.sessions.create(sessionId, {
    seed: repaired.events,
    meta: {
      ...(typeof header.cwd === 'string' ? { cwd: header.cwd } : {}),
      ...(sourceId === undefined ? {} : { parentSession: sourceId }),
      seedLength: repaired.events.length,
      ...(typeof header.agentPreset === 'string' ? { agentPreset: header.agentPreset } : {}),
    },
  })
  const flushed = await ctx.sessions.flush(session)
  return { sessionId, flushed, report: repaired.report }
}

async function dispatch(
  ctx: Context,
  store: DraftStore,
  records: ContextRecordStore,
  endpoint: string,
  payload: unknown,
): Promise<unknown> {
  switch (endpoint) {
    case 'drafts/list':
      return store.list()
    case 'drafts/save':
      return store.save(draftInput(payload))
    case 'drafts/delete': {
      if (!isRecord(payload)) throw new Error('payload must be an object')
      return store.delete(readString(payload.id, 'id'))
    }
    case 'session/inject':
      return injectMessage(ctx, payload)
    case 'sessionlog/parse': {
      const { name, bytes } = parseImportPayload(payload)
      return {
        ...parseSessionLogBytes(name, bytes),
        repair: repairSessionLogBytes(name, bytes).report,
      }
    }
    case 'sessionlog/repair-preview': {
      const { name, bytes } = parseImportPayload(payload)
      return repairSessionLogBytes(name, bytes).report
    }
    case 'sessionlog/repair-create':
      return createRepairedSession(ctx, payload)
    case 'context/load':
      return records.load(sessionIdOf(payload))
    case 'context/refresh': {
      const sessionId = sessionIdOf(payload)
      const session = ctx.sessions.get(sessionId as SessionId)
      if (session === undefined) throw new Error(`session "${sessionId}" is not live in this process`)
      return records.record(session)
    }
    case 'records/update': {
      const { sessionId, key, patch } = cardPatchInput(payload)
      return records.updateCard(sessionId, key, patch)
    }
    case 'records/reset':
      return records.resetOverrides(sessionIdOf(payload))
    case 'context/apply': {
      const { sessionId, key } = cardKeyInput(payload)
      return records.apply(ctx, sessionId, key)
    }
    default:
      throw new Error(`unknown endpoint "${endpoint}"`)
  }
}

/**
 * Mount the Host plugin: open the durable draft store and register the
 * loopback RPC channel whose endpoints the Client half calls.
 */
export function apply(ctx: Context): void {
  const dataRoot = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'assistant-message-forge')
  const store = new DraftStore(dataRoot)
  const records = new ContextRecordStore(dataRoot)

  const handler: ConnectionRpcHandler = async (endpoint, payload) => {
    try {
      const value = await dispatch(ctx, store, records, endpoint, payload)
      return { ok: true, value }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      try {
        ctx.logger?.warn(`[dsh-assistant-message-forge] ${endpoint}: ${message}`)
      } catch {
        // Logging must never mask the RPC error result.
      }
      return { ok: false, error: { code: 'internal', message, details: {} } }
    }
  }

  const dispose = ctx.connection.rpc.handle(AMF_RPC_CHANNEL, handler, { authority: 'loopback' })
  ctx.effect(() => () => { void dispose() }, 'dsh-assistant-message-forge: rpc channel')

  try {
    const log = ctx.logger?.info?.bind(ctx.logger)
    if (typeof log === 'function') log(`[dsh-assistant-message-forge] loaded (${AMF_RPC_CHANNEL})`)
    else console.log(`[dsh-assistant-message-forge] loaded (${AMF_RPC_CHANNEL})`)
  } catch {
    console.log(`[dsh-assistant-message-forge] loaded (${AMF_RPC_CHANNEL})`)
  }
}
