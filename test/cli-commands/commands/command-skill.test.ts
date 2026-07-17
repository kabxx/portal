import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, rm } from 'fs/promises'
import os from 'os'
import path from 'path'

import { SkillCommand } from '../../../src/cli-commands/commands/command-skill.ts'
import { CommandRegistry } from '../../../src/cli-commands/core/command-registry.ts'
import type { CliCommandContext } from '../../../src/cli-commands/core/command-types.ts'
import { SkillLibrary } from '../../../src/skills/skill-library.ts'
import { TerminalController } from '../../../src/terminal-ui/terminal-controller.ts'
import { ThreadManager } from '../../../src/threads/thread-manager.ts'
import { ThreadStore } from '../../../src/threads/thread-store.ts'
import { createTestSkill } from '../../helpers/skills.ts'
import { latestTimelineEntry } from '../../helpers/ui.ts'
import { McpLibrary } from '../../../src/mcp/mcp-library.ts'

test('SkillCommand manages the registered skill lifecycle', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-skill-command-'))
  const source = await createTestSkill(
    path.join(root, 'source directory'),
    'command-skill'
  )
  const skillLibrary = new SkillLibrary({
    skillsDirectory: path.join(root, 'data', 'skills'),
    tempDirectory: path.join(root, 'data', 'temp', 'skill-install'),
    registryPath: path.join(root, 'data', 'config.yaml'),
  })
  const ui = new TerminalController()
  const registry = new CommandRegistry([SkillCommand])
  const context: CliCommandContext = {
    threadManager: new ThreadManager(),
    threadStore: new ThreadStore(path.join(root, 'threads.db')),
    skillLibrary,
    mcpLibrary: new McpLibrary(path.join(root, 'data', 'config.yaml')),
    ui,
    browserProfileDir: path.join(root, 'profile'),
    providers: [],
    resolveProvider: () => null,
    createThread: async () => {},
    resumeThread: async () => {},
    closeThread: async (threadId) =>
      await context.threadManager.closeThread(threadId),
    addSkill: async (value) => await skillLibrary.add(value),
    submitThreadInput: async () => {},
    listCommands: () => registry.list(),
  }

  try {
    await registry.execute(`/skill add ${source}`, context)
    const installationInfo = ui
      .getState()
      .timeline.find(
        ({ tone, label }) => tone === 'info' && label === '/skill add'
      )
    assert.match(installationInfo?.body ?? '', /local directory/)
    assert.ok(installationInfo?.body.includes(source))
    assert.match(latestTimelineEntry(ui)?.body ?? '', /Added and enabled/)

    await registry.execute('/skill list', context)
    assert.equal(
      latestTimelineEntry(ui)?.body,
      ['Skills:', '* command-skill'].join('\n')
    )

    await registry.execute('/skill disable command-skill', context)
    assert.match(latestTimelineEntry(ui)?.body ?? '', /Disabled command-skill/)
    assert.equal((await skillLibrary.list()).skills[0]?.enabled, false)

    await registry.execute('/skill enable command-skill', context)
    assert.match(latestTimelineEntry(ui)?.body ?? '', /Enabled command-skill/)

    await registry.execute('/skill remove command-skill', context)
    assert.match(latestTimelineEntry(ui)?.body ?? '', /Removed command-skill/)
    assert.equal((await skillLibrary.list()).skills.length, 0)
    await access(path.join(source, 'SKILL.md'))
  } finally {
    context.threadStore.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('SkillCommand shows subcommand help and validates add arguments', async () => {
  const ui = new TerminalController()
  const context = {
    ui,
  } as CliCommandContext

  await SkillCommand.execute(context, [])
  const help = latestTimelineEntry(ui)?.body ?? ''
  assert.match(help, /add <local-directory>/)
  assert.match(help, /add <url>/)
  assert.match(help, /add <name> --registry <url>/)
  assert.match(help, /\$<name> \[task\]/)

  await SkillCommand.execute(context, ['add'])
  const missingSource = latestTimelineEntry(ui)?.body ?? ''
  assert.match(missingSource, /Missing skill source/)
  assert.match(missingSource, /\/skill add <local-directory>/)
  assert.match(missingSource, /\/skill add <url>/)
  assert.match(missingSource, /\/skill add <name> --registry <url>/)
})

test('SkillCommand reports committed removal cleanup warnings after success', async () => {
  const ui = new TerminalController()
  const context = {
    ui,
    skillLibrary: {
      remove: async () => ({
        removed: true,
        warnings: ['Temporary cleanup failed at data/temp/skill-remove/test.'],
      }),
    },
  } as unknown as CliCommandContext

  await SkillCommand.execute(context, ['remove', 'warned-skill'])

  const timeline = ui.getState().timeline
  assert.ok(
    timeline.some(
      ({ tone, body }) =>
        tone === 'success' && /Removed warned-skill/.test(body)
    )
  )
  assert.equal(latestTimelineEntry(ui)?.tone, 'warning')
  assert.match(latestTimelineEntry(ui)?.body ?? '', /Temporary cleanup failed/)
})

test('SkillCommand passes a named Hub registry source separately and hides URL secrets', async () => {
  const ui = new TerminalController()
  const registry = new CommandRegistry([SkillCommand])
  let receivedSource = ''
  let receivedOptions: { registryUrl?: string } | undefined
  let infoAtInstall: ReturnType<typeof latestTimelineEntry>
  const context = {
    ui,
    addSkill: async (
      source: string,
      options: { registryUrl?: string } | undefined
    ) => {
      receivedSource = source
      receivedOptions = options
      infoAtInstall = latestTimelineEntry(ui)
      return {
        skills: [
          {
            name: source,
            description: 'Hub skill.',
            directory: `C:\\skills\\${source}`,
          },
        ],
        warnings: [],
      }
    },
  } as unknown as CliCommandContext

  await registry.execute(
    '/skill add neko-on-everything --registry https://user:password@example.com/?token=secret#fragment',
    context
  )

  assert.equal(receivedSource, 'neko-on-everything')
  assert.deepEqual(receivedOptions, {
    registryUrl: 'https://user:password@example.com/?token=secret#fragment',
  })
  assert.equal(infoAtInstall?.tone, 'info')
  assert.match(infoAtInstall?.body ?? '', /Hub registry/)
  assert.match(infoAtInstall?.body ?? '', /Skill: neko-on-everything/)
  assert.match(infoAtInstall?.body ?? '', /Registry: https:\/\/example\.com\//)
  assert.doesNotMatch(infoAtInstall?.body ?? '', /password|secret|fragment/)
})

test('SkillCommand rejects invalid Hub registry option combinations', async () => {
  const ui = new TerminalController()
  const context = { ui } as CliCommandContext

  await SkillCommand.execute(context, [
    'add',
    'https://example.com/skill.zip',
    '--registry',
    'https://registry.example.com',
  ])
  assert.match(
    latestTimelineEntry(ui)?.body ?? '',
    /requires a skill name, not a URL/
  )

  await SkillCommand.execute(context, ['add', 'skill-name', '--registry'])
  assert.match(latestTimelineEntry(ui)?.body ?? '', /--registry requires a URL/)
})

test('SkillCommand reports remote installation before starting and hides URL secrets', async () => {
  const ui = new TerminalController()
  let infoAtInstall: ReturnType<typeof latestTimelineEntry>
  const context = {
    ui,
    addSkill: async () => {
      infoAtInstall = latestTimelineEntry(ui)
      return {
        skills: [
          {
            name: 'remote-skill',
            description: 'Remote skill.',
            directory: 'C:\\skills\\remote-skill',
          },
        ],
        warnings: [],
      }
    },
  } as unknown as CliCommandContext

  await SkillCommand.execute(context, [
    'add',
    'https://user:password@example.com/skill.zip?token=secret#fragment',
  ])

  assert.equal(infoAtInstall?.tone, 'info')
  assert.match(infoAtInstall?.body ?? '', /remote source/)
  assert.match(infoAtInstall?.body ?? '', /https:\/\/example\.com\/skill\.zip/)
  assert.doesNotMatch(infoAtInstall?.body ?? '', /password|secret|fragment/)
  assert.match(latestTimelineEntry(ui)?.body ?? '', /Added and enabled/)
})

test('SkillCommand reports every installed skill in a collection', async () => {
  const ui = new TerminalController()
  const context = {
    ui,
    addSkill: async () => ({
      skills: [
        {
          name: 'alpha-skill',
          description: 'Alpha skill.',
          directory: 'C:\\skills\\alpha-skill',
        },
        {
          name: 'beta-skill',
          description: 'Beta skill.',
          directory: 'C:\\skills\\beta-skill',
        },
      ],
      warnings: [],
    }),
  } as unknown as CliCommandContext

  await SkillCommand.execute(context, ['add', 'C:\\skill-collection'])

  const message = latestTimelineEntry(ui)?.body ?? ''
  assert.match(message, /Added and enabled 2 skills/)
  assert.match(message, /alpha-skill: C:\\skills\\alpha-skill/)
  assert.match(message, /beta-skill: C:\\skills\\beta-skill/)
})
