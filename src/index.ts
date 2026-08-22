/**
 * dsh-context-console — Host half.
 *
 * Owns the context-console RPC channel:
 *   /dsh-context-console
 *
 * Endpoints cover:
 *   - trajectory wall (live session event projection)
 *   - inventory management (prompt/skill/mcp/tools activate/deactivate/move)
 *   - simulated message injection
 *   - cache health overview
 *   - history stream (SQLite)
 */
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
// Type-only import to merge the dsh-session event vocabulary onto Context.
import type {} from '@deepseek-ai/dsh-session'
import { Storage } from './storage.ts'
import { Manager } from './manager.ts'
import { CacheMonitor } from './cache.ts'
import { buildTrajectory } from './trajectory.ts'
import { editMessage, injectSimulatedMessage } from './simulator.ts'
import { apply as applyMessageForge } from './forge/index.ts'
import {
  CONTEXT_CONSOLE_RPC_CHANNEL,
  type Category,
  type InsertionMode,
  type SimMessageInput,
} from './shared-types.ts'

export const name = 'dsh-context-console'
export const inject = ['connection', 'sessions', 'systemPrompt', 'skills', 'tools', 'loader']

type AppContext = Context & {
  connection: {
    rpc: {
      handle(channel: string, handler: ConnectionRpcHandler, options?: { authority?: string }): () => void
    }
  }
  sessions: {
    get(id: string): any
    flush(session: any): Promise<boolean>
  }
  systemPrompt: any
  skills: any
  tools: any
  loader: any
}

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

function readNumber(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${field} must be a number`)
  return value
}

function parseEditInput(payload: unknown): { sessionId: string; seq: number; patch: Record<string, any> } {
  if (!isRecord(payload)) throw new Error('payload must be an object')
  const sessionId = readString(payload.sessionId, 'sessionId')
  const seq = readNumber(payload.seq, 'seq', Number.NaN)
  if (!Number.isInteger(seq) || seq < 0) throw new Error('seq must be a non-negative integer')
  if (!isRecord(payload.patch)) throw new Error('payload.patch must be an object')
  return { sessionId, seq, patch: payload.patch }
}

function parseSimInput(payload: unknown): { sessionId: string; message: SimMessageInput } {
  if (!isRecord(payload)) throw new Error('payload must be an object')
  const sessionId = readString(payload.sessionId, 'sessionId')
  if (!isRecord(payload.message)) throw new Error('payload.message must be an object')
  const message = payload.message
  return {
    sessionId,
    message: {
      type: message.type === undefined ? undefined : readString(message.type, 'message.type') as SimMessageInput['type'],
      content: readOptionalString(message.content, 'message.content'),
      reasoning: readOptionalString(message.reasoning, 'message.reasoning'),
      provider: readOptionalString(message.provider, 'message.provider'),
      model: readOptionalString(message.model, 'message.model'),
      toolName: readOptionalString(message.toolName, 'message.toolName'),
      toolArguments: readOptionalString(message.toolArguments, 'message.toolArguments'),
      toolResultText: readOptionalString(message.toolResultText, 'message.toolResultText'),
      callId: readOptionalString(message.callId, 'message.callId'),
      isError: message.isError === undefined ? undefined : typeof message.isError === 'boolean' ? message.isError : (() => { throw new Error('message.isError must be a boolean') })(),
      usage: message.usage == null ? null : message.usage as Record<string, number>,
      raw: message.raw,
    },
  }
}

export function apply(ctx: AppContext): void {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const dataDir = join(dshHome, 'context-console')
  const storage = new Storage(dataDir)
  const manager = new Manager(storage)
  const cacheMonitor = new CacheMonitor(storage)

  ctx.effect(() => {
    return () => {
      manager.dispose()
      storage.close()
    }
  }, 'dsh-context-console: storage')

  ctx.on('session/event', (session: any, event: any) => {
    try {
      cacheMonitor.onSessionEvent(String(session?.id ?? ''), event)
    } catch {
      // observer failures are contained
    }
  })

  void manager.restore(ctx as any).catch((error) => {
    ctx.logger?.warn?.(`[dsh-context-console] restore failed: ${String(error)}`)
  })

  const handler: ConnectionRpcHandler = async (endpoint, payload) => {
    try {
      const value = await dispatch(ctx, storage, manager, cacheMonitor, endpoint, payload)
      return { ok: true, value }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger?.warn?.(`[dsh-context-console] ${endpoint}: ${message}`)
      return { ok: false, error: { code: 'internal', message, details: {} } }
    }
  }

  const disposeRpc = ctx.connection.rpc.handle(CONTEXT_CONSOLE_RPC_CHANNEL, handler, { authority: 'loopback' })
  ctx.effect(() => () => { void disposeRpc() }, 'dsh-context-console: rpc channel')

  ctx.logger?.info?.('[dsh-context-console] loaded')

  // Context Console is the maintained successor to assistant-message-forge.
  // Mount its compatibility RPC surface from this package so existing drafts,
  // snapshots, and session-log recovery workflows remain available.
  applyMessageForge(ctx)
}

async function dispatch(
  ctx: AppContext,
  storage: Storage,
  manager: Manager,
  cacheMonitor: CacheMonitor,
  endpoint: string,
  payload: unknown,
): Promise<unknown> {
  switch (endpoint) {
    case 'overview': {
      const inventory = await manager.inventory(ctx as any)
      return {
        promptCount: inventory.categories.prompt.active.length,
        skillCount: inventory.categories.skill.active.length,
        mcpCount: inventory.categories.mcp.active.length,
        toolCount: inventory.categories.tools.active.length,
        cacheMissCount: 0,
        historyCount: storage.countHistory(),
      }
    }
    case 'trajectory/list': {
      if (!isRecord(payload)) throw new Error('payload must be an object')
      const sessionId = readString(payload.sessionId, 'sessionId')
      const session = ctx.sessions.get(sessionId)
      if (session === undefined) throw new Error(`session "${sessionId}" is not live in this process`)
      return buildTrajectory(session)
    }
    case 'inventory/list': {
      if (!isRecord(payload)) throw new Error('payload must be an object')
      const sessionId = payload.sessionId === undefined ? undefined : readString(payload.sessionId, 'sessionId')
      return manager.inventory(ctx as any, sessionId)
    }
    case 'inventory/activate': {
      if (!isRecord(payload)) throw new Error('payload must be an object')
      const category = readString(payload.category, 'category') as Category
      const id = readString(payload.id, 'id')
      const sessionId = payload.sessionId === undefined ? undefined : readString(payload.sessionId, 'sessionId')
      await manager.activate(ctx as any, category, id)
      return manager.inventory(ctx as any, sessionId)
    }
    case 'inventory/deactivate': {
      if (!isRecord(payload)) throw new Error('payload must be an object')
      const category = readString(payload.category, 'category') as Category
      const id = readString(payload.id, 'id')
      const sessionId = payload.sessionId === undefined ? undefined : readString(payload.sessionId, 'sessionId')
      await manager.deactivate(ctx as any, category, id)
      return manager.inventory(ctx as any, sessionId)
    }
    case 'inventory/setInsertion': {
      if (!isRecord(payload)) throw new Error('payload must be an object')
      const id = readString(payload.id, 'id')
      const insertion = readString(payload.insertion, 'insertion') as InsertionMode
      if (insertion !== 'tail' && insertion !== 'system-prefix') throw new Error('insertion must be "tail" or "system-prefix"')
      const sessionId = payload.sessionId === undefined ? undefined : readString(payload.sessionId, 'sessionId')
      await manager.setInsertion(ctx as any, id, insertion)
      return manager.inventory(ctx as any, sessionId)
    }
    case 'message/edit': {
      const { sessionId, seq, patch } = parseEditInput(payload)
      return editMessage(ctx as any, sessionId, seq, patch)
    }
    case 'sim/inject': {
      const { sessionId, message } = parseSimInput(payload)
      return injectSimulatedMessage(ctx as any, sessionId, message)
    }
    case 'cache/overview': {
      if (!isRecord(payload)) throw new Error('payload must be an object')
      const sessionId = readString(payload.sessionId, 'sessionId')
      const overview = cacheMonitor.overview(sessionId)
      const events = storage.listCacheEvents(sessionId, 50)
      return { ...overview, events }
    }
    case 'history/list': {
      if (!isRecord(payload)) throw new Error('payload must be an object')
      const limit = readNumber(payload.limit, 'limit', 200)
      const history = storage.listHistory(limit)
      const cache = storage.listCacheEvents(undefined, limit)
      return [...history, ...cache].sort((a, b) => b.ts - a.ts).slice(0, limit)
    }
    case 'history/clear':
      storage.clearHistory()
      storage.clearCacheEvents()
      return { ok: true }
    case 'state/export':
      return storage.loadManifest()
    case 'state/import': {
      if (!isRecord(payload)) throw new Error('payload must be an object')
      const state = payload.state as any
      storage.saveManifest({
        ...storage.loadManifest(),
        ...(isRecord(state) ? state : {}),
      } as any)
      return { ok: true }
    }
    default:
      throw new Error(`unknown endpoint "${endpoint}"`)
  }
}
