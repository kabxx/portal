import test from 'node:test'
import assert from 'node:assert/strict'

import { JobCommand } from '../../../src/cli-commands/commands/command-job.ts'
import type { CliCommandContext } from '../../../src/cli-commands/core/command-types.ts'
import type {
  RunCommandJobService,
  RunCommandJobSnapshot,
  RunCommandStopResult,
} from '../../../src/processes/run-command-job-manager.ts'
import { TerminalController } from '../../../src/terminal-ui/terminal-controller.ts'
import { latestTimelineEntry } from '../../helpers/ui.ts'

function createContext({
  jobs = [],
  stopResult = 'not_found',
}: {
  jobs?: RunCommandJobSnapshot[]
  stopResult?: RunCommandStopResult
} = {}) {
  const ui = new TerminalController()
  const stoppedIds: string[] = []
  const runCommandJobs: RunCommandJobService = {
    start: () => {
      throw new Error('not used')
    },
    list: () => jobs,
    stop: async (id) => {
      stoppedIds.push(id)
      return stopResult
    },
    beginShutdown: () => {},
    stopAll: async () => {},
  }
  const context = {
    ui,
    runCommandJobs,
  } as unknown as CliCommandContext
  return { context, stoppedIds, ui }
}

test('JobCommand lists active jobs with sanitized command text', async () => {
  const { context, ui } = createContext({
    jobs: [
      {
        id: 'j-1',
        pid: 42,
        command: 'first\n\u001b[31msecond',
        cwd: 'C:\\project',
        shell: 'powershell',
        startedAt: Date.now() - 2000,
        state: 'running',
      },
    ],
  })

  await JobCommand.execute(context, [])

  const entry = latestTimelineEntry(ui)
  assert.ok(entry)
  assert.equal(entry.label, '/job')
  assert.equal(entry.tone, 'info')
  assert.match(entry.body, /j-1  pid=42  running/)
  assert.match(entry.body, /command: first \[31msecond/)
  assert.doesNotMatch(entry.body, /\u001b/)
})

test('JobCommand reports an empty active list', async () => {
  const { context, ui } = createContext()

  await JobCommand.execute(context, [])

  assert.equal(
    latestTimelineEntry(ui)?.body,
    'No run_command jobs are running.'
  )
})

test('JobCommand stops an exact job id', async () => {
  const { context, stoppedIds, ui } = createContext({ stopResult: 'stopped' })

  await JobCommand.execute(context, ['stop', 'j-7'])

  assert.deepEqual(stoppedIds, ['j-7'])
  assert.deepEqual(latestTimelineEntry(ui), {
    tone: 'success',
    label: '/job stop',
    body: 'Stopped j-7.',
    format: 'plain',
  })
})

test('JobCommand validates stop arguments and unknown jobs', async () => {
  const { context, stoppedIds, ui } = createContext()

  await JobCommand.execute(context, ['stop'])
  assert.equal(latestTimelineEntry(ui)?.body, 'Usage: /job stop <job-id>')
  assert.deepEqual(stoppedIds, [])

  await JobCommand.execute(context, ['stop', 'j-9'])
  assert.equal(latestTimelineEntry(ui)?.body, 'Unknown or finished job: j-9')
})
