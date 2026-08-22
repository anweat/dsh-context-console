import assert from 'node:assert/strict'
import { repairSessionLogBytes } from '../lib/forge/sessionlog.js'

const header = {
  type: 'session',
  version: 0,
  id: 'session-corrupt-test',
  createdAt: 1,
  cwd: 'D:/codeproject/dsh-plugin',
}

const event = (type, seq, data) => ({ type, seq, time: 1000 + seq, data })
const physicalRows = [
  event('turn/start', 0, { turn: 1 }),
  event('step/start', 1, { turn: 1, step: 1 }),
  event('assistant/chunk', 2, {
    turn: 1,
    step: 1,
    chunk: { type: 'text-delta', index: 0, text: 'before' },
  }),
  // First physical branch closes the turn as interrupted.
  event('step/end', 3, { turn: 1, step: 1 }),
  event('turn/end', 4, { turn: 1, reason: { kind: 'interrupted' } }),
  // A later writer publishes the real branch from seq 3 and then crashes.
  event('assistant/chunk', 3, {
    turn: 1,
    step: 1,
    chunk: { type: 'text-delta', index: 0, text: 'after' },
  }),
]

const jsonl = [header, ...physicalRows].map(value => JSON.stringify(value)).join('\n') + '\n'
const repaired = repairSessionLogBytes('session.jsonl', Buffer.from(jsonl))

assert.equal(repaired.report.repairable, true)
assert.equal(repaired.report.originalEventCount, 6)
assert.equal(repaired.report.repairedEventCount, 6)
assert.deepEqual(repaired.report.branchRewinds, [{ fromSeq: 3, discardedEvents: 2 }])
assert.deepEqual(repaired.report.closersAdded, ['step/end', 'turn/end'])
assert.deepEqual(repaired.events.map(item => item.seq), [0, 1, 2, 3, 4, 5])
assert.equal(repaired.events[3]?.type, 'assistant/chunk')
assert.equal(repaired.events[4]?.type, 'step/end')
assert.equal(repaired.events[5]?.type, 'turn/end')

console.log('session repair regression passed')
