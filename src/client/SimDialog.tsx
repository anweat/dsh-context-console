/** SimDialog: add simulated messages of various kinds to the current session. */
import { useState } from 'react'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SimMessageResult, SimMessageType } from '../shared-types.ts'
import { rpcCall } from './ConsoleView.tsx'
import css from './styles.module.css'

type Translate = PropsLocale<'contextConsole'>['t']

const TYPES: Array<{ value: SimMessageType; label: string }> = [
  { value: 'assistant', label: 'Assistant' },
  { value: 'user', label: 'User' },
  { value: 'tool-call', label: 'Tool Call' },
  { value: 'tool-result', label: 'Tool Result' },
  { value: 'raw', label: 'Raw JSON' },
]

export function SimDialog({
  sessionId, rpc, t, onClose,
}: {
  sessionId: string
  rpc: ClientConnectionRpc
  t: Translate
  onClose: () => void
}) {
  const [type, setType] = useState<SimMessageType>('assistant')
  const [content, setContent] = useState('')
  const [reasoning, setReasoning] = useState('')
  const [provider, setProvider] = useState('context-console')
  const [model, setModel] = useState('simulated')
  const [toolName, setToolName] = useState('')
  const [toolArguments, setToolArguments] = useState('{}')
  const [toolResultText, setToolResultText] = useState('')
  const [isError, setIsError] = useState(false)
  const [callId, setCallId] = useState('')
  const [rawJson, setRawJson] = useState('{\n  "type": "user/message",\n  "data": {}\n}')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const message: Record<string, unknown> = { type }
      if (type === 'assistant' || type === 'user') {
        message.content = content
        message.reasoning = reasoning
        message.provider = provider
        message.model = model
      } else if (type === 'tool-call') {
        message.toolName = toolName
        message.toolArguments = toolArguments
        message.callId = callId || undefined
      } else if (type === 'tool-result') {
        message.toolResultText = toolResultText
        message.isError = isError
        message.callId = callId || undefined
      } else if (type === 'raw') {
        let raw: unknown
        try {
          raw = JSON.parse(rawJson)
        } catch (e) {
          throw new Error(`raw JSON parse failed: ${e instanceof Error ? e.message : String(e)}`)
        }
        message.raw = raw
      }
      const payload: Record<string, unknown> = { sessionId, message }
      const result = await rpcCall<SimMessageResult>(rpc, 'sim/inject', payload)
      setMessage(t('sim.success').replace('{turn}', String(result.turn)))
      setContent('')
      setReasoning('')
      setToolName('')
      setToolArguments('{}')
      setToolResultText('')
      setCallId('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={css.modalBackdrop}>
      <div className={css.modal}>
        <h3>{t('sim.title')}</h3>
        <div className={css.row}>
          {TYPES.map(item => (
            <button
              key={item.value}
              type="button"
              className={type === item.value ? css.active : ''}
              onClick={() => setType(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>

        {(type === 'assistant' || type === 'user') && (
          <>
            <label className={css.field}>
              <span>{t('sim.reasoning')}</span>
              <textarea rows={3} value={reasoning} onChange={event => setReasoning(event.target.value)} />
            </label>
            <label className={css.field}>
              <span>{t('sim.content')}</span>
              <textarea rows={5} value={content} onChange={event => setContent(event.target.value)} />
            </label>
            {type === 'assistant' && (
              <div className={css.row}>
                <label className={css.field}>
                  <span>{t('sim.provider')}</span>
                  <input value={provider} onChange={event => setProvider(event.target.value)} />
                </label>
                <label className={css.field}>
                  <span>{t('sim.model')}</span>
                  <input value={model} onChange={event => setModel(event.target.value)} />
                </label>
              </div>
            )}
          </>
        )}

        {type === 'tool-call' && (
          <>
            <label className={css.field}>
              <span>toolName</span>
              <input value={toolName} onChange={event => setToolName(event.target.value)} />
            </label>
            <label className={css.field}>
              <span>callId (optional)</span>
              <input value={callId} onChange={event => setCallId(event.target.value)} />
            </label>
            <label className={css.field}>
              <span>arguments (JSON string)</span>
              <textarea rows={5} value={toolArguments} onChange={event => setToolArguments(event.target.value)} />
            </label>
          </>
        )}

        {type === 'tool-result' && (
          <>
            <label className={css.field}>
              <span>callId (optional)</span>
              <input value={callId} onChange={event => setCallId(event.target.value)} />
            </label>
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

        {type === 'raw' && (
          <label className={css.field}>
            <span>Raw JSON event</span>
            <textarea rows={10} value={rawJson} onChange={event => setRawJson(event.target.value)} />
          </label>
        )}

        {message !== null && <div className={css.notice}>{message}</div>}
        {error !== null && <div className={css.error}>{error}</div>}
        <div className={css.row}>
          <button type="button" className={css.primary} disabled={busy} onClick={() => { void submit() }}>
            {busy ? t('sim.injecting') : t('sim.inject')}
          </button>
          <button type="button" disabled={busy} onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
