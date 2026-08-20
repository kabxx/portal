import path from 'node:path'
import { createRequire } from 'node:module'
import { stdin, stdout } from 'node:process'
import { Command } from 'commander'

import { render } from './vendor/ink.ts'
import type { TerminalController } from './terminal-ui/terminal-controller.ts'
import type {
  PortalMcpServer,
  PortalMcpServerOptions,
} from './mcp-server/mcp-server.ts'
import {
  MCP_SURFACE_ID,
  isMcpSurfaceApi,
} from './mcp-server/mcp-surface-plugin.ts'
import { PortalHost, type PortalHostDependencies } from './host/portal-host.ts'
import { portalHostTestExtensions } from './extensions/portal-hooks.ts'
import { TUI_SURFACE_ID } from './app/tui-surface-plugin.ts'
import type { CommandMcpService } from './cli-commands/core/command-services.ts'

export {
  closeLateBrowserLaunchAfterShutdown,
  closeWithTimeout,
  createIdempotentAsyncTask,
  stopMcpForegroundOperation,
  transitionLoginWaitWarning,
  type McpForegroundOperation,
} from './app/app-lifecycle.ts'
export { createPortalRuntimeSettings } from './runtime/runtime-settings.ts'
export { inheritSpawnModelSelection } from './threads/web-child-conversation-service.ts'
export {
  clearTerminalBeforeRender,
  shouldRenderFallbackThreadError,
  showPendingThreadTimeline,
} from './app/app-terminal-lifecycle.ts'

const PORTAL_VERSION = readPortalVersion()

function readPortalVersion(): string {
  const packageMetadata: unknown = createRequire(import.meta.url)(
    '../package.json'
  )
  if (
    typeof packageMetadata !== 'object' ||
    packageMetadata === null ||
    !('version' in packageMetadata) ||
    typeof packageMetadata.version !== 'string'
  ) {
    throw new Error('package.json must contain a string version.')
  }
  return packageMetadata.version
}

interface Options {
  browserExecutablePath?: string
  dataDir?: string
}

export interface PortalRunDependencies extends PortalHostDependencies {
  cwd?: string
  renderTerminal?: typeof render
  terminalController?: TerminalController
  createMcpServer?: (options: PortalMcpServerOptions) => PortalMcpServer
}

function buildProgram() {
  return new Command()
    .name('portal')
    .description(
      'A browser-based agent CLI for working across multiple web AI providers.'
    )
    .version(PORTAL_VERSION)
    .option(
      '--browser-executable-path <path>',
      'path to the browser executable used when launching a browser for CDP'
    )
    .option(
      '--data-dir <path>',
      'directory for config, history, skills, and the browser profile'
    )
    .addHelpText(
      'after',
      [
        '',
        'Commands:',
        '  exec [options] [task]  Run one agent task without starting the TUI',
        '  config [options]       Print the configuration file path',
        '  plugins <command>      Recover or manage installed plugins',
      ].join('\n')
    )
}

export async function run(
  argv = process.argv,
  dependencies: PortalRunDependencies = {}
): Promise<void> {
  const program = buildProgram()
  program.parse(argv)
  const options = program.opts<Options>()
  const cwd = path.resolve(dependencies.cwd ?? process.cwd())
  const host = await PortalHost.prepare(
    {
      entrySurfaceId: TUI_SURFACE_ID,
      cwd,
      ...(options.dataDir === undefined
        ? {}
        : { dataDirectory: options.dataDir }),
      ...(options.browserExecutablePath === undefined
        ? {}
        : { browserExecutablePath: options.browserExecutablePath }),
    },
    {
      ...(dependencies.launchBrowser === undefined
        ? {}
        : { launchBrowser: dependencies.launchBrowser }),
      ...(dependencies[portalHostTestExtensions] === undefined
        ? {}
        : {
            [portalHostTestExtensions]: dependencies[portalHostTestExtensions],
          }),
    }
  )
  try {
    await host.start()
    let mcp: CommandMcpService | undefined
    if (host.surfaceCatalog().some(({ id }) => id === MCP_SURFACE_ID)) {
      const mcpSurface = await host.activateSurface(MCP_SURFACE_ID, {
        ...(dependencies.createMcpServer === undefined
          ? {}
          : { createServer: dependencies.createMcpServer }),
      })
      if (!isMcpSurfaceApi(mcpSurface.api)) {
        throw new TypeError('The portal.mcp Surface returned an invalid API.')
      }
      mcp = mcpSurface.api
    }
    const tui = await host.activateSurface(TUI_SURFACE_ID, {
      version: PORTAL_VERSION,
      ...(mcp === undefined ? {} : { mcp }),
      input: stdin,
      output: stdout,
      ...(dependencies.renderTerminal === undefined
        ? {}
        : { renderTerminal: dependencies.renderTerminal }),
      ...(dependencies.terminalController === undefined
        ? {}
        : { terminalController: dependencies.terminalController }),
    })
    await tui.done
  } catch (error) {
    try {
      await host.close(error)
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Portal TUI failed and could not close cleanly.',
        { cause: cleanupError }
      )
    }
    throw error
  }
  await host.close()
}
