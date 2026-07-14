import type { RunCommandJobSnapshot } from '../../processes/run-command-job-manager.ts'
import type { CliCommand, CommandResult } from '../core/command-types.ts'

const COMMAND_SUMMARY_LENGTH = 120

export const JobCommand: CliCommand = {
  name: '/job',
  usage: '/job [stop <job-id>]',
  description: 'List or stop running command jobs.',
  subcommands: ['stop'],
  async execute(context, args) {
    if (context.runCommandJobs === undefined) {
      context.ui.renderWarning('/job', 'Job management is not available.')
      return { continue: true }
    }
    const [subcommand, ...subcommandArgs] = args
    if (subcommand === undefined) {
      const jobs = context.runCommandJobs.list()
      if (jobs.length === 0) {
        context.ui.renderWarning('/job', 'No run_command jobs are running.')
        return { continue: true }
      }
      context.ui.renderInfo('/job', formatJobList(jobs))
      return { continue: true }
    }
    if (subcommand === 'stop') {
      return await stopJob(context, subcommandArgs)
    }

    context.ui.renderWarning('/job', [
      `Unknown job subcommand: ${subcommand}`,
      'Usage: /job [stop <job-id>]',
    ])
    return { continue: true }
  },
}

async function stopJob(
  context: Parameters<typeof JobCommand.execute>[0],
  args: readonly string[]
): Promise<CommandResult> {
  const id = args[0] ?? ''
  if (!id || args.length !== 1) {
    context.ui.renderWarning('/job stop', 'Usage: /job stop <job-id>')
    return { continue: true }
  }

  const result = await context.runCommandJobs!.stop(id)
  if (result === 'not_found') {
    context.ui.renderWarning('/job stop', `Unknown or finished job: ${id}`)
  } else if (result === 'timeout') {
    context.ui.renderWarning(
      '/job stop',
      `Timed out waiting for ${id} to stop.`
    )
  } else {
    context.ui.renderSuccess('/job stop', `Stopped ${id}.`)
  }
  return { continue: true }
}

function formatJobList(jobs: readonly RunCommandJobSnapshot[]): string {
  const now = Date.now()
  const rows = jobs.flatMap((job, index) => {
    const elapsedSeconds = Math.max(0, Math.floor((now - job.startedAt) / 1000))
    const lines = [
      `${job.id}  pid=${String(job.pid)}  ${job.state}  ${elapsedSeconds}s  ${job.shell}`,
      `  cwd: ${sanitizeDisplayText(job.cwd, COMMAND_SUMMARY_LENGTH)}`,
      `  command: ${sanitizeDisplayText(job.command, COMMAND_SUMMARY_LENGTH)}`,
    ]
    return index === jobs.length - 1 ? lines : [...lines, '']
  })
  return ['Jobs:', ...rows].join('\n')
}

function sanitizeDisplayText(value: string, maxLength: number): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 3)}...`
}
