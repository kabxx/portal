import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createPortalRuntimeSettings,
  parseApiThreadCreationMode,
  runtimeSetupModeForThreadCreation,
} from '../../src/app/app-runtime-settings.ts'
import { createDefaultAdvancedConfig } from '../../src/config/portal-config.ts'

test('thread creation modes map to setup modes and API defaults safely', () => {
  assert.equal(runtimeSetupModeForThreadCreation('agent'), 'full')
  assert.equal(runtimeSetupModeForThreadCreation('chat'), 'handshake')
  assert.equal(parseApiThreadCreationMode(undefined), 'agent')
  assert.equal(parseApiThreadCreationMode('chat'), 'chat')
  assert.throws(() => parseApiThreadCreationMode(null), /mode must be/)
  assert.throws(() => parseApiThreadCreationMode('clean'), /mode must be/)
})

test('runtime settings convert every advanced section to runtime units', () => {
  const advanced = createDefaultAdvancedConfig()
  advanced.browser = { startupTimeoutSeconds: 11, closeTimeoutSeconds: 12 }
  advanced.provider = {
    requestStartWarningAfterSeconds: 13,
    blockedWarningEverySeconds: 14,
    responseStartTimeoutSeconds: 15,
    responseStallTimeoutSeconds: 16,
    restoreTimeoutSeconds: 17,
    historyLoadTimeoutSeconds: 18,
    historyPageTimeoutSeconds: 19,
  }
  advanced.runtime = {
    initializationAttemptLimit: 19,
    requestAttemptLimit: 20,
    spawnDepthLimit: 5,
    cancelWaitTimeoutSeconds: 21,
    shutdownCloseTimeoutSeconds: 22,
    childRuntimeCloseTimeoutSeconds: 23,
  }
  advanced.command = {
    resultOutputLimitMB: 24,
    stopGraceSeconds: 0.25,
    stopTimeoutSeconds: 26,
  }
  advanced.skillInstall = {
    downloadTimeoutSeconds: 27,
    downloadLimitMB: 28,
    extractedSizeLimitMB: 29,
    fileCountLimit: 30,
    resourceFileCountLimit: 31,
    manifestSizeLimitKB: 32,
    redirectLimit: 33,
  }
  advanced.api = {
    requestBodyLimitKB: 34,
    requestTimeoutSeconds: 35,
    sseHeartbeatSeconds: 36,
  }
  advanced.instructions = {
    codexSizeLimitKB: 37,
    claudeSizeLimitKB: 38,
    fileCountLimit: 39,
    importDepthLimit: 40,
  }
  advanced.hooks = { commandOutputLimitMB: 41 }

  assert.deepEqual(createPortalRuntimeSettings(advanced), {
    browserLaunch: { startupTimeoutMs: 11_000, closeTimeoutMs: 12_000 },
    providerTimings: {
      requestStartWarningAfterMs: 13_000,
      blockedWarningIntervalMs: 14_000,
      responseStartTimeoutMs: 15_000,
      responseStallTimeoutMs: 16_000,
      restoreTimeoutMs: 17_000,
      historyLoadTimeoutMs: 18_000,
      historyPageTimeoutMs: 19_000,
    },
    initializationAttemptLimit: 19,
    requestAttemptLimit: 20,
    spawnDepthLimit: 5,
    cancelWaitTimeoutMs: 21_000,
    shutdownCloseTimeoutMs: 22_000,
    childRuntimeCloseTimeoutMs: 23_000,
    runCommand: {
      maxOutputBufferBytes: 24 * 1024 * 1024,
      terminationGraceMs: 250,
      terminationSettleTimeoutMs: 26_000,
    },
    skillPolicy: {
      downloadTimeoutMs: 27_000,
      maxDownloadBytes: 28 * 1024 * 1024,
      maxExtractedBytes: 29 * 1024 * 1024,
      maxFiles: 30,
      maxResourceFiles: 31,
      maxManifestBytes: 32 * 1024,
      maxRedirects: 33,
    },
    api: {
      bodyLimitBytes: 34 * 1024,
      requestTimeoutMs: 35_000,
      sseHeartbeatMs: 36_000,
    },
    instructionLimits: {
      codexMaxBytes: 37 * 1024,
      claudeMaxBytes: 38 * 1024,
      maxFiles: 39,
      maxImportDepth: 40,
    },
    hookCommandOutputLimitBytes: 41 * 1024 * 1024,
  })
})
