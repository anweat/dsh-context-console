import test from 'node:test'
import assert from 'node:assert/strict'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { parseContext } from '../src/forge/context.ts'

test('parses an alpha.4 session through the snapshot API', () => {
  const session = Session.create(SessionId('session-context-alpha4'))
  session.append('turn/start', { turn: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  const snapshot = parseContext(session)

  assert.equal(snapshot.sessionId, 'session-context-alpha4')
  assert.equal(snapshot.eventCount, 2)
  assert.equal(snapshot.lastSeq, 1)
  assert.deepEqual(snapshot.counts, { 'turn/start': 1, 'turn/end': 1 })
  assert.equal(snapshot.turns.length, 1)
  assert.equal(snapshot.turns[0]?.startSeq, 0)
  assert.equal(snapshot.turns[0]?.endSeq, 1)
})
