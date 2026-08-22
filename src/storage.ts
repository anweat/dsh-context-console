/**
 * Durable storage for dsh-context-console.
 *
 * Layout:
 *   $DSH_HOME/context-console/
 *     manifest.json          editable state (custom prompts/skills/mcps/hidden tools)
 *     history.sqlite         append-only history + cache event stream
 *
 * The trajectory wall itself is not stored: it is projected live from each
 * session's append-only log. SQLite is used only for the audit/history stream,
 * so it can grow large without turning into an unreadable JSONL file.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { HistoryEntry } from './shared-types.ts'

export type PromptKind = 'section' | 'context'
export type InsertionMode = 'tail' | 'system-prefix'

export interface ManagedPrompt {
  id: string
  name: string
  order: number
  text: string
  kind: PromptKind
  insertion: InsertionMode
  enabled: boolean
}

export interface PromptTemplate {
  id: string
  name: string
  description: string
  text: string
}

export interface ManagedSkill {
  id: string
  name: string
  description: string
  content: string
  modelInvocable: boolean
  userInvocable: boolean
  enabled: boolean
}

export interface SkillTemplate {
  id: string
  name: string
  description: string
  content: string
}

export type McpTransport = 'stdio' | 'streamable-http'

export interface ManagedMcp {
  id: string
  serverName: string
  transport: McpTransport
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  enabled: boolean
}

export interface McpTemplate {
  id: string
  serverName: string
  transport: McpTransport
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
}

export interface Manifest {
  prompts: ManagedPrompt[]
  promptTemplates: PromptTemplate[]
  skills: ManagedSkill[]
  skillTemplates: SkillTemplate[]
  mcps: ManagedMcp[]
  mcpTemplates: McpTemplate[]
  hiddenTools: string[]
  knownTools: string[]
}

export function defaultManifest(): Manifest {
  return {
    prompts: [],
    promptTemplates: [
      {
        id: 'template-concise',
        name: 'Concise Answer',
        description: '要求模型保持简洁、直接回答',
        text: 'Please answer concisely. Do not repeat the question. Use bullet points when helpful.',
      },
      {
        id: 'template-code-review',
        name: 'Code Review Lens',
        description: '以代码审查视角补充上下文',
        text: 'Review the following changes as a senior software engineer. Focus on correctness, edge cases, and maintainability.',
      },
    ],
    skills: [],
    skillTemplates: [
      {
        id: 'template-skill-demo',
        name: 'demo-skill',
        description: 'A minimal managed skill created by context console',
        content: '# demo-skill\n\nUse this skill for demonstrating context-console skill management.',
      },
    ],
    mcps: [],
    mcpTemplates: [
      {
        id: 'template-mcp-filesystem',
        serverName: 'filesystem',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
      },
    ],
    hiddenTools: [],
    knownTools: [],
  }
}

export class Storage {
  readonly dataDir: string
  private readonly manifestFile: string
  private readonly db: DatabaseSync

  constructor(dataDir: string) {
    this.dataDir = dataDir
    this.manifestFile = join(dataDir, 'manifest.json')
    mkdirSync(dataDir, { recursive: true })
    this.db = new DatabaseSync(join(dataDir, 'history.sqlite'))
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        session_id TEXT,
        category TEXT,
        action TEXT,
        payload TEXT
      );
      CREATE TABLE IF NOT EXISTS cache_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        seq INTEGER,
        detail TEXT
      );
    `)
  }

  loadManifest(): Manifest {
    try {
      const raw = readFileSync(this.manifestFile, 'utf8')
      const parsed = JSON.parse(raw) as Partial<Manifest>
      const base = defaultManifest()
      return {
        prompts: Array.isArray(parsed.prompts) ? parsed.prompts : base.prompts,
        promptTemplates: Array.isArray(parsed.promptTemplates) ? parsed.promptTemplates : base.promptTemplates,
        skills: Array.isArray(parsed.skills) ? parsed.skills : base.skills,
        skillTemplates: Array.isArray(parsed.skillTemplates) ? parsed.skillTemplates : base.skillTemplates,
        mcps: Array.isArray(parsed.mcps) ? parsed.mcps : base.mcps,
        mcpTemplates: Array.isArray(parsed.mcpTemplates) ? parsed.mcpTemplates : base.mcpTemplates,
        hiddenTools: Array.isArray(parsed.hiddenTools) ? parsed.hiddenTools : base.hiddenTools,
        knownTools: Array.isArray(parsed.knownTools) ? parsed.knownTools : base.knownTools,
      }
    } catch {
      return defaultManifest()
    }
  }

  saveManifest(manifest: Manifest): void {
    const tmp = `${this.manifestFile}.tmp`
    writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    try {
      renameSync(tmp, this.manifestFile)
    } catch {
      writeFileSync(this.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    }
  }

  addHistory(kind: string, sessionId: string | undefined, category: string | undefined, action: string | undefined, payload: unknown): void {
    try {
      this.db.prepare(
        'INSERT INTO history (ts, kind, session_id, category, action, payload) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(Date.now(), kind, sessionId ?? null, category ?? null, action ?? null, payload === undefined ? null : JSON.stringify(payload))
    } catch (error) {
      // History must never break management actions.
      console.error('[dsh-context-console] addHistory failed:', error)
    }
  }

  listHistory(limit = 200): HistoryEntry[] {
    try {
      const rows = this.db.prepare(
        'SELECT id, ts, kind, session_id, category, action, payload FROM history ORDER BY id DESC LIMIT ?',
      ).all(limit) as Array<Record<string, unknown>>
      return rows.map(row => ({
        id: Number(row.id),
        ts: Number(row.ts),
        kind: String(row.kind),
        sessionId: row.session_id == null ? undefined : String(row.session_id),
        category: row.category == null ? undefined : String(row.category),
        action: row.action == null ? undefined : String(row.action),
        payload: row.payload == null ? undefined : safeJson(row.payload),
      }))
    } catch {
      return []
    }
  }

  clearHistory(): void {
    try {
      this.db.exec('DELETE FROM history')
    } catch {
      // ignore
    }
  }

  countHistory(): number {
    try {
      const row = this.db.prepare('SELECT COUNT(*) AS c FROM history').get() as { c: number }
      return Number(row.c)
    } catch {
      return 0
    }
  }

  addCacheEvent(sessionId: string, kind: string, seq: number | undefined, detail: unknown): void {
    try {
      this.db.prepare(
        'INSERT INTO cache_events (ts, session_id, kind, seq, detail) VALUES (?, ?, ?, ?, ?)',
      ).run(Date.now(), sessionId, kind, seq ?? null, detail === undefined ? null : JSON.stringify(detail))
    } catch (error) {
      console.error('[dsh-context-console] addCacheEvent failed:', error)
    }
  }

  listCacheEvents(sessionId: string | undefined, limit = 200): HistoryEntry[] {
    try {
      const rows = sessionId === undefined
        ? this.db.prepare('SELECT id, ts, session_id, kind, seq, detail FROM cache_events ORDER BY id DESC LIMIT ?').all(limit)
        : this.db.prepare('SELECT id, ts, session_id, kind, seq, detail FROM cache_events WHERE session_id = ? ORDER BY id DESC LIMIT ?').all(sessionId, limit)
      return (rows as Array<Record<string, unknown>>).map(row => ({
        id: Number(row.id),
        ts: Number(row.ts),
        kind: String(row.kind),
        sessionId: String(row.session_id),
        action: 'cache',
        payload: {
          seq: row.seq == null ? undefined : Number(row.seq),
          detail: row.detail == null ? undefined : safeJson(row.detail),
        },
      }))
    } catch {
      return []
    }
  }

  clearCacheEvents(): void {
    try {
      this.db.exec('DELETE FROM cache_events')
    } catch {
      // ignore
    }
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      // ignore
    }
  }
}

function safeJson(value: unknown): unknown {
  try {
    return JSON.parse(String(value)) as unknown
  } catch {
    return String(value)
  }
}
