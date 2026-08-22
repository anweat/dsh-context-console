/**
 * Live registry readers.
 *
 * These functions read the current DSH context registries and return plain
 * data suitable for the inventory UI. They intentionally do not mutate state.
 */
export interface PromptEntry {
  name: string
  text: string
  order: number
  kind: 'section' | 'context'
}

export interface SkillEntry {
  name: string
  description: string
  source: string
  provider: string
  modelInvocable: boolean
  userInvocable: boolean
}

export interface McpEntry {
  serverName: string
  toolCount: number
  transport?: string
  running: boolean
}

export interface ToolEntry {
  name: string
  description: string
  parameters?: unknown
}

interface CtxLike {
  systemPrompt?: {
    assemble(context?: any): Promise<{
      sections: Array<{ name: string; text: string }>
      contexts: Array<{ name: string; text: string }>
      tools: Array<{ name: string; description: string; parameters?: unknown }>
      variables: Record<string, unknown>
    }>
  }
  skills?: {
    list(options?: any): Promise<Array<{
      name: string
      description: string
      source: string
      provider: string
      invocation: { modelInvocable: boolean; userInvocable: boolean }
    }>>
  }
  tools?: {
    schemas(scope?: any): Array<{ name: string; description: string; parameters?: unknown }>
  }
  loader?: {
    entries(): Iterable<{ options: { name?: string; id?: string; config?: Record<string, any> }; disabled?: boolean }>
  }
}

export async function readPromptEntries(ctx: CtxLike): Promise<{ sections: PromptEntry[]; contexts: PromptEntry[] }> {
  const sys = ctx.systemPrompt
  if (sys === undefined) return { sections: [], contexts: [] }
  const assembly = await sys.assemble()
  return {
    sections: assembly.sections.map((section, index) => ({
      name: section.name,
      text: section.text,
      order: index,
      kind: 'section',
    })),
    contexts: assembly.contexts.map((context, index) => ({
      name: context.name,
      text: context.text,
      order: index,
      kind: 'context',
    })),
  }
}

export async function readSkillEntries(ctx: CtxLike): Promise<SkillEntry[]> {
  const skills = ctx.skills
  if (skills === undefined) return []
  try {
    const list = await skills.list()
    return list.map(skill => ({
      name: skill.name,
      description: skill.description,
      source: skill.source,
      provider: skill.provider,
      modelInvocable: skill.invocation?.modelInvocable ?? true,
      userInvocable: skill.invocation?.userInvocable ?? true,
    }))
  } catch {
    return []
  }
}

export function readMcpEntries(ctx: CtxLike): McpEntry[] {
  const result: McpEntry[] = []
  const loader = ctx.loader
  const seen = new Set<string>()
  if (loader !== undefined) {
    for (const entry of loader.entries()) {
      const name = entry.options?.name ?? ''
      const config = entry.options?.config ?? {}
      if (typeof name === 'string' && (name.includes('mcp-client') || config.transport !== undefined)) {
        const serverName = String(config.serverName ?? entry.options?.id ?? 'unknown')
        if (!seen.has(serverName)) {
          seen.add(serverName)
          result.push({
            serverName,
            toolCount: 0,
            transport: config.transport,
            running: !entry.disabled,
          })
        }
      }
    }
  }
  const tools = ctx.tools?.schemas() ?? []
  for (const tool of tools) {
    if (tool.name.startsWith('mcp__')) {
      const parts = tool.name.split('__')
      if (parts.length >= 3) {
        const serverName = parts[1] ?? 'unknown'
        const existing = result.find(entry => entry.serverName === serverName)
        if (existing !== undefined) existing.toolCount += 1
        else {
          result.push({ serverName, toolCount: 1, running: true })
          seen.add(serverName)
        }
      }
    }
  }
  return result
}

export function readToolEntries(ctx: CtxLike): ToolEntry[] {
  const tools = ctx.tools
  if (tools === undefined) return []
  return tools.schemas().map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }))
}

export function readSessionlogToolEntries(session: any): ToolEntry[] {
  const counts = new Map<string, number>()
  for (const event of session?.events ?? []) {
    if (event?.type === 'tool/call') {
      const name = event.data?.name
      if (typeof name === 'string') counts.set(name, (counts.get(name) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({
      name,
      description: `seen in sessionlog ${count} time(s)`,
      parameters: undefined,
    }))
}
