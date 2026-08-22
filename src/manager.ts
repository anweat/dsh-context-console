/**
 * Inventory manager: reads live registries, applies dynamic add/remove,
 * persists the manifest, and restores managed items on plugin activation.
 */
import { randomUUID } from 'node:crypto'
import type { Storage, ManagedPrompt, ManagedSkill, ManagedMcp, InsertionMode } from './storage.ts'
import { readPromptEntries, readSkillEntries, readMcpEntries, readToolEntries, readSessionlogToolEntries } from './registry.ts'
import type { Category, InventoryItem, InventorySnapshot } from './shared-types.ts'

interface ManagerCtx {
  systemPrompt?: {
    section(input: { name: string; order: number; text: string; complete?: boolean }): () => void
    context(input: { name: string; order: number; text: string }): () => void
    assemble(context?: any): Promise<{
      sections: Array<{ name: string; text: string }>
      contexts: Array<{ name: string; text: string }>
      tools: Array<{ name: string; description: string }>
      variables: Record<string, unknown>
    }>
  }
  skills?: {
    list(options?: any): Promise<Array<{ name: string; description: string; source: string; provider: string; invocation?: { modelInvocable: boolean; userInvocable: boolean } }>>
    register(skill: {
      name: string
      description: string
      content: string
      invocation?: { modelInvocable: boolean; userInvocable: boolean }
    }): () => void
  }
  tools?: {
    schemas(scope?: any): Array<{ name: string; description: string }>
  }
  loader?: {
    create(options: { name: string; config: Record<string, any> }): Promise<string>
    remove(id: string): Promise<void>
    entries(): Iterable<{ options: { name?: string; id?: string; config?: Record<string, any> }; disabled?: boolean }>
  }
  sessions?: {
    get(id: string): any
  }
  on(event: string, listener: (...args: any[]) => any): () => void
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void }
}

export class Manager {
  private promptDisposers = new Map<string, () => void>()
  private skillDisposers = new Map<string, () => void>()
  private mcpDisposers = new Map<string, () => void>()
  private hiddenFilterDispose: (() => void) | undefined

  constructor(private readonly storage: Storage) {}

  private manifest(): ReturnType<Storage['loadManifest']> {
    return this.storage.loadManifest()
  }

  private save(manifest: ReturnType<Storage['loadManifest']>): void {
    this.storage.saveManifest(manifest)
  }

  async restore(ctx: ManagerCtx): Promise<void> {
    const manifest = this.manifest()
    for (const prompt of manifest.prompts) {
      if (!prompt.enabled) continue
      try {
        this.promptDisposers.set(prompt.id, this.registerPrompt(ctx, prompt))
      } catch (error) {
        ctx.logger?.warn?.(`[dsh-context-console] restore prompt ${prompt.name} failed: ${String(error)}`)
      }
    }
    for (const skill of manifest.skills) {
      if (!skill.enabled) continue
      try {
        this.skillDisposers.set(skill.id, this.registerSkill(ctx, skill))
      } catch (error) {
        ctx.logger?.warn?.(`[dsh-context-console] restore skill ${skill.name} failed: ${String(error)}`)
      }
    }
    for (const mcp of manifest.mcps) {
      if (!mcp.enabled) continue
      try {
        const id = await this.registerMcp(ctx, mcp)
        this.mcpDisposers.set(mcp.id, id)
      } catch (error) {
        ctx.logger?.warn?.(`[dsh-context-console] restore mcp ${mcp.serverName} failed: ${String(error)}`)
      }
    }
    this.installHiddenToolsFilter(ctx, manifest.hiddenTools)
  }

  dispose(): void {
    for (const dispose of this.promptDisposers.values()) {
      try { dispose() } catch { /* ignore */ }
    }
    for (const dispose of this.skillDisposers.values()) {
      try { dispose() } catch { /* ignore */ }
    }
    for (const dispose of this.mcpDisposers.values()) {
      try { void dispose() } catch { /* ignore */ }
    }
    this.promptDisposers.clear()
    this.skillDisposers.clear()
    this.mcpDisposers.clear()
    this.hiddenFilterDispose?.()
    this.hiddenFilterDispose = undefined
  }

  private registerPrompt(ctx: ManagerCtx, prompt: ManagedPrompt): () => void {
    if (ctx.systemPrompt === undefined) throw new Error('systemPrompt service is not mounted')
    const name = `context-console:${prompt.name}`
    if (prompt.insertion === 'system-prefix' || prompt.kind === 'section') {
      return ctx.systemPrompt.section({ name, order: prompt.order, text: prompt.text })
    }
    return ctx.systemPrompt.context({ name, order: prompt.order, text: prompt.text })
  }

  private registerSkill(ctx: ManagerCtx, skill: ManagedSkill): () => void {
    if (ctx.skills === undefined) throw new Error('skills service is not mounted')
    return ctx.skills.register({
      name: skill.name,
      description: skill.description,
      content: skill.content,
      invocation: { modelInvocable: skill.modelInvocable, userInvocable: skill.userInvocable },
    })
  }

  private async registerMcp(ctx: ManagerCtx, mcp: ManagedMcp): Promise<() => void> {
    if (ctx.loader === undefined) throw new Error('loader service is not mounted')
    const config: Record<string, any> = {
      serverName: mcp.serverName,
      transport: mcp.transport,
    }
    if (mcp.transport === 'stdio') {
      if (mcp.command === undefined) throw new Error('stdio mcp requires command')
      config.command = mcp.command
      if (mcp.args !== undefined) config.args = mcp.args
      if (mcp.env !== undefined) config.env = mcp.env
      if (mcp.cwd !== undefined) config.cwd = mcp.cwd
    } else {
      if (mcp.url === undefined) throw new Error('streamable-http mcp requires url')
      config.url = mcp.url
      if (mcp.headers !== undefined) config.headers = mcp.headers
    }
    const entryId = await ctx.loader.create({ name: '@deepseek-ai/dsh-mcp-client', config })
    return () => { void ctx.loader?.remove(entryId) }
  }

  private installHiddenToolsFilter(ctx: ManagerCtx, hiddenTools: string[]): void {
    this.hiddenFilterDispose?.()
    const hidden = new Set(hiddenTools)
    this.hiddenFilterDispose = ctx.on('system-prompt/assemble', (assembly: any, _context: any, next: () => Promise<any>) => {
      if (hidden.size > 0 && Array.isArray(assembly?.tools)) {
        assembly.tools = assembly.tools.filter((tool: { name: string }) => !hidden.has(tool.name))
      }
      return next()
    })
  }

  async inventory(ctx: ManagerCtx, sessionId?: string): Promise<InventorySnapshot> {
    const manifest = this.manifest()
    const session = sessionId === undefined ? undefined : ctx.sessions?.get(sessionId)
    const toolEntries = session !== undefined
      ? readSessionlogToolEntries(session)
      : readToolEntries(ctx as any)
    const [prompt, skills, mcps, tools] = await Promise.all([
      readPromptEntries(ctx as any),
      readSkillEntries(ctx as any),
      Promise.resolve(readMcpEntries(ctx as any)),
      Promise.resolve(toolEntries),
    ])

    // Keep known tool names current so hidden tools stay visible in the available column.
    const toolNames = tools.map(tool => tool.name)
    const knownSet = new Set([...manifest.knownTools, ...toolNames])
    const knownChanged = knownSet.size !== manifest.knownTools.length
      || manifest.knownTools.some(name => !knownSet.has(name))
    if (knownChanged) {
      manifest.knownTools = [...knownSet].sort()
      this.save(manifest)
    }

    const promptActive: InventoryItem[] = [
      ...prompt.sections
        .filter(section => !section.name.startsWith('context-console:'))
        .map((section, index) => ({
        id: `builtin:section:${section.name}`,
        category: 'prompt' as Category,
        name: section.name,
        description: section.text.slice(0, 120),
        source: 'builtin' as const,
        state: 'active' as const,
        insertion: 'system-prefix' as InsertionMode,
        cacheImpact: 'prefix-destructive' as const,
        meta: { kind: 'section', order: section.order, text: section.text },
      })),
      ...prompt.contexts
        .filter(context => !context.name.startsWith('context-console:'))
        .map((context, index) => ({
        id: `builtin:context:${context.name}`,
        category: 'prompt' as Category,
        name: context.name,
        description: context.text.slice(0, 120),
        source: 'builtin' as const,
        state: 'active' as const,
        insertion: 'tail' as InsertionMode,
        cacheImpact: 'none' as const,
        meta: { kind: 'context', order: context.order, text: context.text },
      })),
      ...manifest.prompts.filter(p => p.enabled).map(prompt => ({
        id: `custom:prompt:${prompt.id}`,
        category: 'prompt' as Category,
        name: prompt.name,
        description: prompt.text.slice(0, 120),
        source: 'custom' as const,
        state: 'active' as const,
        insertion: prompt.insertion,
        cacheImpact: (prompt.insertion === 'system-prefix' ? 'prefix-destructive' : 'none') as 'none' | 'prefix-destructive',
        meta: { kind: prompt.kind, order: prompt.order, text: prompt.text, managedId: prompt.id },
      })),
    ]

    const promptAvailable: InventoryItem[] = [
      ...manifest.promptTemplates.map(template => ({
        id: `template:prompt:${template.id}`,
        category: 'prompt' as Category,
        name: template.name,
        description: template.description,
        source: 'template' as const,
        state: 'available' as const,
        insertion: 'tail' as InsertionMode,
        cacheImpact: 'none' as const,
        meta: { templateId: template.id, text: template.text },
      })),
      ...manifest.prompts.filter(p => !p.enabled).map(prompt => ({
        id: `custom:prompt:${prompt.id}`,
        category: 'prompt' as Category,
        name: prompt.name,
        description: prompt.text.slice(0, 120),
        source: 'custom' as const,
        state: 'available' as const,
        insertion: prompt.insertion,
        cacheImpact: (prompt.insertion === 'system-prefix' ? 'prefix-destructive' : 'none') as 'none' | 'prefix-destructive',
        meta: { kind: prompt.kind, order: prompt.order, text: prompt.text, managedId: prompt.id },
      })),
    ]

    const skillActive: InventoryItem[] = [
      ...skills.map(skill => ({
        id: `discovered:skill:${skill.name}`,
        category: 'skill' as Category,
        name: skill.name,
        description: skill.description,
        source: 'discovered' as const,
        state: 'active' as const,
        insertion: 'tail' as InsertionMode,
        cacheImpact: 'none' as const,
        meta: { source: skill.source, provider: skill.provider },
      })),
      ...manifest.skills.filter(s => s.enabled).map(skill => ({
        id: `custom:skill:${skill.id}`,
        category: 'skill' as Category,
        name: skill.name,
        description: skill.description,
        source: 'custom' as const,
        state: 'active' as const,
        insertion: 'tail' as InsertionMode,
        cacheImpact: 'none' as const,
        meta: { managedId: skill.id, content: skill.content },
      })),
    ]

    const skillAvailable: InventoryItem[] = [
      ...manifest.skillTemplates.map(template => ({
        id: `template:skill:${template.id}`,
        category: 'skill' as Category,
        name: template.name,
        description: template.description,
        source: 'template' as const,
        state: 'available' as const,
        insertion: 'tail' as InsertionMode,
        cacheImpact: 'none' as const,
        meta: { templateId: template.id, content: template.content },
      })),
      ...manifest.skills.filter(s => !s.enabled).map(skill => ({
        id: `custom:skill:${skill.id}`,
        category: 'skill' as Category,
        name: skill.name,
        description: skill.description,
        source: 'custom' as const,
        state: 'available' as const,
        insertion: 'tail' as InsertionMode,
        cacheImpact: 'none' as const,
        meta: { managedId: skill.id, content: skill.content },
      })),
    ]

    const mcpActive: InventoryItem[] = [
      ...mcps.filter(m => m.running).map(mcp => ({
        id: `mcp:${mcp.serverName}`,
        category: 'mcp' as Category,
        name: mcp.serverName,
        description: `${mcp.toolCount} tools · ${mcp.transport ?? 'unknown transport'}`,
        source: 'builtin' as const,
        state: 'active' as const,
        insertion: 'tail' as InsertionMode,
        cacheImpact: 'prefix-destructive' as const,
        meta: { serverName: mcp.serverName, toolCount: mcp.toolCount, transport: mcp.transport },
      })),
      ...manifest.mcps.filter(m => m.enabled).map(mcp => ({
        id: `custom:mcp:${mcp.id}`,
        category: 'mcp' as Category,
        name: mcp.serverName,
        description: `${mcp.transport}${mcp.transport === 'stdio' ? ` · ${mcp.command ?? ''}` : ` · ${mcp.url ?? ''}`}`,
        source: 'custom' as const,
        state: 'active' as const,
        insertion: 'tail' as InsertionMode,
        cacheImpact: 'prefix-destructive' as const,
        meta: { managedId: mcp.id, ...mcp },
      })),
    ]

    const mcpAvailable: InventoryItem[] = [
      ...manifest.mcpTemplates.map(template => ({
        id: `template:mcp:${template.id}`,
        category: 'mcp' as Category,
        name: template.serverName,
        description: `${template.transport}${template.transport === 'stdio' ? ` · ${template.command ?? ''}` : ` · ${template.url ?? ''}`}`,
        source: 'template' as const,
        state: 'available' as const,
        insertion: 'tail' as InsertionMode,
        cacheImpact: 'prefix-destructive' as const,
        meta: { templateId: template.id, ...template },
      })),
      ...manifest.mcps.filter(m => !m.enabled).map(mcp => ({
        id: `custom:mcp:${mcp.id}`,
        category: 'mcp' as Category,
        name: mcp.serverName,
        description: `${mcp.transport}${mcp.transport === 'stdio' ? ` · ${mcp.command ?? ''}` : ` · ${mcp.url ?? ''}`}`,
        source: 'custom' as const,
        state: 'available' as const,
        insertion: 'tail' as InsertionMode,
        cacheImpact: 'prefix-destructive' as const,
        meta: { managedId: mcp.id, ...mcp },
      })),
    ]

    const toolActive: InventoryItem[] = tools.map(tool => ({
      id: `tool:${tool.name}`,
      category: 'tools' as Category,
      name: tool.name,
      description: tool.description,
      source: 'builtin' as const,
      state: 'active' as const,
      insertion: 'tail' as InsertionMode,
      cacheImpact: 'prefix-destructive' as const,
      meta: { name: tool.name, parameters: tool.parameters },
    }))

    const toolAvailable: InventoryItem[] = [
      ...manifest.knownTools
        .filter(name => !toolNames.includes(name))
        .map(name => ({
          id: `tool:${name}`,
          category: 'tools' as Category,
          name,
          description: 'Hidden or previously known tool',
          source: 'builtin' as const,
          state: 'available' as const,
          insertion: 'tail' as InsertionMode,
          cacheImpact: 'prefix-destructive' as const,
          meta: { name },
        })),
      ...manifest.hiddenTools
        .filter(name => toolNames.includes(name))
        .map(name => ({
          id: `tool:${name}`,
          category: 'tools' as Category,
          name,
          description: 'Currently hidden by context console',
          source: 'builtin' as const,
          state: 'available' as const,
          insertion: 'tail' as InsertionMode,
          cacheImpact: 'prefix-destructive' as const,
          meta: { name },
        })),
    ]

    return {
      categories: {
        prompt: { available: promptAvailable, active: promptActive },
        skill: { available: skillAvailable, active: skillActive },
        mcp: { available: mcpAvailable, active: mcpActive },
        tools: { available: toolAvailable, active: toolActive },
      },
    }
  }

  async activate(ctx: ManagerCtx, category: Category, id: string): Promise<void> {
    const manifest = this.manifest()
    if (category === 'prompt') {
      const template = manifest.promptTemplates.find(item => `template:prompt:${item.id}` === id)
      if (template !== undefined) {
        const prompt: ManagedPrompt = {
          id: randomUUID(),
          name: template.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || `prompt-${Date.now()}`,
          order: 10000,
          text: template.text,
          kind: 'context',
          insertion: 'tail',
          enabled: true,
        }
        manifest.prompts.push(prompt)
        this.promptDisposers.set(prompt.id, this.registerPrompt(ctx, prompt))
        this.save(manifest)
        this.storage.addHistory('inventory.activate', undefined, 'prompt', 'activate', { id: prompt.id, name: prompt.name })
        return
      }
      const disabled = manifest.prompts.find(item => `custom:prompt:${item.id}` === id && !item.enabled)
      if (disabled !== undefined) {
        disabled.enabled = true
        this.promptDisposers.set(disabled.id, this.registerPrompt(ctx, disabled))
        this.save(manifest)
        this.storage.addHistory('inventory.activate', undefined, 'prompt', 'activate', { id: disabled.id, name: disabled.name })
        return
      }
      throw new Error(`unknown prompt item "${id}"`)
    }

    if (category === 'skill') {
      const template = manifest.skillTemplates.find(item => `template:skill:${item.id}` === id)
      if (template !== undefined) {
        const skill: ManagedSkill = {
          id: randomUUID(),
          name: template.name,
          description: template.description,
          content: template.content,
          modelInvocable: true,
          userInvocable: true,
          enabled: true,
        }
        manifest.skills.push(skill)
        this.skillDisposers.set(skill.id, this.registerSkill(ctx, skill))
        this.save(manifest)
        this.storage.addHistory('inventory.activate', undefined, 'skill', 'activate', { id: skill.id, name: skill.name })
        return
      }
      const disabled = manifest.skills.find(item => `custom:skill:${item.id}` === id && !item.enabled)
      if (disabled !== undefined) {
        disabled.enabled = true
        this.skillDisposers.set(disabled.id, this.registerSkill(ctx, disabled))
        this.save(manifest)
        this.storage.addHistory('inventory.activate', undefined, 'skill', 'activate', { id: disabled.id, name: disabled.name })
        return
      }
      throw new Error(`unknown skill item "${id}"`)
    }

    if (category === 'mcp') {
      const template = manifest.mcpTemplates.find(item => `template:mcp:${item.id}` === id)
      if (template !== undefined) {
        const mcp: ManagedMcp = {
          id: randomUUID(),
          serverName: template.serverName,
          transport: template.transport,
          command: template.command,
          args: template.args,
          env: template.env,
          cwd: template.cwd,
          url: template.url,
          headers: template.headers,
          enabled: true,
        }
        manifest.mcps.push(mcp)
        this.mcpDisposers.set(mcp.id, await this.registerMcp(ctx, mcp))
        this.save(manifest)
        this.storage.addHistory('inventory.activate', undefined, 'mcp', 'activate', { id: mcp.id, name: mcp.serverName })
        return
      }
      const disabled = manifest.mcps.find(item => `custom:mcp:${item.id}` === id && !item.enabled)
      if (disabled !== undefined) {
        disabled.enabled = true
        this.mcpDisposers.set(disabled.id, await this.registerMcp(ctx, disabled))
        this.save(manifest)
        this.storage.addHistory('inventory.activate', undefined, 'mcp', 'activate', { id: disabled.id, name: disabled.serverName })
        return
      }
      throw new Error(`unknown mcp item "${id}"`)
    }

    if (category === 'tools') {
      const name = id.startsWith('tool:') ? id.slice('tool:'.length) : id
      manifest.hiddenTools = manifest.hiddenTools.filter(item => item !== name)
      if (!manifest.knownTools.includes(name)) manifest.knownTools.push(name)
      this.save(manifest)
      this.installHiddenToolsFilter(ctx, manifest.hiddenTools)
      this.storage.addHistory('inventory.activate', undefined, 'tools', 'activate', { name })
      return
    }

    throw new Error(`unknown category "${category}"`)
  }

  async deactivate(ctx: ManagerCtx, category: Category, id: string): Promise<void> {
    const manifest = this.manifest()
    if (category === 'prompt') {
      const managed = manifest.prompts.find(item => `custom:prompt:${item.id}` === id)
      if (managed === undefined) throw new Error(`not a managed prompt "${id}"`)
      managed.enabled = false
      const dispose = this.promptDisposers.get(managed.id)
      if (dispose !== undefined) {
        try { dispose() } catch { /* ignore */ }
        this.promptDisposers.delete(managed.id)
      }
      this.save(manifest)
      this.storage.addHistory('inventory.deactivate', undefined, 'prompt', 'deactivate', { id: managed.id, name: managed.name })
      return
    }

    if (category === 'skill') {
      const managed = manifest.skills.find(item => `custom:skill:${item.id}` === id)
      if (managed === undefined) throw new Error(`not a managed skill "${id}"`)
      managed.enabled = false
      const dispose = this.skillDisposers.get(managed.id)
      if (dispose !== undefined) {
        try { dispose() } catch { /* ignore */ }
        this.skillDisposers.delete(managed.id)
      }
      this.save(manifest)
      this.storage.addHistory('inventory.deactivate', undefined, 'skill', 'deactivate', { id: managed.id, name: managed.name })
      return
    }

    if (category === 'mcp') {
      const managed = manifest.mcps.find(item => `custom:mcp:${item.id}` === id)
      if (managed === undefined) throw new Error(`not a managed mcp "${id}"`)
      managed.enabled = false
      const dispose = this.mcpDisposers.get(managed.id)
      if (dispose !== undefined) {
        try { await dispose() } catch { /* ignore */ }
        this.mcpDisposers.delete(managed.id)
      }
      this.save(manifest)
      this.storage.addHistory('inventory.deactivate', undefined, 'mcp', 'deactivate', { id: managed.id, name: managed.serverName })
      return
    }

    if (category === 'tools') {
      const name = id.startsWith('tool:') ? id.slice('tool:'.length) : id
      if (!manifest.hiddenTools.includes(name)) manifest.hiddenTools.push(name)
      if (!manifest.knownTools.includes(name)) manifest.knownTools.push(name)
      this.save(manifest)
      this.installHiddenToolsFilter(ctx, manifest.hiddenTools)
      this.storage.addHistory('inventory.deactivate', undefined, 'tools', 'deactivate', { name })
      return
    }

    throw new Error(`unknown category "${category}"`)
  }

  async setInsertion(ctx: ManagerCtx, id: string, insertion: InsertionMode): Promise<void> {
    const manifest = this.manifest()
    const managed = manifest.prompts.find(item => `custom:prompt:${item.id}` === id)
    if (managed === undefined) throw new Error(`not a managed prompt "${id}"`)
    if (managed.insertion === insertion) return
    const wasEnabled = managed.enabled
    if (wasEnabled) {
      const dispose = this.promptDisposers.get(managed.id)
      if (dispose !== undefined) {
        try { dispose() } catch { /* ignore */ }
        this.promptDisposers.delete(managed.id)
      }
    }
    managed.insertion = insertion
    managed.kind = insertion === 'system-prefix' ? 'section' : 'context'
    if (wasEnabled) {
      this.promptDisposers.set(managed.id, this.registerPrompt(ctx, managed))
    }
    this.save(manifest)
    this.storage.addHistory('inventory.move', undefined, 'prompt', 'setInsertion', { id: managed.id, name: managed.name, insertion })
  }
}
