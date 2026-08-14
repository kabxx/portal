import { run, type PortalRunDependencies } from './app.ts'
import {
  runConfigCli,
  type ConfigCliDependencies,
} from './config/config-command.ts'
import { runExecCli, type ExecCliDependencies } from './exec/exec-command.ts'

export interface PortalCliDependencies {
  tui?: PortalRunDependencies
  exec?: ExecCliDependencies
  config?: ConfigCliDependencies
  runTui?: typeof run
  runExec?: typeof runExecCli
  runConfig?: typeof runConfigCli
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
  if (argv[2] === 'config') {
    return await (dependencies.runConfig ?? runConfigCli)(
      argv.slice(3),
      dependencies.config
    )
  }
  await (dependencies.runTui ?? run)(argv, dependencies.tui)
  return typeof process.exitCode === 'number' ? process.exitCode : 0
}
