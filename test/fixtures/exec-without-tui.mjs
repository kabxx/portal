import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === './app.ts' ||
      specifier === 'react' ||
      specifier.startsWith('@kabxx/ink') ||
      specifier.includes('/terminal-ui/') ||
      specifier.includes('\\terminal-ui\\')
    ) {
      throw new Error(`The exec module graph loaded a TUI module: ${specifier}`)
    }
    return nextResolve(specifier, context)
  },
})

const { runPortalCli } = await import('../../src/cli-entry.ts')
const output = []
const exitCode = await runPortalCli(['node', 'portal', 'exec', '--help'], {
  exec: {
    output: { write: (text) => output.push(String(text)) },
    errorOutput: { write: () => {} },
  },
})

if (exitCode !== 0 || !output.join('').includes('portal exec')) {
  throw new Error(
    'The isolated exec help command did not complete successfully.'
  )
}
