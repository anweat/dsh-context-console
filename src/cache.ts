/**
 * Cache-health monitor.
 *
 * Watches `request/header` and `assistant/message` session events:
 * - a `request/header` with `reason: 'change'` means the request prefix changed
 *   and the provider's prefix cache may be invalidated;
 * - an assistant message whose usage reports `cacheReadTokens === 0` after the
 *   first request is treated as a cache miss warning.
 */
import type { Storage } from './storage.ts'
import type { CacheOverview } from './shared-types.ts'

interface SessionCacheState {
  requestCount: number
  missCount: number
  lastCacheRead?: number
  lastCacheWrite?: number
  lastHeaderReason?: string
  lastHeaderChangeAt?: number
  lastMissAt?: number
  lastHeaderFingerprint?: string
}

function fingerprint(header: Record<string, any>): string {
  const system = typeof header.system === 'string' ? header.system : ''
  const tools = Array.isArray(header.tools) ? header.tools : []
  const config = header.config ?? {}
  return JSON.stringify({ system, tools, config })
}

function diffHeader(prev: Record<string, any> | undefined, next: Record<string, any>): string[] {
  const changes: string[] = []
  if (prev === undefined) return ['initial']
  if ((prev.system ?? '') !== (next.system ?? '')) changes.push('system')
  if (JSON.stringify(prev.tools ?? []) !== JSON.stringify(next.tools ?? [])) changes.push('tools')
  if (JSON.stringify(prev.config ?? {}) !== JSON.stringify(next.config ?? {})) changes.push('config')
  return changes
}

export class CacheMonitor {
  private readonly states = new Map<string, SessionCacheState>()
  private readonly headers = new Map<string, Record<string, any> | undefined>()

  constructor(private readonly storage: Storage) {}

  onSessionEvent(sessionId: string, event: Record<string, any>): void {
    const state = this.states.get(sessionId) ?? {
      requestCount: 0,
      missCount: 0,
    }
    const type = String(event.type ?? '')
    const data = (event.data ?? {}) as Record<string, any>

    if (type === 'request/header') {
      const header = (data.header ?? {}) as Record<string, any>
      const reason = String(data.reason ?? 'initial')
      const prev = this.headers.get(sessionId)
      const fp = fingerprint(header)
      if (prev !== undefined && fp !== state.lastHeaderFingerprint) {
        const changes = diffHeader(prev, header)
        state.lastHeaderReason = 'change'
        state.lastHeaderChangeAt = Number(event.time ?? Date.now())
        this.storage.addCacheEvent(sessionId, 'invalidation', Number(event.seq), { changes, reason })
      } else {
        state.lastHeaderReason = reason
      }
      state.lastHeaderFingerprint = fp
      this.headers.set(sessionId, header)
    }

    if (type === 'assistant/message') {
      state.requestCount += 1
      const usage = (data.usage ?? {}) as Record<string, any>
      const cacheRead = typeof usage.cacheReadTokens === 'number' ? Number(usage.cacheReadTokens) : undefined
      const cacheWrite = typeof usage.cacheWriteTokens === 'number' ? Number(usage.cacheWriteTokens) : undefined
      const input = typeof usage.inputTokens === 'number' ? Number(usage.inputTokens) : undefined
      if (cacheRead !== undefined) state.lastCacheRead = cacheRead
      if (cacheWrite !== undefined) state.lastCacheWrite = cacheWrite
      if (input !== undefined && input > 0 && cacheRead === 0 && state.requestCount > 1) {
        state.missCount += 1
        state.lastMissAt = Number(event.time ?? Date.now())
        this.storage.addCacheEvent(sessionId, 'miss', Number(event.seq), {
          inputTokens: input,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
          headerReason: state.lastHeaderReason,
          headerChangedAt: state.lastHeaderChangeAt,
        })
      }
    }

    this.states.set(sessionId, state)
  }

  overview(sessionId: string): CacheOverview {
    const state = this.states.get(sessionId) ?? { requestCount: 0, missCount: 0 }
    return {
      sessionId,
      requestCount: state.requestCount,
      missCount: state.missCount,
      lastCacheRead: state.lastCacheRead,
      lastCacheWrite: state.lastCacheWrite,
      lastHeaderReason: state.lastHeaderReason,
      lastHeaderChangeAt: state.lastHeaderChangeAt,
      lastMissAt: state.lastMissAt,
    }
  }
}
