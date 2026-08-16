import type { PortalRunDependencies, run as runTui } from './app.ts'
import type {
  ConfigCliDependencies,
  runConfigCli,
} from './config/config-command.ts'
import type { ExecCliDependencies, runExecCli } from './exec/exec-command.ts'
import type {
  PluginsCliDependencies,
  runPluginsCli,
} from './bootstrap/plugins-command.ts'

export interface PortalCliDependencies {
  tui?: PortalRunDependencies
  exec?: ExecCliDependencies
  config?: ConfigCliDependencies
  plugins?: PluginsCliDependencies
  runTui?: typeof runTui
  runExec?: typeof runExecCli
  runConfig?: typeof runConfigCli
  runPlugins?: typeof runPluginsCli
}

export async function runPortalCli(
  argv = process.argv,
  dependencies: PortalCliDependencies = {}
): Promise<number> {
  if (argv[2] === 'exec') {
    const runExec =
      dependencies.runExec ??
      (await import('./exec/exec-command.ts')).runExecCli
    return await runExec(argv.slice(3), dependencies.exec)
  }
  if (argv[2] === 'config') {
    const runConfig =
      dependencies.runConfig ??
      (await import('./config/config-command.ts')).runConfigCli
    return await runConfig(argv.slice(3), dependencies.config)
  }
  if (argv[2] === 'plugins') {
    const runPlugins =
      dependencies.runPlugins ??
      (await import('./bootstrap/plugins-command.ts')).runPluginsCli
    return await runPlugins(argv.slice(3), dependencies.plugins)
  }
  const run = dependencies.runTui ?? (await import('./app.ts')).run
  await run(argv, dependencies.tui)
  return typeof process.exitCode === 'number' ? process.exitCode : 0
}
