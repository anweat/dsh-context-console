/** Recorded session-context card stream with inline dynamic editing. */
import { useMemo, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  ContextApplyResponse, ContextCard, ContextCardPatch, ContextSnapshot, ForgeUsage,
} from '../../forge/shared-types.ts'
import css from './ForgeView.module.css'

type LocaleProps = PropsLocale<'assistantMessageForge'>
type Translate = LocaleProps['t']

export type ContextFilter = 'all' | 'assistant' | 'user' | 'tool' | 'boundary' | 'request' | 'other'

export interface ContextPanelProps {
  snapshot: ContextSnapshot
  busy: boolean
  onRefresh: () => void
  onReset: () => void
  onUpdateCard: (key: string, patch: ContextCardPatch) => Promise<unknown>
  onApplyCard: (key: string) => Promise<ContextApplyResponse>
  onToDraft: (card: ContextCard) => void
}

interface UsageForm {
  input: string
  output: string
  cacheRead: string
  cacheWrite: string
  reasoning: string
}

interface CardForm {
  text: string
  reasoning: string
  provider: string
  model: string
  toolName: string
  toolArguments: string
  toolResultText: string
  isError: boolean
  usage: UsageForm
}

const EMPTY_USAGE: UsageForm = { input: '', output: '', cacheRead: '', cacheWrite: '', reasoning: '' }

function emptyForm(): CardForm {
  return {
    text: '',
    reasoning: '',
    provider: '',
    model: '',
    toolName: '',
    toolArguments: '',
    toolResultText: '',
    isError: false,
    usage: { ...EMPTY_USAGE },
  }
}

function formOf(card: ContextCard): CardForm {
  return {
    text: card.text ?? '',
    reasoning: card.reasoning ?? '',
    provider: card.provider ?? '',
    model: card.model ?? '',
    toolName: card.toolName ?? '',
    toolArguments: card.toolArguments ?? '',
    toolResultText: card.toolResultText ?? '',
    isError: card.isError === true,
    usage: {
      input: card.usage?.inputTokens === undefined ? '' : String(card.usage.inputTokens),
      output: card.usage?.outputTokens === undefined ? '' : String(card.usage.outputTokens),
      cacheRead: card.usage?.cacheReadTokens === undefined ? '' : String(card.usage.cacheReadTokens),
      cacheWrite: card.usage?.cacheWriteTokens === undefined ? '' : String(card.usage.cacheWriteTokens),
      reasoning: card.usage?.reasoningTokens === undefined ? '' : String(card.usage.reasoningTokens),
    },
  }
}

function fill(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (_match, key: string) => String(vars[key] ?? ''))
}

function integer(value: string, field: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${field} must be a non-negative integer`)
  return parsed
}

function usageFrom(form: CardForm): ForgeUsage | null {
  const input = form.usage.input.trim()
  const output = form.usage.output.trim()
  if (input === '' || output === '') return null
  const usage: ForgeUsage = {
    inputTokens: integer(input, 'usage.inputTokens'),
    outputTokens: integer(output, 'usage.outputTokens'),
  }
  if (form.usage.cacheRead.trim() !== '') usage.cacheReadTokens = integer(form.usage.cacheRead, 'usage.cacheReadTokens')
  if (form.usage.cacheWrite.trim() !== '') usage.cacheWriteTokens = integer(form.usage.cacheWrite, 'usage.cacheWriteTokens')
  if (form.usage.reasoning.trim() !== '') usage.reasoningTokens = integer(form.usage.reasoning, 'usage.reasoningTokens')
  return usage
}

function patchFrom(card: ContextCard, form: CardForm): ContextCardPatch {
  switch (card.kind) {
    case 'assistant':
      return {
        text: form.text,
        reasoning: form.reasoning,
        provider: form.provider,
        model: form.model,
        usage: usageFrom(form),
      }
    case 'user':
      return { text: form.text, reasoning: form.reasoning }
    case 'tool-call':
      return { toolName: form.toolName, toolArguments: form.toolArguments }
    case 'tool-result':
      return { toolResultText: form.toolResultText, isError: form.isError }
    default:
      throw new Error(`card ${card.key} is not editable`)
  }
}

function filterOf(card: ContextCard): Exclude<ContextFilter, 'all'> {
  switch (card.kind) {
    case 'assistant': return 'assistant'
    case 'user': return 'user'
    case 'tool-call':
    case 'tool-result': return 'tool'
    case 'turn-boundary':
    case 'step-boundary': return 'boundary'
    case 'request': return 'request'
    default: return 'other'
  }
}

function jsonPreview(value: unknown, max = 4000): string {
  let text: string
  try {
    text = JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    text = String(value)
  }
  return text.length <= max ? text : `${text.slice(0, max)}\n… (truncated)`
}

interface CardGroup {
  label: string
  cards: ContextCard[]
}

function groupCards(cards: readonly ContextCard[]): CardGroup[] {
  const groups: CardGroup[] = []
  let current: CardGroup | null = null
  for (const card of cards) {
    if (current === null || current.cards.length === 0 || card.type === 'turn/start') {
      current = { label: card.type === 'turn/start' && card.turn !== undefined ? `turn:${card.turn}` : 'meta', cards: [] }
      groups.push(current)
    }
    current.cards.push(card)
  }
  return groups
}

function CardBody({ card, t }: { card: ContextCard; t: Translate }) {
  const hasText = (card.text ?? '') !== '' || (card.reasoning ?? '') !== ''
  return (
    <div className={css.cardBody}>
      {(card.kind === 'assistant' || card.kind === 'user') && (
        <>
          {hasText && (
            <>
              {(card.reasoning ?? '') !== '' && (
                <div className={css.blockRow}>
                  <span className={css.blockLabel}>reasoning</span>
                  <pre className={css.cardPre}>{card.reasoning}</pre>
                </div>
              )}
              {(card.text ?? '') !== '' && (
                <div className={css.blockRow}>
                  <span className={css.blockLabel}>text</span>
                  <pre className={css.cardPre}>{card.text}</pre>
                </div>
              )}
            </>
          )}
          <div className={css.cardMetaRow}>
            {card.provider !== undefined && <span>{t('card.provider')}: {card.provider}</span>}
            {card.model !== undefined && <span>{t('card.model')}: {card.model}</span>}
            {card.sourceKind !== undefined && <span>source: {card.sourceKind}</span>}
          </div>
          {card.usage != null && (
            <div className={css.cardMetaRow}>
              <span>{t('card.usage')}: {JSON.stringify(card.usage)}</span>
            </div>
          )}
          {card.otherBlocks !== undefined && card.otherBlocks.length > 0 && (
            <div className={css.cardMetaRow}>
              <span>{fill(t('card.otherBlocks'), { count: card.otherBlocks.length })}</span>
              <pre className={css.cardPre}>{jsonPreview(card.otherBlocks, 1200)}</pre>
            </div>
          )}
        </>
      )}
      {card.kind === 'tool-call' && (
        <>
          <div className={css.cardMetaRow}><span>{t('card.callId')}: {card.callId}</span></div>
          <pre className={css.cardPre}>{card.toolArguments}</pre>
        </>
      )}
      {card.kind === 'tool-result' && (
        <>
          <div className={css.cardMetaRow}>
            <span>{t('card.callId')}: {card.callId}</span>
            <span>isError: {String(card.isError === true)}</span>
            {card.toolError !== undefined && <span>error: {card.toolError.code ?? card.toolError.name}</span>}
          </div>
          <pre className={css.cardPre}>{card.toolResultText}</pre>
        </>
      )}
      {card.kind === 'request' && (
        <>
          {card.systemPrompt !== undefined && (
            <div className={css.blockRow}>
              <span className={css.blockLabel}>{t('card.systemPrompt')}</span>
              <pre className={css.cardPre}>{jsonPreview(card.systemPrompt, 2400)}</pre>
            </div>
          )}
          {Array.isArray(card.toolSchemas) && (
            <div className={css.cardMetaRow}><span>{t('card.toolSchemas')}: {card.toolSchemas.length}</span></div>
          )}
          {card.requestHeader !== undefined && (
            <details className={css.rawDetails}>
              <summary>{t('card.requestHeader')}</summary>
              <pre className={css.cardPre}>{jsonPreview(card.requestHeader)}</pre>
            </details>
          )}
        </>
      )}
      {card.kind === 'other' && (
        <details className={css.rawDetails}>
          <summary>{t('card.raw')}</summary>
          <pre className={css.cardPre}>{jsonPreview(card.raw)}</pre>
        </details>
      )}
    </div>
  )
}

function CardEditor({
  card, form, t, onForm, onCancel, onSave, onSaveApply, showApply, busy,
}: {
  card: ContextCard
  form: CardForm
  t: Translate
  onForm: (next: CardForm) => void
  onCancel: () => void
  onSave: () => void
  onSaveApply: (() => void) | null
  showApply: boolean
  busy: boolean
}) {
  const usage = form.usage
  return (
    <div className={css.cardEditor}>
      {(card.kind === 'assistant' || card.kind === 'user') && (
        <>
          <label className={css.field}>
            <span>{t('fields.reasoning')}</span>
            <textarea rows={3} value={form.reasoning} onChange={event => { onForm({ ...form, reasoning: event.target.value }) }} />
          </label>
          <label className={css.field}>
            <span>{t('fields.content')}</span>
            <textarea rows={5} value={form.text} onChange={event => { onForm({ ...form, text: event.target.value }) }} />
          </label>
        </>
      )}
      {card.kind === 'assistant' && (
        <>
          <div className={css.row}>
            <label className={css.field}>
              <span>{t('card.provider')}</span>
              <input value={form.provider} onChange={event => { onForm({ ...form, provider: event.target.value }) }} />
            </label>
            <label className={css.field}>
              <span>{t('card.model')}</span>
              <input value={form.model} onChange={event => { onForm({ ...form, model: event.target.value }) }} />
            </label>
          </div>
          <div className={css.usageGrid}>
            <span className={css.usageTitle}>{t('card.usage')}</span>
            <input aria-label={t('card.usageInput')} value={usage.input} placeholder={t('card.usageInput')}
              onChange={event => { onForm({ ...form, usage: { ...usage, input: event.target.value } }) }} />
            <input aria-label={t('card.usageOutput')} value={usage.output} placeholder={t('card.usageOutput')}
              onChange={event => { onForm({ ...form, usage: { ...usage, output: event.target.value } }) }} />
            <input aria-label={t('card.usageCacheRead')} value={usage.cacheRead} placeholder={t('card.usageCacheRead')}
              onChange={event => { onForm({ ...form, usage: { ...usage, cacheRead: event.target.value } }) }} />
            <input aria-label={t('card.usageCacheWrite')} value={usage.cacheWrite} placeholder={t('card.usageCacheWrite')}
              onChange={event => { onForm({ ...form, usage: { ...usage, cacheWrite: event.target.value } }) }} />
            <input aria-label={t('card.usageReasoning')} value={usage.reasoning} placeholder={t('card.usageReasoning')}
              onChange={event => { onForm({ ...form, usage: { ...usage, reasoning: event.target.value } }) }} />
          </div>
        </>
      )}
      {card.kind === 'tool-call' && (
        <>
          <label className={css.field}>
            <span>{t('card.toolName')}</span>
            <input value={form.toolName} onChange={event => { onForm({ ...form, toolName: event.target.value }) }} />
          </label>
          <label className={css.field}>
            <span>{t('card.toolArguments')}</span>
            <textarea rows={6} value={form.toolArguments} onChange={event => { onForm({ ...form, toolArguments: event.target.value }) }} />
          </label>
        </>
      )}
      {card.kind === 'tool-result' && (
        <>
          <label className={css.field}>
            <span>{t('card.toolResultText')}</span>
            <textarea rows={5} value={form.toolResultText} onChange={event => { onForm({ ...form, toolResultText: event.target.value }) }} />
          </label>
          <label className={css.checkField}>
            <input type="checkbox" checked={form.isError} onChange={event => { onForm({ ...form, isError: event.target.checked }) }} />
            <span>{t('card.isError')}</span>
          </label>
          <p className={css.muted}>{t('card.toolResultIsErrorNote')}</p>
        </>
      )}
      <div className={css.actions}>
        <button type="button" className={css.primary} disabled={busy} onClick={onSave}>{t('card.saveRecord')}</button>
        {showApply && onSaveApply !== null && (
          <button type="button" className={css.primary} disabled={busy} onClick={onSaveApply}>{t('card.saveAndApply')}</button>
        )}
        <button type="button" disabled={busy} onClick={onCancel}>{t('card.cancel')}</button>
      </div>
    </div>
  )
}

export function ContextPanel({
  snapshot, busy, onRefresh, onReset, onUpdateCard, onApplyCard, onToDraft, t,
}: ContextPanelProps & LocaleProps) {
  const [filter, setFilter] = useState<ContextFilter>('all')
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [form, setForm] = useState<CardForm>(emptyForm)

  const filtered = useMemo(() => snapshot.cards.filter(card => filter === 'all' || filterOf(card) === filter), [snapshot, filter])
  const groups = useMemo(() => groupCards(filtered), [filtered])
  const turnById = useMemo(() => new Map(snapshot.turns.map(turn => [turn.turn, turn])), [snapshot])

  const startEdit = (card: ContextCard): void => {
    setEditingKey(card.key)
    setForm(formOf(card))
  }

  const save = async (card: ContextCard, apply: boolean): Promise<void> => {
    await onUpdateCard(card.key, patchFrom(card, form))
    if (apply) await onApplyCard(card.key)
    setEditingKey(null)
  }

  return (
    <div className={css.contextPanel}>
      <div className={css.contextToolbar}>
        <button type="button" className={css.primary} disabled={busy} onClick={onRefresh}>{t('context.refresh')}</button>
        <button type="button" disabled={busy} onClick={onReset}>{t('context.reset')}</button>
        <span className={css.muted}>
          {fill(t('context.meta'), {
            time: new Date(snapshot.recordedAt).toLocaleString(),
            eventCount: snapshot.eventCount,
            cardCount: snapshot.cards.length,
            surfaceCount: snapshot.surfaceNodes.length,
            lastSeq: snapshot.lastSeq,
          })}
        </span>
      </div>
      <div className={css.filters}>
        {(['all', 'assistant', 'user', 'tool', 'boundary', 'request', 'other'] as const).map(kind => (
          <button key={kind} type="button" className={filter === kind ? css.active : ''} onClick={() => { setFilter(kind) }}>
            {t(`filter.${kind}`)}
          </button>
        ))}
      </div>

      {groups.length === 0 && <p className={css.muted}>{t('import.none')}</p>}
      {groups.map((group, index) => {
        const turn = group.label.startsWith('turn:') ? Number(group.label.slice(5)) : undefined
        const summary = turn === undefined ? undefined : turnById.get(turn)
        const heading = turn === undefined
          ? t('context.groupMeta')
          : fill(t('context.groupTurn'), {
            turn,
            stepCount: summary?.stepCount ?? 0,
            chunkCount: summary?.chunkCount ?? 0,
            cardCount: summary?.cardCount ?? group.cards.length,
          })
        return (
          <section key={`${group.label}:${index}`} className={css.cardGroup}>
            <h4 className={css.groupHeading}>{heading}</h4>
            <ul className={css.list}>
              {group.cards.map(card => {
                const editing = editingKey === card.key
                const showApply = card.applyable && card.inSurface && !card.shadowed
                return (
                  <li key={card.key} className={`${css.item} ${css.contextCard}`}>
                    <div className={css.cardHead}>
                      <span className={css.cardBadge}>#{card.seq} {card.type}</span>
                      {card.turn !== undefined && <span className={css.muted}>turn {card.turn}{card.step !== undefined ? `/${card.step}` : ''}</span>}
                      <span className={css.cardSummary}>{card.summary}</span>
                    </div>
                    <div className={css.cardChips}>
                      {card.inSurface && <span className={css.chip}>{`surface`}</span>}
                      {card.shadowed && <span className={css.chipWarning}>{fill(t('card.shadowed'), { seqs: card.replacedBy.join(', ') })}</span>}
                      {card.replacementOf.length > 0 && <span className={css.chipInfo}>{fill(t('card.replacement'), { seqs: card.replacementOf.join(', ') })}</span>}
                      {card.applyable && !card.inSurface && <span className={css.chipWarning}>{t('card.notSurface')}</span>}
                    </div>
                    <div className={css.cardActions}>
                      {card.editable && (
                        <button type="button" disabled={busy} onClick={() => { editing ? setEditingKey(null) : startEdit(card) }}>
                          {editing ? t('card.cancel') : t('card.edit')}
                        </button>
                      )}
                      {showApply && !editing && (
                        <button type="button" className={css.primary} disabled={busy} onClick={() => { void onApplyCard(card.key) }}>
                          {t('card.apply')}
                        </button>
                      )}
                      {card.role !== undefined && (
                        <button type="button" disabled={busy} onClick={() => { onToDraft(card) }}>
                          {t('card.toDraft')}
                        </button>
                      )}
                    </div>
                    {!editing && <CardBody card={card} t={t} />}
                    {editing && (
                      <CardEditor
                        card={card}
                        form={form}
                        t={t}
                        busy={busy}
                        onForm={setForm}
                        onCancel={() => { setEditingKey(null) }}
                        onSave={() => { void save(card, false) }}
                        onSaveApply={showApply ? () => { void save(card, true) } : null}
                        showApply={showApply}
                      />
                    )}
                  </li>
                )
              })}
            </ul>
          </section>
        )
      })}
    </div>
  )
}
