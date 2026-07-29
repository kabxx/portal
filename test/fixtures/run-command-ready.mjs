import { writeFileSync } from 'node:fs'
import process from 'node:process'
import { setInterval } from 'node:timers'

const readyPath = process.argv[2]
if (readyPath === undefined) {
  throw new Error('A ready-file path is required.')
}

writeFileSync(readyPath, 'ready')
setInterval(() => {}, 1_000)
