import test from 'node:test'
import assert from 'node:assert/strict'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { parseContext } from '../src/forge/context.ts'
import { syntheticAssistantStream } from '../src/forge/stream.ts'

test('parses a 0.1.5 Session Log V3 session and embedded assistant streams', () => {
  const session = Session.create(SessionId('session-context-alpha5'))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/attempt', {
    turn: 1,
    step: 1,
    stream: syntheticAssistantStream('failed reasoning', 'failed text', 100),
  })
  const message = createAssistantMessage({
    content: [{ type: 'text', text: 'settled text' }],
    source: { provider: 'context-console-test', model: 'synthetic' },
  })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message,
    stream: syntheticAssistantStream('', 'settled text', 200),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  const snapshot = parseContext(session)

  assert.equal(snapshot.sessionId, 'session-context-alpha5')
  assert.equal(snapshot.eventCount, 6)
  assert.equal(snapshot.lastSeq, 5)
  assert.deepEqual(snapshot.counts, {
    'turn/start': 1,
    'step/start': 1,
    'assistant/attempt': 1,
    'assistant/message': 1,
    'step/end': 1,
    'turn/end': 1,
  })
  assert.equal(snapshot.turns.length, 1)
  assert.equal(snapshot.turns[0]?.startSeq, 0)
  assert.equal(snapshot.turns[0]?.endSeq, 5)
  assert.equal(snapshot.turns[0]?.stepCount, 1)
  assert.equal(snapshot.turns[0]?.chunkCount, 3)
  assert.equal(snapshot.cards.find(card => card.type === 'assistant/message')?.text, 'settled text')
})
