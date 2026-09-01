/**
 * dsh-context-console — Client half.
 *
 * Registers a `conversation.view` tab named "上下文控制台". The tab owns:
 *   - trajectory wall (brick-style full message/event history)
 *   - inventory management (prompt/skill/mcp/tools drag activation)
 *   - simulated-message injection
 *   - history stream
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { ConsoleView, type ConsoleViewInjected } from './ConsoleView.tsx'
import { en, zh } from './locales.ts'
import { ForgeView, type ForgeViewInjected } from './forge/ForgeView.tsx'
import { en as forgeEn, zh as forgeZh } from './forge/locales.ts'

export const name = 'dsh-context-console-client'

export const inject = ['slots', 'locale', 'connection']

export const LOCALE_NS = 'contextConsole'
export const FORGE_LOCALE_NS = 'assistantMessageForge'

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'dsh-context-console: dictionaries')
  ctx.effect(
    () => ctx.locale.register(FORGE_LOCALE_NS, { zh: forgeZh, en: forgeEn }),
    'dsh-context-console: message-forge dictionaries',
  )

  const t = ctx.locale.bind(LOCALE_NS)

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'dsh-context-console',
    order: 30,
    locale: LOCALE_NS,
    label: () => t('tab.title'),
    inject: (_sessionId: SessionId): ConsoleViewInjected => {
      const connection = ctx.get('connection') as ConnectionHandle | undefined
      if (connection === undefined) {
        throw new Error('dsh-context-console: browser connection service is unavailable')
      }
      return { rpc: connection.rpc }
    },
  }, ConsoleView))

  const forgeT = ctx.locale.bind(FORGE_LOCALE_NS)
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'assistant-message-forge',
    order: 20,
    locale: FORGE_LOCALE_NS,
    label: () => forgeT('tab.title'),
    inject: (_sessionId: SessionId): ForgeViewInjected => {
      const connection = ctx.get('connection') as ConnectionHandle | undefined
      if (connection === undefined) {
        throw new Error('dsh-context-console: browser connection service is unavailable')
      }
      return { rpc: connection.rpc }
    },
  }, ForgeView))
}
