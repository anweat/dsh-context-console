/** InventoryPage: two-column drag management for prompt/skill/mcp/tools. */
import { useCallback, useEffect, useState } from 'react'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { Category, InventoryItem, InventorySnapshot } from '../shared-types.ts'
import { rpcCall } from './ConsoleView.tsx'
import css from './styles.module.css'

type Translate = PropsLocale<'contextConsole'>['t']

const CATEGORIES: Category[] = ['prompt', 'skill', 'mcp', 'tools']
const CATEGORY_LABEL: Record<Category, string> = {
  prompt: '📝 Prompt',
  skill: '🧩 Skill',
  mcp: '🔌 MCP',
  tools: '🛠 Tools',
}

interface DragData {
  category: Category
  id: string
}

export function InventoryPage({ sessionId, rpc, t }: { sessionId: string; rpc: ClientConnectionRpc; t: Translate }) {
  const [snapshot, setSnapshot] = useState<InventorySnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [drag, setDrag] = useState<DragData | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      setSnapshot(await rpcCall<InventorySnapshot>(rpc, 'inventory/list', { sessionId }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [rpc, sessionId])

  useEffect(() => { void load() }, [load])

  const act = async (category: Category, id: string, action: 'activate' | 'deactivate') => {
    try {
      setSnapshot(await rpcCall<InventorySnapshot>(rpc, `inventory/${action}`, { category, id, sessionId }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const setInsertion = async (id: string, insertion: 'tail' | 'system-prefix') => {
    try {
      setSnapshot(await rpcCall<InventorySnapshot>(rpc, 'inventory/setInsertion', { id, insertion, sessionId }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const onDrop = (target: 'active' | 'available') => (event: React.DragEvent) => {
    event.preventDefault()
    if (drag === null) return
    const action = target === 'active' ? 'activate' : 'deactivate'
    void act(drag.category, drag.id, action)
    setDrag(null)
  }

  return (
    <div className={css.section}>
      <div className={css.toolbar}>
        <h3>{t('inventory.title')}</h3>
        <button type="button" onClick={() => { void load() }}>{t('trajectory.refresh')}</button>
      </div>
      <p className={css.muted}>{t('inventory.dragHint')}</p>
      {error !== null && <div className={css.error}>{error}</div>}
      {snapshot === null && <p className={css.muted}>Loading…</p>}
      {snapshot !== null && CATEGORIES.map(category => {
        const data = snapshot.categories[category]
        return (
          <div key={category} className={css.categoryBlock}>
            <h4>{CATEGORY_LABEL[category]}</h4>
            <div className={css.columns}>
              <div
                className={css.column}
                onDragOver={event => event.preventDefault()}
                onDrop={onDrop('available')}
              >
                <div className={css.columnHead}>{t('inventory.available')}</div>
                {data.available.length === 0 && <p className={css.muted}>{t('inventory.none')}</p>}
                {data.available.map(item => (
                  <InventoryCard
                    key={item.id}
                    item={item}
                    t={t}
                    onDragStart={() => setDrag({ category, id: item.id })}
                    onAction={() => void act(category, item.id, 'activate')}
                    actionLabel={t('inventory.activate')}
                  />
                ))}
              </div>
              <div
                className={css.column}
                onDragOver={event => event.preventDefault()}
                onDrop={onDrop('active')}
              >
                <div className={css.columnHead}>{t('inventory.active')}</div>
                {data.active.length === 0 && <p className={css.muted}>{t('inventory.none')}</p>}
                {data.active.map(item => (
                  <InventoryCard
                    key={item.id}
                    item={item}
                    t={t}
                    onDragStart={() => setDrag({ category, id: item.id })}
                    onAction={() => void act(category, item.id, 'deactivate')}
                    actionLabel={t('inventory.deactivate')}
                    onToggleInsertion={category === 'prompt' && item.id.startsWith('custom:prompt:')
                      ? (mode) => void setInsertion(item.id, mode)
                      : undefined}
                  />
                ))}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function InventoryCard({
  item, t, onDragStart, onAction, actionLabel, onToggleInsertion,
}: {
  item: InventoryItem
  t: Translate
  onDragStart: () => void
  onAction: () => void
  actionLabel: string
  onToggleInsertion?: (mode: 'tail' | 'system-prefix') => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <div
      className={css.inventoryCard}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move'
        onDragStart()
      }}
    >
      <div
        className={css.inventoryCardHead}
        role="button"
        tabIndex={0}
        onClick={() => setOpen(value => !value)}
        onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') setOpen(value => !value) }}
      >
        <span className={css.caret}>{open ? '▾' : '▸'}</span>
        <strong>{item.name}</strong>
        <span className={css.chip}>{item.source}</span>
      </div>
      {open && (
        <div className={css.inventoryCardBody}>
          <p className={css.inventoryDesc}>{item.description}</p>
          {item.cacheImpact === 'prefix-destructive' && (
            <p className={css.warnText}>{t('inventory.prefixDestructive')}</p>
          )}
          <div className={css.row}>
            <button type="button" className={css.primary} onClick={onAction}>{actionLabel}</button>
            {onToggleInsertion !== undefined && (
              <>
                <button type="button" className={item.insertion === 'tail' ? css.active : ''} onClick={() => onToggleInsertion('tail')}>
                  {t('inventory.insertTail')}
                </button>
                <button type="button" className={item.insertion === 'system-prefix' ? css.active : ''} onClick={() => onToggleInsertion('system-prefix')}>
                  {t('inventory.insertPrefix')}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
