/** ConsoleView: tab shell that switches between trajectory, inventory and history. */
import { useState } from 'react'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { CONTEXT_CONSOLE_RPC_CHANNEL } from '../shared-types.ts'
import { TrajectoryWall } from './TrajectoryWall.tsx'
import { InventoryPage } from './InventoryPage.tsx'
import { HistoryStream } from './HistoryStream.tsx'
import { SimDialog } from './SimDialog.tsx'
import css from './styles.module.css'

export interface ConsoleViewInjected {
  readonly rpc: ClientConnectionRpc
}

type ConsoleViewProps = ConvViewProps & InjectFace<ConsoleViewInjected> & PropsLocale<'contextConsole'>

export async function rpcCall<T>(rpc: ClientConnectionRpc, endpoint: string, payload: unknown): Promise<T> {
  const result = await rpc.call(CONTEXT_CONSOLE_RPC_CHANNEL, endpoint, payload)
  if (!result.ok) throw new Error(result.error.message)
  return result.value as T
}

type View = 'trajectory' | 'inventory' | 'history'

export function ConsoleView({ sessionId, rpc, t }: ConsoleViewProps) {
  const [view, setView] = useState<View>('trajectory')
  const [simOpen, setSimOpen] = useState(false)

  return (
    <div className={css.panel}>
      <div className={css.toolbar}>
        <button type="button" className={view === 'trajectory' ? css.active : ''} onClick={() => setView('trajectory')}>
          {t('nav.trajectory')}
        </button>
        <button type="button" className={view === 'inventory' ? css.active : ''} onClick={() => setView('inventory')}>
          {t('nav.inventory')}
        </button>
        <button type="button" className={view === 'history' ? css.active : ''} onClick={() => setView('history')}>
          {t('nav.history')}
        </button>
        <span className={css.spacer} />
        <button type="button" className={css.primary} onClick={() => setSimOpen(true)}>
          {t('sim.title')}
        </button>
      </div>

      {simOpen && (
        <SimDialog
          sessionId={sessionId}
          rpc={rpc}
          t={t}
          onClose={() => setSimOpen(false)}
        />
      )}

      {view === 'trajectory' && <TrajectoryWall sessionId={sessionId} rpc={rpc} t={t} />}
      {view === 'inventory' && <InventoryPage sessionId={sessionId} rpc={rpc} t={t} />}
      {view === 'history' && <HistoryStream rpc={rpc} t={t} />}
    </div>
  )
}
