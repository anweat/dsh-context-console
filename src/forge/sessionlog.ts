/** Session-log (session.jsonl / session.jsonl.zstd) decoding and recognition. */
import { zstdDecompressSync } from 'node:zlib'
import {
  decodeStorageRecord, interruptedTurnClosers, Session, SessionId,
} from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {
  AssistantMessage, ContentBlock, TokenUsage, ToolResultMessage, UserMessage,
} from '@deepseek-ai/dsh-llm'
import type {
  RecognizedEntry, SessionLogHeader, SessionLogParseResponse, SessionLogRepairReport,
} from './shared-types.ts'

/** First transport batch of recognized entries per import. */
const MAX_RECOGNIZED = 200
/** Hard decoded-size ceiling to keep a hostile import from exhausting memory. */
const MAX_DECODED_BYTES = 128 * 1024 * 1024

const ZSTD_MAGIC = 0xFD2FB528

interface FrameRange {
  start: number
  end: number
}

/**
 * Locate complete frames in a concatenated Zstandard stream. This is a compact
 * copy of the JSONL persistence backend's scanner; the shared format is its
 * concatenated-frame container.
 */
function scanZstdFrames(buffer: Buffer): FrameRange[] {
  const frames: FrameRange[] = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) break
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) break
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`)
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) break
    offset += remainingHeaderBytes

    for (;;) {
      if (buffer.length - offset < 3) return frames
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return frames
      offset += payloadBytes
      if (lastBlock) break
    }

    if (checksum) {
      if (buffer.length - offset < 4) return frames
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

/** Decode a JSONL or zstd-compressed JSONL byte container to UTF-8 text. */
function decodeLogBytes(buffer: Buffer): { compressed: boolean; text: string } {
  if (buffer.length >= 4 && buffer.readUInt32LE(0) === ZSTD_MAGIC) {
    const frames = scanZstdFrames(buffer)
    if (frames.length === 0) throw new Error('corrupt Zstandard session log: no complete frame')
    const parts: Buffer[] = []
    let total = 0
    for (const frame of frames) {
      const plain = zstdDecompressSync(buffer.subarray(frame.start, frame.end))
      total += plain.length
      if (total > MAX_DECODED_BYTES) {
        throw new Error(`session log expands beyond the ${MAX_DECODED_BYTES / 1024 / 1024} MiB import limit`)
      }
      parts.push(plain)
    }
    return { compressed: true, text: Buffer.concat(parts, total).toString('utf8') }
  }
  if (buffer.length > MAX_DECODED_BYTES) {
    throw new Error(`session log exceeds the ${MAX_DECODED_BYTES / 1024 / 1024} MiB import limit`)
  }
  return { compressed: false, text: buffer.toString('utf8') }
}

/** Internal repair result; events are retained only on the trusted Host side. */
export interface SessionLogRepairResult {
  report: SessionLogRepairReport
  events: SessionEvent[]
}

/**
 * Conservatively reconstruct one logical log from its physical JSONL rows.
 * A later event whose seq rewinds the candidate replaces that candidate suffix
 * (the append-order equivalent of "latest branch wins"). A forward gap or bad
 * row stops consumption; official DSH crash closers then balance the valid
 * prefix. Session.create performs the final sequence and surface validation.
 */
export function repairSessionLogBytes(name: string, bytes: Buffer): SessionLogRepairResult {
  const decoded = decodeLogBytes(bytes)
  const lines = decoded.text.split(/\r?\n/)
  let header: SessionLogHeader | null = null
  let startIndex = 0
  const first = lines[0]?.trim() ?? ''
  if (first !== '') {
    try {
      const parsed: unknown = JSON.parse(first)
      if (typeof parsed === 'object' && parsed !== null && (parsed as { type?: unknown }).type === 'session') {
        header = parsed as SessionLogHeader
        startIndex = 1
      }
    } catch {
      // The report below marks a missing/invalid header as non-repairable.
    }
  }

  const candidate: SessionEvent[] = []
  const branchRewinds: SessionLogRepairReport['branchRewinds'] = []
  let originalEventCount = 0
  let stopped: SessionLogRepairReport['stopped'] = null

  outer: for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? ''
    if (line === '') continue
    let events: SessionEvent[]
    try {
      events = decodeStorageRecord(JSON.parse(line))
    } catch (error) {
      stopped = { line: index + 1, reason: String(error) }
      break
    }
    for (const event of events) {
      originalEventCount += 1
      if (!Number.isSafeInteger(event.seq) || event.seq < 0) {
        stopped = { line: index + 1, reason: `event seq must be a non-negative safe integer, got ${String(event.seq)}` }
        break outer
      }
      if (event.seq > candidate.length) {
        stopped = { line: index + 1, reason: `forward seq gap: expected ${candidate.length}, got ${event.seq}` }
        break outer
      }
      if (event.seq < candidate.length) {
        const discardedEvents = candidate.length - event.seq
        candidate.splice(event.seq)
        branchRewinds.push({ fromSeq: event.seq, discardedEvents })
      }
      candidate.push(event)
    }
  }

  const closers = interruptedTurnClosers(candidate)
  const events = [...candidate, ...closers]
  let validationError: string | null = null
  if (header === null) {
    validationError = 'session header is missing or invalid'
  } else if (events.length === 0) {
    validationError = 'session log has no recoverable events'
  } else {
    try {
      Session.create(SessionId('session-repair-validation'), events)
    } catch (error) {
      validationError = error instanceof Error ? error.message : String(error)
    }
  }

  return {
    report: {
      name,
      compressed: decoded.compressed,
      header,
      originalEventCount,
      repairedEventCount: events.length,
      branchRewinds,
      closersAdded: closers.map(event => event.type),
      stopped,
      repairable: validationError === null,
      validationError,
    },
    events,
  }
}

function joinTextBlocks(content: readonly ContentBlock[], kind: 'text' | 'reasoning'): string {
  const parts: string[] = []
  for (const block of content) {
    if (block.type === kind) parts.push(block.text)
  }
  return parts.join('\n\n')
}

function unsupportedBlockCount(content: readonly ContentBlock[]): number {
  let count = 0
  for (const block of content) {
    if (block.type !== 'text' && block.type !== 'reasoning') count += 1
  }
  return count
}

function entryFor(event: SessionEvent): RecognizedEntry | undefined {
  switch (event.type) {
    case 'assistant/message': {
      const data = event.data as { turn: number; step: number; message: AssistantMessage; usage?: TokenUsage }
      const message = data.message
      const entry: RecognizedEntry = {
        seq: event.seq,
        time: event.time,
        type: event.type,
        role: 'assistant',
        turn: data.turn,
        step: data.step,
        text: joinTextBlocks(message.content, 'text'),
        reasoning: joinTextBlocks(message.content, 'reasoning'),
        provider: message.source.provider,
        model: message.source.model,
      }
      if (data.usage !== undefined) {
        entry.usage = {
          inputTokens: data.usage.inputTokens,
          outputTokens: data.usage.outputTokens,
          ...(data.usage.cacheReadTokens !== undefined ? { cacheReadTokens: data.usage.cacheReadTokens } : {}),
          ...(data.usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: data.usage.cacheWriteTokens } : {}),
          ...(data.usage.reasoningTokens !== undefined ? { reasoningTokens: data.usage.reasoningTokens } : {}),
        }
      }
      const unsupported = unsupportedBlockCount(message.content)
      if (unsupported > 0) entry.unsupportedBlocks = unsupported
      return entry
    }
    case 'user/message': {
      const message = event.data as UserMessage
      return {
        seq: event.seq,
        time: event.time,
        type: event.type,
        role: 'user',
        text: joinTextBlocks(message.content, 'text'),
        reasoning: joinTextBlocks(message.content, 'reasoning'),
      }
    }
    case 'tool/call': {
      const data = event.data as { turn: number; step: number; callId: string; name: string; arguments: string }
      return {
        seq: event.seq,
        time: event.time,
        type: event.type,
        turn: data.turn,
        step: data.step,
        callId: data.callId,
        toolName: data.name,
        toolArguments: data.arguments,
      }
    }
    case 'tool/result': {
      const data = event.data as {
        turn: number
        step: number
        message: ToolResultMessage
        error?: { name: string; code: string }
      }
      const block = data.message.content[0]
      const resultBlocks = block !== undefined && block.type === 'tool-result' ? block.content : []
      return {
        seq: event.seq,
        time: event.time,
        type: event.type,
        turn: data.turn,
        step: data.step,
        callId: data.message.source.callId,
        isError: data.message.content[0]?.type === 'tool-result'
          ? data.message.content[0].isError === true
          : undefined,
        text: joinTextBlocks(resultBlocks, 'text'),
      }
    }
    default:
      return undefined
  }
}

/**
 * Decode and recognize one uploaded session-log byte container. The first
 * JSONL record is treated as the session header when it carries
 * `type: 'session'`; every remaining record is expanded through the session
 * storage-row decoder, so packed `text-chunks` / `reasoning-chunks` /
 * `tool-call-chunks` rows are recognized exactly like the persistence loader.
 */
export function parseSessionLogBytes(name: string, bytes: Buffer): SessionLogParseResponse {
  const decoded = decodeLogBytes(bytes)
  const lines = decoded.text.split(/\r?\n/)
  const recognized: RecognizedEntry[] = []
  const counts: Record<string, number> = {}
  const issueSamples: string[] = []
  let header: SessionLogHeader | null = null
  let totalEvents = 0
  let recognizedTotal = 0
  let parseIssues = 0

  let startIndex = 0
  const first = lines[0]?.trim() ?? ''
  if (first !== '') {
    try {
      const parsed: unknown = JSON.parse(first)
      if (typeof parsed === 'object' && parsed !== null && (parsed as { type?: unknown }).type === 'session') {
        header = parsed as SessionLogHeader
        startIndex = 1
      }
    } catch {
      // Not a header record; the row loop below reports it as an issue.
    }
  }

  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? ''
    if (line === '') continue
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch (error) {
      parseIssues += 1
      if (issueSamples.length < 3) issueSamples.push(`line ${index + 1}: ${String(error)}`)
      continue
    }
    let events: SessionEvent[]
    try {
      events = decodeStorageRecord(record)
    } catch (error) {
      parseIssues += 1
      if (issueSamples.length < 3) issueSamples.push(`line ${index + 1}: ${String(error)}`)
      continue
    }
    for (const event of events) {
      totalEvents += 1
      counts[event.type] = (counts[event.type] ?? 0) + 1
      const entry = entryFor(event)
      if (entry === undefined) continue
      recognizedTotal += 1
      if (recognized.length < MAX_RECOGNIZED) recognized.push(entry)
    }
  }

  return {
    name,
    compressed: decoded.compressed,
    header,
    totalEvents,
    recognizedTotal,
    recognized,
    truncated: recognizedTotal > MAX_RECOGNIZED,
    parseIssues,
    issueSamples,
    counts,
  }
}
