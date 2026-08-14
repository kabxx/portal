import assert from 'node:assert/strict'
import test from 'node:test'

import type { BrowserContext } from 'playwright'
import {
  createToolServices,
  inheritSpawnModelSelection,
  nextSpawnDepth,
} from '../../src/app/app-spawn-tool-services.ts'
import { createDefaultAdvancedConfig } from '../../src/config/portal-config.ts'
import { createPortalRuntimeSettings } from '../../src/app/app-runtime-settings.ts'
import type { HookDispatcher } from '../../src/hooks/hook-dispatcher.ts'
import type { ProjectInstructions } from '../../src/instructions/project-instructions.ts'
import type { RunCommandJobManager } from '../../src/processes/run-command-job-manager.ts'
import type { SkillLibrary } from '../../src/skills/skill-library.ts'

test('spawn model selection inherits only within the same provider', () => {
  const model = { key: '3.1-pro', option: 'extended' }

  assert.equal(inheritSpawnModelSelection('gemini', 'gemini', model), model)
  assert.equal(inheritSpawnModelSelection('gemini', 'deepseek', model), null)
  assert.equal(inheritSpawnModelSelection('gemini', 'gemini', null), null)
})

test('nextSpawnDepth allows configured child levels and rejects the next one', () => {
  assert.equal(nextSpawnDepth(0, 0), null)
  assert.equal(nextSpawnDepth(0, 1), 1)
  assert.equal(nextSpawnDepth(4, 5), 5)
  assert.equal(nextSpawnDepth(5, 5), null)
})

test('spawn depth rejection occurs before project, browser, or Hook side effects', async () => {
  let forkCalls = 0
  let hookCalls = 0
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const projectInstructions = {
    fork: () => {
      forkCalls += 1
      return projectInstructions
    },
  } as unknown as ProjectInstructions
  const settings = createPortalRuntimeSettings(createDefaultAdvancedConfig())
  settings.spawnDepthLimit = 5
  const services = createToolServices({
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    context: {} as BrowserContext,
    provider: 'chatgpt',
    model: null,
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    skillLibrary: {} as SkillLibrary,
    projectInstructions,
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    runCommandJobs: {} as RunCommandJobManager,
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    hookDispatcher: {
      createEvent: () => {
        hookCalls += 1
        return {}
      },
      dispatch: async () => {
        hookCalls += 1
        return { action: 'allow', rewrittenBy: [] }
      },
    } as unknown as HookDispatcher,
    settings,
    currentSpawnDepth: 5,
  })

  const result = await services.spawnTask?.(
    { prompt: 'must not run' },
    {
      executionScope: {
        cwd: process.cwd(),
        source: 'system',
        spawnDepth: 0,
        hookDepth: 0,
        snapshot: {
          enabled: false,
          handlers: [],
          maxDepth: 0,
          revision: 'test',
          loadedAt: 0,
        },
      },
    }
  )

  assert.deepEqual(result, {
    kind: 'error',
    message:
      'SPAWN_DEPTH_LIMIT_REACHED: spawn depth 5 reached the configured limit 5',
  })
  assert.equal(forkCalls, 0)
  assert.equal(hookCalls, 0)
})
