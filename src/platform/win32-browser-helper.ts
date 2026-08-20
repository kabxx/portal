import { spawn } from 'node:child_process'

interface LaunchMessage {
  type: 'launch'
  attemptId: string
  browserExecutable: string
  browserArguments: string[]
}

let launched = false
let exiting = false
let ipcWrites = Promise.resolve()

process.on('message', (message: unknown) => {
  if (launched || !isLaunchMessage(message)) {
    return
  }
  launched = true
  launchBrowser(message)
})

process.on('disconnect', () => {
  process.exit(1)
})

sendToParent({ type: 'ready' })

function launchBrowser(message: LaunchMessage): void {
  const browser = spawn(message.browserExecutable, message.browserArguments, {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  })

  browser.stderr?.pipe(process.stderr, { end: false })
  browser.once('spawn', () => {
    const pid = browser.pid
    if (pid === undefined) {
      reportFailure(message.attemptId, 'Browser launch returned no PID.')
      return
    }
    sendToParent({ type: 'launched', attemptId: message.attemptId, pid })
  })
  browser.once('error', (error: Error) => {
    reportFailure(message.attemptId, error.message)
  })
  browser.once('close', (code, signal) => {
    void exitAfterStderrFlush(signal === null ? (code ?? 1) : 1)
  })
}

async function exitAfterStderrFlush(exitCode: number): Promise<void> {
  if (exiting) return
  exiting = true
  await ipcWrites
  await new Promise<void>((resolve) => {
    process.stderr.write('', () => resolve())
  })
  process.exit(exitCode)
}

function reportFailure(attemptId: string, message: string): void {
  sendToParent({ type: 'failed', attemptId, message })
  process.exitCode = 1
}

function sendToParent(message: object): void {
  ipcWrites = ipcWrites.then(
    async () =>
      await new Promise<void>((resolve) => {
        if (process.send === undefined || !process.connected) {
          resolve()
          return
        }
        try {
          process.send(message, () => resolve())
        } catch {
          resolve()
        }
      })
  )
}

function isLaunchMessage(value: unknown): value is LaunchMessage {
  if (
    value === null ||
    typeof value !== 'object' ||
    !('type' in value) ||
    !('attemptId' in value) ||
    !('browserExecutable' in value) ||
    !('browserArguments' in value)
  ) {
    return false
  }
  return (
    value.type === 'launch' &&
    typeof value.attemptId === 'string' &&
    typeof value.browserExecutable === 'string' &&
    Array.isArray(value.browserArguments) &&
    value.browserArguments.every((argument) => typeof argument === 'string')
  )
}
