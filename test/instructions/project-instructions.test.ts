import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  loadProjectInstructions,
  type ProjectInstructions,
} from '../../src/instructions/project-instructions.ts'
import type { PortalAgentInstructionsConfig } from '../../src/config/portal-config.ts'

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-instructions-'))
  await mkdir(path.join(root, '.git'))
  return root
}

async function writeText(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, content, 'utf8')
}

async function load(
  cwd: string,
  config: { claudeCode: boolean; codex: boolean } = {
    claudeCode: true,
    codex: true,
  },
  homeDirectory?: string
): Promise<{ instructions: ProjectInstructions; warnings: string[] }> {
  const normalized: PortalAgentInstructionsConfig = {
    claude: { global: false, local: config.claudeCode },
    codex: { global: false, local: config.codex },
  }
  const result = await loadProjectInstructions({
    cwd,
    config: normalized,
    ...(homeDirectory === undefined ? {} : { homeDirectory }),
  })
  return {
    instructions: result.instructions,
    warnings: result.warnings.map(({ message }) => message),
  }
}

function createConfig(
  options: {
    claudeGlobal?: boolean
    claudeLocal?: boolean
    codexGlobal?: boolean
    codexLocal?: boolean
  } = {}
): PortalAgentInstructionsConfig {
  return {
    claude: {
      global: options.claudeGlobal ?? false,
      local: options.claudeLocal ?? true,
    },
    codex: {
      global: options.codexGlobal ?? false,
      local: options.codexLocal ?? true,
    },
  }
}

test('loads Codex hierarchy and Claude imports in deterministic order', async () => {
  const root = await createWorkspace()
  const nested = path.join(root, 'packages', 'app')
  try {
    await writeText(path.join(root, 'AGENTS.md'), 'root agent')
    await writeText(path.join(nested, 'AGENTS.md'), 'nested agent')
    await writeText(path.join(root, 'CLAUDE.md'), '@AGENTS.md\nclaude root')
    await writeText(path.join(nested, 'CLAUDE.local.md'), 'claude local')

    const { instructions, warnings } = await load(nested)
    const prompt = instructions.prompt ?? ''
    assert.deepEqual(warnings, [])
    assert.ok(prompt.indexOf('root agent') < prompt.indexOf('nested agent'))
    assert.ok(prompt.indexOf('nested agent') < prompt.indexOf('claude root'))
    assert.ok(prompt.indexOf('claude root') < prompt.indexOf('claude local'))
    assert.equal(prompt.match(/root agent/g)?.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('loadProjectInstructions applies configured file limits', async () => {
  const root = await createWorkspace()
  const nested = path.join(root, 'nested')
  try {
    await writeText(path.join(root, 'AGENTS.md'), 'root instructions')
    await writeText(path.join(nested, 'AGENTS.md'), 'nested instructions')
    const result = await loadProjectInstructions({
      cwd: nested,
      config: createConfig({ claudeLocal: false }),
      limits: {
        codexMaxBytes: 1024,
        claudeMaxBytes: 1024,
        maxFiles: 1,
        maxImportDepth: 1,
      },
    })

    assert.match(result.instructions.prompt ?? '', /root instructions/)
    assert.doesNotMatch(result.instructions.prompt ?? '', /nested instructions/)
    assert.match(result.warnings[0]?.message ?? '', /1-file limit/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Codex override selects one file and suppresses AGENTS.md', async () => {
  const root = await createWorkspace()
  const nested = path.join(root, 'nested')
  try {
    await writeText(path.join(root, 'AGENTS.md'), 'root agent')
    await writeText(path.join(nested, 'AGENTS.override.md'), 'override agent')
    await writeText(path.join(nested, 'AGENTS.md'), 'ordinary agent')

    const { instructions } = await load(nested, {
      claudeCode: false,
      codex: true,
    })
    const prompt = instructions.prompt ?? ''
    assert.match(prompt, /root agent/)
    assert.match(prompt, /override agent/)
    assert.doesNotMatch(prompt, /ordinary agent/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('disabled instruction sources do not enter the prompt', async () => {
  const root = await createWorkspace()
  try {
    await writeText(path.join(root, 'AGENTS.md'), 'codex only')
    await writeText(path.join(root, 'CLAUDE.md'), 'claude only')

    const claudeOnly = await load(root, { claudeCode: true, codex: false })
    assert.match(claudeOnly.instructions.prompt ?? '', /claude only/)
    assert.doesNotMatch(claudeOnly.instructions.prompt ?? '', /codex only/)

    const codexOnly = await load(root, { claudeCode: false, codex: true })
    assert.match(codexOnly.instructions.prompt ?? '', /codex only/)
    assert.doesNotMatch(codexOnly.instructions.prompt ?? '', /claude only/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('loads enabled global Claude and Codex instructions before local rules', async () => {
  const root = await createWorkspace()
  const home = await mkdtemp(
    path.join(os.tmpdir(), 'portal-instructions-home-')
  )
  try {
    await writeText(path.join(home, '.codex', 'AGENTS.md'), 'global codex')
    await writeText(path.join(home, '.claude', 'CLAUDE.md'), 'global claude')
    await writeText(
      path.join(home, '.claude', 'rules', 'global.md'),
      'global Claude rule'
    )
    await writeText(path.join(root, 'AGENTS.md'), 'local codex')
    await writeText(path.join(root, 'CLAUDE.md'), 'local claude')

    const result = await loadProjectInstructions({
      cwd: root,
      homeDirectory: home,
      config: createConfig({ claudeGlobal: true, codexGlobal: true }),
    })
    const prompt = result.instructions.prompt ?? ''

    assert.deepEqual(result.warnings, [])
    assert.ok(prompt.indexOf('global codex') < prompt.indexOf('global claude'))
    assert.match(prompt, /global Claude rule/)
    assert.ok(prompt.indexOf('global claude') < prompt.indexOf('local codex'))
    assert.ok(prompt.indexOf('local codex') < prompt.indexOf('local claude'))
    assert.match(prompt, /## Codex \(global\): AGENTS\.md/)
    assert.match(prompt, /## Claude Code \(global\): CLAUDE\.md/)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
})

test('global and local instruction switches are independent', async () => {
  const root = await createWorkspace()
  const home = await mkdtemp(
    path.join(os.tmpdir(), 'portal-instructions-home-')
  )
  try {
    await writeText(path.join(home, '.codex', 'AGENTS.md'), 'global codex')
    await writeText(path.join(home, '.claude', 'CLAUDE.md'), 'global claude')
    await writeText(path.join(root, 'AGENTS.md'), 'local codex')
    await writeText(path.join(root, 'CLAUDE.md'), 'local claude')

    const globalOnly = await loadProjectInstructions({
      cwd: root,
      homeDirectory: home,
      config: createConfig({
        claudeGlobal: true,
        claudeLocal: false,
        codexGlobal: true,
        codexLocal: false,
      }),
    })
    assert.match(globalOnly.instructions.prompt ?? '', /global codex/)
    assert.match(globalOnly.instructions.prompt ?? '', /global claude/)
    assert.doesNotMatch(
      globalOnly.instructions.prompt ?? '',
      /local codex|local claude/
    )

    const localOnly = await loadProjectInstructions({
      cwd: root,
      homeDirectory: home,
      config: createConfig(),
    })
    assert.match(
      localOnly.instructions.prompt ?? '',
      /local codex|local claude/
    )
    assert.doesNotMatch(
      localOnly.instructions.prompt ?? '',
      /global codex|global claude/
    )
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
})

test('activates global path rules for project tool targets', async () => {
  const root = await createWorkspace()
  const home = await mkdtemp(
    path.join(os.tmpdir(), 'portal-instructions-home-')
  )
  try {
    await writeText(
      path.join(home, '.claude', 'rules', 'typescript.md'),
      [
        '---',
        'paths:',
        '  - "src/**/*.ts"',
        '---',
        'global TypeScript rule',
      ].join('\n')
    )
    const { instructions } = await loadProjectInstructions({
      cwd: root,
      homeDirectory: home,
      config: createConfig({ claudeGlobal: true, claudeLocal: false }),
    })
    assert.doesNotMatch(instructions.prompt ?? '', /global TypeScript rule/)

    const activation = await instructions.activateForToolCall({
      tool: 'apply_patch',
      params: [
        '*** Begin Patch',
        '*** Add File: src/example.ts',
        '+export const value = 1',
        '*** End Patch',
      ].join('\n'),
    })
    assert.match(activation.prompt ?? '', /global TypeScript rule/)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
})

test('global imports stay inside the configured global directory', async () => {
  const root = await createWorkspace()
  const home = await mkdtemp(
    path.join(os.tmpdir(), 'portal-instructions-home-')
  )
  try {
    await writeText(path.join(home, 'outside.md'), 'outside global secret')
    await writeText(
      path.join(home, '.claude', 'secret.md'),
      'cross-root global secret'
    )
    await writeText(
      path.join(home, '.claude', 'CLAUDE.md'),
      '@../outside.md\nglobal claude'
    )
    await writeText(path.join(root, 'CLAUDE.md'), '@~/.claude/secret.md')

    const result = await loadProjectInstructions({
      cwd: root,
      homeDirectory: home,
      config: createConfig({ claudeGlobal: true, claudeLocal: true }),
    })
    const prompt = result.instructions.prompt ?? ''

    assert.doesNotMatch(prompt, /outside global secret/)
    assert.doesNotMatch(prompt, /cross-root global secret/)
    assert.match(prompt, /global claude/)
    assert.ok(
      result.warnings.some((warning) =>
        /outside the workspace or configured global roots/.test(warning.message)
      )
    )
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
})

test('activates Claude path rules and nested instructions before a patch', async () => {
  const root = await createWorkspace()
  try {
    await writeText(
      path.join(root, '.claude', 'rules', 'typescript.md'),
      ['---', 'paths:', '  - "src/**/*.ts"', '---', 'typescript rule'].join(
        '\n'
      )
    )
    await writeText(path.join(root, 'src', 'AGENTS.md'), 'src agent')
    await writeText(path.join(root, 'src', 'CLAUDE.md'), 'src claude')

    const { instructions } = await load(root, {
      claudeCode: true,
      codex: true,
    })
    assert.doesNotMatch(instructions.prompt ?? '', /typescript rule|src agent/)

    const first = await instructions.activateForToolCall({
      tool: 'apply_patch',
      params: [
        '*** Begin Patch',
        '*** Add File: src/example.ts',
        '+export const value = 1',
        '*** End Patch',
      ].join('\n'),
    })
    assert.deepEqual(first.warnings, [])
    assert.match(first.prompt ?? '', /typescript rule/)
    assert.match(first.prompt ?? '', /src agent/)
    assert.match(first.prompt ?? '', /src claude/)

    const second = await instructions.activateForToolCall({
      tool: 'apply_patch',
      params: [
        '*** Begin Patch',
        '*** Update File: src/example.ts',
        '@@',
        '-old',
        '+new',
        '*** End Patch',
      ].join('\n'),
    })
    assert.equal(second.prompt, null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('uses an explicit run_command cwd to activate nested rules', async () => {
  const root = await createWorkspace()
  try {
    await writeText(path.join(root, 'tools', 'AGENTS.md'), 'tools agent')
    const { instructions } = await load(root, {
      claudeCode: false,
      codex: true,
    })

    const result = await instructions.activateForToolCall({
      tool: 'run_command',
      params: { command: 'npm test', cwd: 'tools' },
    })
    assert.match(result.prompt ?? '', /tools agent/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('fork preserves active instructions without sharing later activations', async () => {
  const root = await createWorkspace()
  try {
    await writeText(path.join(root, 'one', 'AGENTS.md'), 'one agent')
    await writeText(path.join(root, 'two', 'AGENTS.md'), 'two agent')
    const { instructions } = await load(root, {
      claudeCode: false,
      codex: true,
    })
    await instructions.activateForToolCall({
      tool: 'run_command',
      params: { command: 'pwd', cwd: 'one' },
    })
    const child = instructions.fork()
    await child.activateForToolCall({
      tool: 'run_command',
      params: { command: 'pwd', cwd: 'two' },
    })

    assert.match(child.prompt ?? '', /one agent/)
    assert.match(child.prompt ?? '', /two agent/)
    assert.match(instructions.prompt ?? '', /one agent/)
    assert.doesNotMatch(instructions.prompt ?? '', /two agent/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('blocks imports and symlink targets outside the workspace', async () => {
  const root = await createWorkspace()
  const parent = path.dirname(root)
  const outside = path.join(
    parent,
    `portal-instructions-outside-${path.basename(root)}.md`
  )
  try {
    await writeText(outside, 'outside secret')
    await writeText(
      path.join(root, 'CLAUDE.md'),
      '@../' + path.basename(outside)
    )

    const { instructions, warnings } = await load(root, {
      claudeCode: true,
      codex: false,
    })
    assert.doesNotMatch(instructions.prompt ?? '', /outside secret/)
    assert.ok(warnings.some((warning) => /outside the workspace/.test(warning)))
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { force: true })
  }
})

test('truncates Codex instructions at the compatibility byte limit', async () => {
  const root = await createWorkspace()
  try {
    await writeText(path.join(root, 'AGENTS.md'), 'x'.repeat(40 * 1024))
    const { instructions, warnings } = await load(root, {
      claudeCode: false,
      codex: true,
    })
    assert.equal(
      (instructions.prompt ?? '').includes('x'.repeat(32 * 1024)),
      true
    )
    assert.ok(
      warnings.some((warning) => /truncated at 32768 bytes/.test(warning))
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('does not expand imports inside Markdown code fences', async () => {
  const root = await createWorkspace()
  try {
    await writeText(path.join(root, 'extra.md'), 'imported text')
    await writeText(
      path.join(root, 'CLAUDE.md'),
      ['```md', '@extra.md', '```', '@extra.md'].join('\n')
    )
    const { instructions } = await load(root, {
      claudeCode: true,
      codex: false,
    })
    const prompt = instructions.prompt ?? ''
    assert.equal(prompt.match(/imported text/g)?.length, 1)
    assert.match(prompt, /```md\n@extra\.md\n```/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('reports cyclic Claude imports without duplicating their content', async () => {
  const root = await createWorkspace()
  try {
    await writeText(path.join(root, 'CLAUDE.md'), 'root text\n@nested.md')
    await writeText(path.join(root, 'nested.md'), 'nested text\n@CLAUDE.md')
    const { instructions, warnings } = await load(root, {
      claudeCode: true,
      codex: false,
    })
    const prompt = instructions.prompt ?? ''
    assert.equal(prompt.match(/root text/g)?.length, 1)
    assert.equal(prompt.match(/nested text/g)?.length, 1)
    assert.ok(
      warnings.some((warning) => /cyclic Claude Code import/.test(warning))
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('reuses a previously scanned rule when Claude explicitly imports it', async () => {
  const root = await createWorkspace()
  try {
    await writeText(
      path.join(root, '.claude', 'rules', 'shared.md'),
      ['---', 'paths:', '  - "src/**/*.ts"', '---', 'shared rule'].join('\n')
    )
    await writeText(path.join(root, 'CLAUDE.md'), '@.claude/rules/shared.md')

    const { instructions } = await load(root, {
      claudeCode: true,
      codex: false,
    })
    assert.match(instructions.prompt ?? '', /shared rule/)
    assert.doesNotMatch(instructions.prompt ?? '', /^paths:/m)
    const activation = await instructions.activateForToolCall({
      tool: 'apply_patch',
      params: [
        '*** Begin Patch',
        '*** Add File: src/example.ts',
        '+value',
        '*** End Patch',
      ].join('\n'),
    })
    assert.equal(activation.prompt, null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
