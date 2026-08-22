/** JSON-file persistence for assistant-message drafts. */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AssistantDraft, AssistantDraftInput } from './shared-types.ts'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const DEFAULT_DATA_DIR = join(DSH_HOME, 'assistant-message-forge')
const DRAFT_FILE = 'drafts.json'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isDraft(value: unknown): value is AssistantDraft {
  if (!isRecord(value)) return false
  return typeof value.id === 'string'
    && typeof value.title === 'string'
    && typeof value.content === 'string'
    && typeof value.reasoning === 'string'
    && typeof value.provider === 'string'
    && typeof value.model === 'string'
    && typeof value.createdAt === 'number'
    && typeof value.updatedAt === 'number'
}

function defaultTitle(content: string, reasoning: string): string {
  const source = content.trim() === '' ? reasoning : content
  const oneLine = source.replace(/\s+/g, ' ').trim()
  return oneLine.slice(0, 60)
}

/**
 * Durable draft list. Writes are synchronous on purpose: the draft file is
 * tiny, and sync writes make concurrent RPC handlers race-free without a lock.
 */
export class DraftStore {
  private readonly drafts = new Map<string, AssistantDraft>()
  private readonly file: string

  constructor(dataDir: string = DEFAULT_DATA_DIR) {
    this.file = join(dataDir, DRAFT_FILE)
    mkdirSync(dirname(this.file), { recursive: true })
    this.load()
  }

  list(): AssistantDraft[] {
    return [...this.drafts.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  save(input: AssistantDraftInput): AssistantDraft {
    const title = input.title ?? ''
    const content = input.content ?? ''
    const reasoning = input.reasoning ?? ''
    if (content.trim() === '' && reasoning.trim() === '') {
      throw new Error('draft must have visible content or reasoning text')
    }
    const provider = (input.provider ?? 'test').trim() || 'test'
    const model = (input.model ?? 'test-assistant').trim() || 'test-assistant'
    const existing = input.id === undefined ? undefined : this.drafts.get(input.id)
    const now = Date.now()
    const draft: AssistantDraft = {
      id: input.id ?? randomUUID(),
      title: title.trim() === '' ? defaultTitle(content, reasoning) : title.trim(),
      content,
      reasoning,
      provider,
      model,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    this.drafts.set(draft.id, draft)
    this.persist()
    return draft
  }

  delete(id: string): boolean {
    const removed = this.drafts.delete(id)
    if (removed) this.persist()
    return removed
  }

  private load(): void {
    let raw: string
    try {
      raw = readFileSync(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (raw.trim() === '') return
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new Error(`assistant-message-forge: corrupt draft store ${this.file}: ${String(error)}`)
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.drafts)) return
    for (const value of parsed.drafts) {
      if (isDraft(value)) this.drafts.set(value.id, value)
    }
  }

  private persist(): void {
    const body = `${JSON.stringify({ drafts: this.list() }, null, 2)}\n`
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, body, 'utf8')
    try {
      renameSync(tmp, this.file)
    } catch {
      // Windows rename over an existing file can fail under AV scanners;
      // a direct write is the accepted fallback for this small file.
      writeFileSync(this.file, body, 'utf8')
    }
  }
}
