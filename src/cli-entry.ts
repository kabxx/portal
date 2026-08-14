import { run, type PortalRunDependencies } from './app.ts'
import { runExecCli, type ExecCliDependencies } from './exec/exec-command.ts'

export interface PortalCliDependencies {
  tui?: PortalRunDependencies
  exec?: ExecCliDependencies
  runTui?: typeof run
  runExec?: typeof runExecCli
}

export async function runPortalCli(
  argv = process.argv,
  dependencies: PortalCliDependencies = {}
): Promise<number> {
  if (argv[2] === 'exec') {
    return await (dependencies.runExec ?? runExecCli)(
      argv.slice(3),
      dependencies.exec
    )
  }
  await (dependencies.runTui ?? run)(argv, dependencies.tui)
  return typeof process.exitCode === 'number' ? process.exitCode : 0
}
