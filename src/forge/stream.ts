/** Construct a compact V3 Assistant stream for an explicitly synthetic message. */
import type { AssistantStreamRecord } from '@deepseek-ai/dsh-llm'

/**
 * Encode the text and reasoning blocks emitted by Context Console as one compact stream.
 * @param reasoning - synthetic reasoning text, or an empty string.
 * @param text - synthetic visible text.
 * @param time - event timestamp used for the first member of each packed run.
 * @returns compact stream records whose assembled content matches the synthetic message.
 */
export function syntheticAssistantStream(reasoning: string, text: string, time = Date.now()): AssistantStreamRecord[] {
  const records: AssistantStreamRecord[] = []
  let index = 0
  if (reasoning !== '') {
    records.push({ type: 'reasoning-chunks', time0: time, index, dt: [], texts: [reasoning] })
    index += 1
  }
  records.push({ type: 'text-chunks', time0: time, index, dt: [], texts: [text] })
  return records
}
