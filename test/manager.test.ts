import test from 'node:test'
import assert from 'node:assert/strict'
import { Manager } from '../src/manager.ts'
import { defaultManifest } from '../src/storage.ts'

test('managed prompts enter the host template as opaque variable values', async () => {
  const original = 'Keep {{name}} and ${{ steps.example }} literal.'
  const manifest = defaultManifest()
  manifest.prompts.push({
    id: 'prompt-1',
    name: 'literal-example',
    order: 100,
    text: original,
    kind: 'section',
    insertion: 'system-prefix',
    enabled: true,
  })

  const variables: Array<{ name: string; provider: () => string | undefined }> = []
  const sections: Array<{ name: string; order: number; text: string }> = []
  let disposedVariables = 0
  let disposedSections = 0
  const manager = new Manager({ loadManifest: () => manifest } as never)

  await manager.restore({
    systemPrompt: {
      variable(name: string, provider: () => string | undefined) {
        variables.push({ name, provider })
        return () => { disposedVariables++ }
      },
      section(section: { name: string; order: number; text: string }) {
        sections.push(section)
        return () => { disposedSections++ }
      },
      context() { throw new Error('unexpected context registration') },
    },
    on() { return () => undefined },
  } as never)

  assert.equal(variables.length, 1)
  assert.equal(sections.length, 1)
  assert.equal(variables[0]?.provider(), original)
  assert.match(sections[0]?.text ?? '', /^\{\{context_console_prompt_[a-z0-9_]+\}\}$/)
  assert.doesNotMatch(sections[0]?.text ?? '', /\{\{name\}\}/)

  manager.dispose()
  assert.equal(disposedSections, 1)
  assert.equal(disposedVariables, 1)
})
