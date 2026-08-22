/** HistoryStream: SQLite-backed audit and cache event stream. */
import { useCallback, useEffect, useState } from 'react'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { HistoryEntry } from '../shared-types.ts'
import { rpcCall } from './ConsoleView.tsx'
import css from './styles.module.css'

type Translate = PropsLocale<'contextConsole'>['t']

export function HistoryStream({ rpc, t }: { rpc: ClientConnectionRpc; t: Translate }) {
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      setEntries(await rpcCall<HistoryEntry[]>(rpc, 'history/list', { limit: 200 }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [rpc])

  useEffect(() => { void load() }, [load])

  const clear = async () => {
    try {
      await rpcCall<{ ok: boolean }>(rpc, 'history/clear', {})
      setEntries([])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className={css.section}>
      <div className={css.toolbar}>
        <h3>{t('history.title')}</h3>
        <button type="button" onClick={() => { void load() }}>{t('trajectory.refresh')}</button>
        <button type="button" className={css.danger} onClick={() => { void clear() }}>{t('history.clear')}</button>
      </div>
      {error !== null && <div className={css.error}>{error}</div>}
      {entries.length === 0
        ? <p className={css.muted}>{t('history.empty')}</p>
        : (
            <ul className={css.historyList}>
              {entries.map(entry => (
                <li key={entry.id} className={css.historyItem}>
                  <span className={css.meta}>{new Date(entry.ts).toLocaleString()}</span>
                  <span className={css.chip}>{entry.kind}</span>
                  {entry.category !== undefined && <span className={css.chip}>{entry.category}</span>}
                  {entry.action !== undefined && <span className={css.chip}>{entry.action}</span>}
                  {entry.sessionId !== undefined && <span className={css.meta}>{entry.sessionId}</span>}
                  {entry.payload !== undefined && (
                    <pre className={css.pre}>{JSON.stringify(entry.payload, null, 2)}</pre>
                  )}
                </li>
              ))}
            </ul>
          )}
    </div>
  )
}
