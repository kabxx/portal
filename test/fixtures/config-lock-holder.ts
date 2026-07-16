import { withPortalConfigTransaction } from '../../src/config/portal-config.ts'
import { createDefaultPortalConfig } from '../../src/config/portal-config.ts'

const configPath = process.argv[2]
if (configPath === undefined) {
  throw new Error('Expected a config path')
}

await withPortalConfigTransaction(
  configPath,
  async (transaction) => {
    process.stdout.write('ready\n')
    await new Promise<void>((resolve, reject) => {
      process.stdin.once('data', () => {
        process.stdin.pause()
        resolve()
      })
      process.stdin.once('error', reject)
      process.stdin.resume()
    })
    transaction.noChange()
  },
  createDefaultPortalConfig()
)
