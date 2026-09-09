/**
 * Message Forge tab.
 *
 * Three sections:
 *   1. Session context — detailed parse of the current live session recorded
 *      as an editable card stream (boundaries, user/assistant messages, tool
 *      calls/results, request headers, other log events). Card edits persist
 *      as record overrides and can be applied back into the session with a
 *      surface replace.
 *   2. Drafts — create/edit/delete assistant message drafts and inject them as
 *      complete synthetic turns.
 *   3. sessionlog import — decode/recognize an uploaded session log and reuse
 *      its assistant messages as drafts or injections.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ChangeEvent } from 'react'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import {
  AMF_RPC_CHANNEL, AMF_RPC_PREFIX,
  type AssistantDraft, type ContextApplyResponse, type ContextCard,
  type ContextCardPatch, type ContextSnapshot, type RecognizedEntry,
  type SessionLogParseResponse, type SessionLogRepairCreateResponse,
} from '../../forge/shared-types.ts'
import { ContextPanel } from './ContextPanel.tsx'
import css from './ForgeView.module.css'

export interface ForgeViewInjected {
  readonly rpc: ClientConnectionRpc
}

type ForgeViewProps = ConvViewProps & InjectFace<ForgeViewInjected> & PropsLocale<'assistantMessageForge'>

interface DraftForm {
  id: string | null
  title: string
  content: string
  reasoning: string
  provider: string
  model: string
}

type EntryFilter = 'all' | 'assistant' | 'user' | 'tool'

interface StatusLine {
  kind: 'ok' | 'error'
  text: string
}

const EMPTY_FORM: DraftForm = {
  id: null,
  title: '',
  content: '',
  reasoning: '',
  provider: '',
  model: '',
}

async function rpcCall<T>(rpc: ClientConnectionRpc, endpoint: string, payload: unknown): Promise<T> {
  const result = await rpc.call(AMF_RPC_CHANNEL, `${AMF_RPC_PREFIX}/${endpoint}`, payload)
  if (!result.ok) throw new Error(result.error.message)
  return result.value as T
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function fill(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (_match, key: string) => String(vars[key] ?? ''))
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const value = String(reader.result ?? '')
      const comma = value.indexOf(',')
      resolve(comma === -1 ? value : value.slice(comma + 1))
    }
    reader.onerror = () => { reject(reader.error ?? new Error('failed to read file')) }
    reader.readAsDataURL(file)
  })
}

function kindOf(entry: RecognizedEntry): 'assistant' | 'user' | 'tool' {
  if (entry.role === 'assistant') return 'assistant'
  if (entry.role === 'user') return 'user'
  return 'tool'
}

function entryLabel(entry: RecognizedEntry): string {
  if (entry.toolName !== undefined) return `${entry.toolName} (${entry.callId ?? ''})`
  const text = entry.text ?? entry.reasoning ?? ''
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.slice(0, 120)
}

export function ForgeView({ sessionId, rpc, t }: ForgeViewProps) {
  const [drafts, setDrafts] = useState<AssistantDraft[]>([])
  const [editor, setEditor] = useState<DraftForm | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [status, setStatus] = useState<StatusLine | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [importing, setImporting] = useState(false)
  const [repairing, setRepairing] = useState(false)
  const [report, setReport] = useState<SessionLogParseResponse | null>(null)
  const [filter, setFilter] = useState<EntryFilter>('assistant')
  const [context, setContext] = useState<ContextSnapshot | null>(null)
  const [contextBusy, setContextBusy] = useState(false)

  const refreshDrafts = useCallback(async () => {
    setDrafts(await rpcCall<AssistantDraft[]>(rpc, 'drafts/list', {}))
  }, [rpc])

  const loadContext = useCallback(async () => {
    try {
      const snapshot = await rpcCall<ContextSnapshot | null>(rpc, 'context/load', { sessionId })
      setContext(snapshot)
    } catch (error) {
      setStatus({ kind: 'error', text: errorText(error) })
    }
  }, [rpc, sessionId])

  useEffect(() => {
    refreshDrafts().catch((error: unknown) => {
      setStatus({ kind: 'error', text: errorText(error) })
    })
    void loadContext()
  }, [refreshDrafts, loadContext])

  const refreshContext = async (): Promise<void> => {
    setContextBusy(true)
    try {
      const snapshot = await rpcCall<ContextSnapshot>(rpc, 'context/refresh', { sessionId })
      setContext(snapshot)
      setStatus({
        kind: 'ok',
        text: fill(t('status.contextRefreshed'), {
          turns: snapshot.turns.length,
          cards: snapshot.cards.length,
          events: snapshot.eventCount,
        }),
      })
    } catch (error) {
      setStatus({ kind: 'error', text: errorText(error) })
    } finally {
      setContextBusy(false)
    }
  }

  const resetContextRecords = async (): Promise<void> => {
    setContextBusy(true)
    try {
      const snapshot = await rpcCall<ContextSnapshot | null>(rpc, 'records/reset', { sessionId })
      setContext(snapshot)
      setStatus({ kind: 'ok', text: t('status.recordReset') })
    } catch (error) {
      setStatus({ kind: 'error', text: errorText(error) })
    } finally {
      setContextBusy(false)
    }
  }

  const updateCardRecord = async (key: string, patch: ContextCardPatch): Promise<void> => {
    setContextBusy(true)
    try {
      const snapshot = await rpcCall<ContextSnapshot>(rpc, 'records/update', { sessionId, key, patch })
      setContext(snapshot)
      setStatus({ kind: 'ok', text: t('status.recordUpdated') })
    } catch (error) {
      setStatus({ kind: 'error', text: errorText(error) })
      throw error
    } finally {
      setContextBusy(false)
    }
  }

  const applyCard = async (key: string): Promise<ContextApplyResponse> => {
    setContextBusy(true)
    try {
      const result = await rpcCall<ContextApplyResponse>(rpc, 'context/apply', { sessionId, key })
      setStatus({
        kind: 'ok',
        text: fill(t('status.applied'), { oldSeq: result.replacedSeq, newSeq: result.newSeq }),
      })
      // Re-parse so the card stream shows original-as-shadowed plus the
      // replacement card as the active surface version.
      const snapshot = await rpcCall<ContextSnapshot>(rpc, 'context/refresh', { sessionId })
      setContext(snapshot)
      return result
    } catch (error) {
      setStatus({ kind: 'error', text: errorText(error) })
      throw error
    } finally {
      setContextBusy(false)
    }
  }

  const startNew = (): void => { setEditor(EMPTY_FORM) }
  const startEdit = (draft: AssistantDraft): void => {
    setEditor({
      id: draft.id,
      title: draft.title,
      content: draft.content,
      reasoning: draft.reasoning,
      provider: draft.provider,
      model: draft.model,
    })
  }

  const toDraftFromCard = (card: ContextCard): void => {
    const text = card.text ?? card.reasoning ?? ''
    setEditor({
      id: null,
      title: text.replace(/\s+/g, ' ').trim().slice(0, 60) || `${card.type} #${card.seq}`,
      content: card.text ?? '',
      reasoning: card.reasoning ?? '',
      provider: card.provider ?? '',
      model: card.model ?? '',
    })
    setStatus(null)
  }

  const saveDraft = async (): Promise<void> => {
    if (editor === null) return
    if (editor.content.trim() === '' && editor.reasoning.trim() === '') {
      setStatus({ kind: 'error', text: t('status.empty') })
      return
    }
    setBusy('save')
    try {
      await rpcCall<AssistantDraft>(rpc, 'drafts/save', {
        draft: {
          ...(editor.id === null ? {} : { id: editor.id }),
          title: editor.title,
          content: editor.content,
          reasoning: editor.reasoning,
          provider: editor.provider,
          model: editor.model,
        },
      })
      setEditor(null)
      await refreshDrafts()
      setStatus({ kind: 'ok', text: t('status.saved') })
    } catch (error) {
      setStatus({ kind: 'error', text: errorText(error) })
    } finally {
      setBusy(null)
    }
  }

  const deleteDraft = async (draft: AssistantDraft): Promise<void> => {
    if (!window.confirm(`Delete draft "${draft.title}"?`)) return
    setBusy(`delete:${draft.id}`)
    try {
      await rpcCall<boolean>(rpc, 'drafts/delete', { id: draft.id })
      if (editor?.id === draft.id) setEditor(null)
      await refreshDrafts()
      setStatus({ kind: 'ok', text: t('status.deleted') })
    } catch (error) {
      setStatus({ kind: 'error', text: errorText(error) })
    } finally {
      setBusy(null)
    }
  }

  const injectDraft = async (draft: AssistantDraft): Promise<void> => {
    setBusy(`inject:${draft.id}`)
    try {
      const result = await rpcCall<{ turn: number }>(rpc, 'session/inject', {
        sessionId,
        message: {
          content: draft.content,
          reasoning: draft.reasoning,
          provider: draft.provider,
          model: draft.model,
        },
      })
      setStatus({ kind: 'ok', text: fill(t('status.injected'), { turn: result.turn }) })
    } catch (error) {
      setStatus({ kind: 'error', text: errorText(error) })
    } finally {
      setBusy(null)
    }
  }

  const injectEntry = async (entry: RecognizedEntry): Promise<void> => {
    setBusy(`inject-entry:${entry.seq}`)
    try {
      const result = await rpcCall<{ turn: number }>(rpc, 'session/inject', {
        sessionId,
        message: {
          content: entry.text ?? '',
          reasoning: entry.reasoning ?? '',
          provider: entry.provider,
          model: entry.model,
          usage: entry.usage ?? null,
        },
      })
      setStatus({ kind: 'ok', text: fill(t('status.injected'), { turn: result.turn }) })
    } catch (error) {
      setStatus({ kind: 'error', text: errorText(error) })
    } finally {
      setBusy(null)
    }
  }

  const addEntryAsDraft = (entry: RecognizedEntry): void => {
    const text = entry.text ?? entry.reasoning ?? ''
    setEditor({
      id: null,
      title: text.replace(/\s+/g, ' ').trim().slice(0, 60) || `${entry.type} #${entry.seq}`,
      content: entry.text ?? '',
      reasoning: entry.reasoning ?? '',
      provider: entry.provider ?? '',
      model: entry.model ?? '',
    })
    setStatus(null)
  }

  const importFile = async (): Promise<void> => {
    if (file === null) return
    setImporting(true)
    setStatus(null)
    try {
      const dataBase64 = await fileToBase64(file)
      const parsed = await rpcCall<SessionLogParseResponse>(rpc, 'sessionlog/parse', {
        name: file.name,
        dataBase64,
      })
      setReport(parsed)
      setStatus({
        kind: 'ok',
        text: fill(t('status.parsed'), {
          total: parsed.totalEvents,
          recognized: parsed.recognizedTotal,
        }),
      })
    } catch (error) {
      setStatus({ kind: 'error', text: errorText(error) })
    } finally {
      setImporting(false)
    }
  }

  const repairFile = async (): Promise<void> => {
    if (file === null || report?.repair?.repairable !== true) return
    setRepairing(true)
    setStatus(null)
    try {
      const dataBase64 = await fileToBase64(file)
      const repaired = await rpcCall<SessionLogRepairCreateResponse>(rpc, 'sessionlog/repair-create', {
        name: file.name,
        dataBase64,
      })
      setStatus({
        kind: 'ok',
        text: fill(t('status.repaired'), { sessionId: repaired.sessionId }),
      })
    } catch (error) {
      setStatus({ kind: 'error', text: errorText(error) })
    } finally {
      setRepairing(false)
    }
  }

  const visibleEntries = useMemo(() => {
    if (report === null) return []
    return report.recognized.filter(entry => filter === 'all' || kindOf(entry) === filter)
  }, [report, filter])

  const countEntries = useMemo(() => {
    if (report === null) return []
    return Object.entries(report.counts).sort((a, b) => b[1] - a[1]).slice(0, 12)
  }, [report])

  return (
    <div className={css.panel}>
      <div className={css.toolbar}>
        <button type="button" className={css.primary} onClick={startNew}>{t('drafts.add')}</button>
      </div>

      {status !== null && (
        <div className={status.kind === 'ok' ? css.notice : css.error}>{status.text}</div>
      )}

      <details className={css.section} open>
        <summary>{t('context.title')}</summary>
        {context === null
          ? (
              <div className={css.card}>
                <p className={css.muted}>{t('context.empty')}</p>
                <div className={css.actions}>
                  <button type="button" className={css.primary} disabled={contextBusy} onClick={() => { void refreshContext() }}>
                    {t('context.refresh')}
                  </button>
                </div>
              </div>
            )
          : (
              <ContextPanel
                snapshot={context}
                busy={contextBusy}
                t={t}
                onRefresh={() => { void refreshContext() }}
                onReset={() => { void resetContextRecords() }}
                onUpdateCard={updateCardRecord}
                onApplyCard={applyCard}
                onToDraft={toDraftFromCard}
              />
            )}
      </details>

      <details className={css.section} open>
        <summary>{t('drafts.title')}</summary>
        {editor !== null && (
          <section className={css.card}>
            <h3>{editor.id === null ? t('drafts.add') : t('drafts.edit')}</h3>
            <label className={css.field}>
              <span>{t('fields.title')}</span>
              <input
                value={editor.title}
                onChange={event => { setEditor({ ...editor, title: event.target.value }) }}
              />
            </label>
            <label className={css.field}>
              <span>{t('fields.reasoning')}</span>
              <textarea
                rows={3}
                value={editor.reasoning}
                onChange={event => { setEditor({ ...editor, reasoning: event.target.value }) }}
              />
            </label>
            <label className={css.field}>
              <span>{t('fields.content')}</span>
              <textarea
                rows={6}
                value={editor.content}
                onChange={event => { setEditor({ ...editor, content: event.target.value }) }}
              />
            </label>
            <div className={css.row}>
              <label className={css.field}>
                <span>{t('fields.provider')}</span>
                <input
                  value={editor.provider}
                  placeholder="assistant-message-forge"
                  onChange={event => { setEditor({ ...editor, provider: event.target.value }) }}
                />
              </label>
              <label className={css.field}>
                <span>{t('fields.model')}</span>
                <input
                  value={editor.model}
                  placeholder="test"
                  onChange={event => { setEditor({ ...editor, model: event.target.value }) }}
                />
              </label>
            </div>
            <div className={css.actions}>
              <button type="button" className={css.primary} disabled={busy !== null} onClick={() => { void saveDraft() }}>
                {t('drafts.save')}
              </button>
              <button type="button" disabled={busy !== null} onClick={() => { setEditor(null) }}>
                {t('drafts.cancel')}
              </button>
            </div>
          </section>
        )}

        {drafts.length === 0
          ? <p className={css.muted}>{t('drafts.empty')}</p>
          : (
              <ul className={css.list}>
                {drafts.map(draft => (
                  <li key={draft.id} className={css.item}>
                    <div className={css.itemHead}>
                      <strong>{draft.title}</strong>
                      <span className={css.muted}>{draft.provider} / {draft.model}</span>
                    </div>
                    <p className={css.preview}>{(draft.reasoning.trim() !== '' ? `⟨reasoning⟩ ${draft.reasoning} ` : '') + draft.content}</p>
                    <div className={css.actions}>
                      <button type="button" disabled={busy !== null} onClick={() => { startEdit(draft) }}>
                        {t('drafts.edit')}
                      </button>
                      <button
                        type="button"
                        className={css.primary}
                        disabled={busy !== null}
                        onClick={() => { void injectDraft(draft) }}
                      >
                        {t('drafts.inject')}
                      </button>
                      <button
                        type="button"
                        className={css.danger}
                        disabled={busy !== null}
                        onClick={() => { void deleteDraft(draft) }}
                      >
                        {t('drafts.delete')}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
      </details>

      <details className={css.section}>
        <summary>{t('import.title')}</summary>
        <div className={css.card}>
          <div className={css.row}>
            <input
              type="file"
              accept=".jsonl,.zstd,.zst,.jsonl.zstd,application/json,application/zstd"
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                setFile(event.target.files?.[0] ?? null)
                setReport(null)
              }}
            />
            <button type="button" className={css.primary} disabled={file === null || importing} onClick={() => { void importFile() }}>
              {importing ? t('import.parsing') : t('import.parse')}
            </button>
          </div>
          {report !== null && (
            <div className={css.report}>
              {report.header !== null && (
                <dl className={css.headerInfo}>
                  <dt>{t('import.header')}</dt>
                  <dd>
                    id={report.header.id ?? '—'} · cwd={report.header.cwd ?? '—'}
                    {report.header.agentPreset !== undefined ? ` · preset=${report.header.agentPreset}` : ''}
                    {report.header.createdAt !== undefined ? ` · ${new Date(report.header.createdAt).toLocaleString()}` : ''}
                  </dd>
                </dl>
              )}
              <dl className={css.counts}>
                <dt>{t('import.counts')}</dt>
                <dd>{countEntries.map(([type, count]) => `${type}: ${count}`).join(' · ')}</dd>
              </dl>
              {report.parseIssues > 0 && (
                <p className={css.error}>
                  {t('import.issues')}: {report.parseIssues} — {report.issueSamples.join(' | ')}
                </p>
              )}
              {report.repair !== undefined && (
                <section className={css.repairBox}>
                  <strong>{t('repair.title')}</strong>
                  <p className={css.muted}>
                    {fill(t('repair.summary'), {
                      original: report.repair.originalEventCount,
                      repaired: report.repair.repairedEventCount,
                      rewinds: report.repair.branchRewinds.length,
                      closers: report.repair.closersAdded.length,
                    })}
                  </p>
                  {report.repair.branchRewinds.length > 0 && (
                    <p className={css.muted}>
                      {t('repair.rewinds')}: {report.repair.branchRewinds
                        .map(rewind => `seq ${rewind.fromSeq} (-${rewind.discardedEvents})`)
                        .join(' · ')}
                    </p>
                  )}
                  {report.repair.closersAdded.length > 0 && (
                    <p className={css.muted}>{t('repair.closers')}: {report.repair.closersAdded.join(' → ')}</p>
                  )}
                  {report.repair.stopped !== null && (
                    <p className={css.error}>{t('repair.stopped')}: line {report.repair.stopped.line} · {report.repair.stopped.reason}</p>
                  )}
                  {report.repair.validationError !== null && (
                    <p className={css.error}>{t('repair.refused')}: {report.repair.validationError}</p>
                  )}
                  <p className={css.muted}>{t('repair.safety')}</p>
                  {(report.repair.branchRewinds.length > 0
                    || report.repair.closersAdded.length > 0
                    || report.repair.stopped !== null) && (
                    <div className={css.actions}>
                      <button
                        type="button"
                        className={css.primary}
                        disabled={!report.repair.repairable || repairing}
                        onClick={() => { void repairFile() }}
                      >
                        {repairing ? t('repair.creating') : t('repair.create')}
                      </button>
                    </div>
                  )}
                </section>
              )}
              <div className={css.filters}>
                {(['all', 'assistant', 'user', 'tool'] as const).map(kind => (
                  <button
                    key={kind}
                    type="button"
                    className={filter === kind ? css.active : ''}
                    onClick={() => { setFilter(kind) }}
                  >
                    {t(`filter.${kind}`)}
                  </button>
                ))}
              </div>
              {visibleEntries.length === 0
                ? <p className={css.muted}>{t('import.none')}</p>
                : (
                    <ul className={css.list}>
                      {visibleEntries.map(entry => (
                        <li key={`${entry.type}:${entry.seq}`} className={css.item}>
                          <div className={css.itemHead}>
                            <strong>#{entry.seq} {entry.type}</strong>
                            {entry.turn !== undefined && <span className={css.muted}>turn {entry.turn}/{entry.step}</span>}
                          </div>
                          <p className={css.preview}>{entryLabel(entry)}</p>
                          {entry.unsupportedBlocks !== undefined && entry.unsupportedBlocks > 0 && (
                            <p className={css.muted}>{fill(t('import.unsupported'), { count: entry.unsupportedBlocks })}</p>
                          )}
                          <div className={css.actions}>
                            <button type="button" disabled={busy !== null} onClick={() => { addEntryAsDraft(entry) }}>
                              {t('import.addDraft')}
                            </button>
                            {entry.role === 'assistant' && (
                              <button
                                type="button"
                                className={css.primary}
                                disabled={busy !== null}
                                onClick={() => { void injectEntry(entry) }}
                              >
                                {t('import.inject')}
                              </button>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
            </div>
          )}
        </div>
      </details>
    </div>
  )
}
