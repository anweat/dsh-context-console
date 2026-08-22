/** TrajectoryWall: GitHub-history style brick wall of session events. */
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { MessageEditPatch, MessageEditResult, TrajectoryCell, TrajectorySnapshot } from '../shared-types.ts'
import { rpcCall } from './ConsoleView.tsx'
import css from './styles.module.css'

type Translate = PropsLocale<'contextConsole'>['t']

type Filter = 'all' | 'user' | 'assistant' | 'tool' | 'request' | 'other'

function filterOf(cell: TrajectoryCell): Filter {
  switch (cell.kind) {
    case 'user': return 'user'
    case 'assistant':
    case 'reasoning': return 'assistant'
    case 'tool-call':
    case 'tool-result': return 'tool'
    case 'request-header':
    case 'request-context': return 'request'
    default: return 'other'
  }
}

function InlineEditor({
  cell, sessionId, rpc, t, onCancel, onSaved,
}: {
  cell: TrajectoryCell
  sessionId: string
  rpc: ClientConnectionRpc
  t: Translate
  onCancel: () => void
  onSaved: () => void
}) {
  const detail = cell.expanded
  const [text, setText] = useState(detail?.text ?? '')
  const [reasoning, setReasoning] = useState(detail?.reasoning ?? '')
  const [provider, setProvider] = useState(detail?.provider ?? '')
  const [model, setModel] = useState(detail?.model ?? '')
  const [toolResultText, setToolResultText] = useState(detail?.toolResultText ?? '')
  const [isError, setIsError] = useState(detail?.isError === true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const patch: MessageEditPatch = {}
      if (cell.kind === 'assistant' || cell.kind === 'user') {
        patch.text = text
        patch.reasoning = reasoning
        patch.provider = provider
        patch.model = model
      } else if (cell.kind === 'tool-result') {
        patch.toolResultText = toolResultText
        patch.isError = isError
      } else {
        throw new Error('this cell type is not editable')
      }
      await rpcCall<MessageEditResult>(rpc, 'message/edit', { sessionId, seq: cell.seq, patch })
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={css.inlineEditor}>
      {(cell.kind === 'assistant' || cell.kind === 'user') && (
        <>
          {cell.kind === 'assistant' && (
            <>
              <label className={css.field}>
                <span>reasoning</span>
                <textarea rows={3} value={reasoning} onChange={event => setReasoning(event.target.value)} />
              </label>
              <div className={css.row}>
                <label className={css.field}>
                  <span>provider</span>
                  <input value={provider} onChange={event => setProvider(event.target.value)} />
                </label>
                <label className={css.field}>
                  <span>model</span>
                  <input value={model} onChange={event => setModel(event.target.value)} />
                </label>
              </div>
            </>
          )}
          <label className={css.field}>
            <span>text</span>
            <textarea rows={5} value={text} onChange={event => setText(event.target.value)} />
          </label>
        </>
      )}
      {cell.kind === 'tool-result' && (
        <>
          <label className={css.field}>
            <span>result text</span>
            <textarea rows={5} value={toolResultText} onChange={event => setToolResultText(event.target.value)} />
          </label>
          <label className={css.field}>
            <input type="checkbox" checked={isError} onChange={event => setIsError(event.target.checked)} />
            <span>isError</span>
          </label>
        </>
      )}
      {error !== null && <div className={css.error}>{error}</div>}
      <div className={css.row}>
        <button type="button" className={css.primary} disabled={busy} onClick={() => { void save() }}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

function DetailRow({
  cell, t, rpc, depth, sessionId, editingSeq, setEditingSeq, onEdited,
}: {
  cell: TrajectoryCell
  t: Translate
  rpc: ClientConnectionRpc
  depth: number
  sessionId: string
  editingSeq: number | null
  setEditingSeq: (seq: number | null) => void
  onEdited: () => void
}) {
  const detail = cell.expanded
  return (
    <div className={css.detailRow}>
      <div className={css.detailHead}>
        <span style={{ background: cell.color }} className={css.detailColor} />
        <strong>#{cell.seq} {cell.type}</strong>
        {cell.turn !== undefined && <span>turn {cell.turn}{cell.step !== undefined ? `/${cell.step}` : ''}</span>}
        {cell.inSurface && <span className={css.chip}>surface</span>}
        {cell.shadowed && <span className={css.chipWarn}>shadowed</span>}
        {cell.cacheMiss && <span className={css.chipWarn}>{t('trajectory.cacheMiss')}</span>}
        {cell.inSurface && !cell.shadowed && (cell.kind === 'user' || cell.kind === 'assistant' || cell.kind === 'tool-result') && (
          <button type="button" className={css.primary} onClick={() => setEditingSeq(editingSeq === cell.seq ? null : cell.seq)}>
            {editingSeq === cell.seq ? 'Cancel Edit' : 'Edit'}
          </button>
        )}
      </div>
      {editingSeq === cell.seq && (
        <InlineEditor
          cell={cell}
          sessionId={sessionId}
          rpc={rpc}
          t={t}
          onCancel={() => setEditingSeq(null)}
          onSaved={() => { setEditingSeq(null); onEdited() }}
        />
      )}
      {detail?.reasoning !== undefined && detail.reasoning !== '' && (
        <pre className={css.pre}><strong>reasoning</strong>\n{detail.reasoning}</pre>
      )}
      {detail?.text !== undefined && detail.text !== '' && (
        <pre className={css.pre}><strong>text</strong>\n{detail.text}</pre>
      )}
      {detail?.toolName !== undefined && (
        <pre className={css.pre}><strong>tool</strong> {detail.toolName}\n{detail.toolArguments ?? ''}</pre>
      )}
      {detail?.toolResultText !== undefined && (
        <pre className={css.pre}><strong>result</strong>\n{detail.toolResultText}</pre>
      )}
      {detail?.provider !== undefined && (
        <div className={css.meta}>{detail.provider} / {detail.model ?? ''}</div>
      )}
      {detail?.usage !== undefined && (
        <div className={css.meta}>usage: {JSON.stringify(detail.usage)}</div>
      )}
      {detail?.requestHeader !== undefined && (
        <pre className={css.pre}>{JSON.stringify(detail.requestHeader, null, 2)}</pre>
      )}
      {detail?.raw !== undefined && (
        <pre className={css.pre}>{JSON.stringify(detail.raw, null, 2)}</pre>
      )}
      {cell.kind === 'subagent' && detail?.childSessionId !== undefined && depth < 2 && (
        <div className={css.nestedWall}>
          <div className={css.meta}>subagent session: {detail.childSessionId}</div>
          <TrajectoryWall sessionId={detail.childSessionId} rpc={rpc} t={t} embedded depth={depth + 1} />
        </div>
      )}
      {cell.kind === 'subagent' && detail?.childSessionId !== undefined && depth >= 2 && (
        <div className={css.meta}>subagent session: {detail.childSessionId}</div>
      )}
    </div>
  )
}

export function TrajectoryWall({
  sessionId, rpc, t, embedded = false, depth = 0,
}: {
  sessionId: string
  rpc: ClientConnectionRpc
  t: Translate
  embedded?: boolean
  depth?: number
}) {
  const [snapshot, setSnapshot] = useState<TrajectorySnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [expandedSeq, setExpandedSeq] = useState<number | null>(null)
  const [editingSeq, setEditingSeq] = useState<number | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const next = await rpcCall<TrajectorySnapshot>(rpc, 'trajectory/list', { sessionId })
      setSnapshot(next)
      setExpandedSeq(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [rpc, sessionId])

  useEffect(() => { void load() }, [load])

  const ROW_SIZE = 16

  const filtered = useMemo(() => {
    if (snapshot === null) return []
    return snapshot.cells.filter(cell => filter === 'all' || filterOf(cell) === filter)
  }, [snapshot, filter])

  const rows = useMemo(() => {
    const result: TrajectoryCell[][] = []
    for (let i = 0; i < filtered.length; i += ROW_SIZE) {
      result.push(filtered.slice(i, i + ROW_SIZE))
    }
    return result
  }, [filtered])

  const expandedCell = snapshot?.cells.find(cell => cell.seq === expandedSeq) ?? null

  const brickButton = (cell: TrajectoryCell) => (
    <button
      key={cell.seq}
      type="button"
      className={`${css.brick} ${cell.cacheMiss ? css.brickMiss : ''}`}
      style={{ background: cell.color }}
      title={`#${cell.seq} ${cell.type} — ${cell.summary}`}
      onClick={() => setExpandedSeq(expandedSeq === cell.seq ? null : cell.seq)}
    >
      <span className={css.brickIcon}>{cell.icon}</span>
    </button>
  )

  return (
    <div className={css.section}>
      {!embedded && (
        <>
          <div className={css.toolbar}>
            <h3>{t('trajectory.title')}</h3>
            <button type="button" onClick={() => { void load() }}>{t('trajectory.refresh')}</button>
          </div>
          <div className={css.filters}>
            {([
              ['all', t('trajectory.filterAll')],
              ['user', t('trajectory.filterUser')],
              ['assistant', t('trajectory.filterAssistant')],
              ['tool', t('trajectory.filterTool')],
              ['request', t('trajectory.filterRequest')],
              ['other', t('trajectory.filterOther')],
            ] as const).map(([key, label]) => (
              <button key={key} type="button" className={filter === key ? css.active : ''} onClick={() => setFilter(key)}>
                {label}
              </button>
            ))}
          </div>
        </>
      )}
      {error !== null && <div className={css.error}>{error}</div>}
      {snapshot !== null && (
        <div className={css.meta}>{snapshot.eventCount} events · last seq {snapshot.lastSeq}</div>
      )}
      {rows.length === 0
        ? <p className={css.muted}>{t('trajectory.empty')}</p>
        : (
            <div className={css.brickRows}>
              {rows.map((row, rowIndex) => {
                const expandedIndex = row.findIndex(cell => cell.seq === expandedSeq)
                if (expandedIndex >= 0) {
                  const before = row.slice(0, expandedIndex + 1)
                  const after = row.slice(expandedIndex + 1)
                  const expandedInRow = row[expandedIndex]!
                  return (
                    <Fragment key={`split-${rowIndex}`}>
                      <div className={css.brickRow}>{before.map(brickButton)}</div>
                      <div
                        className={css.expandedRow}
                        role="button"
                        tabIndex={0}
                        onClick={() => setExpandedSeq(null)}
                        onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') setExpandedSeq(null) }}
                      >
                        <DetailRow
                          cell={expandedInRow}
                          t={t}
                          rpc={rpc}
                          depth={depth}
                          sessionId={sessionId}
                          editingSeq={editingSeq}
                          setEditingSeq={setEditingSeq}
                          onEdited={() => { void load() }}
                        />
                      </div>
                      {after.length > 0 && <div className={css.brickRow}>{after.map(brickButton)}</div>}
                    </Fragment>
                  )
                }
                return (
                  <div key={rowIndex} className={css.brickRow}>
                    {row.map(brickButton)}
                  </div>
                )
              })}
            </div>
          )}
      {expandedCell !== null && (
        <p className={css.muted}>{t('trajectory.collapse')}</p>
      )}
    </div>
  )
}
