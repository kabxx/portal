import { ApiHttpError } from '../api/api-server.ts'
import type { PortalAdvancedConfig } from '../config/portal-config.ts'
import type { ProjectInstructionLimits } from '../instructions/project-instructions.ts'
import type { BrowserLaunchOptions } from '../platform/browser-cdp-launcher.ts'
import type { RunCommandJobManagerOptions } from '../processes/run-command-job-manager.ts'
import type { ProviderTimingOptions } from '../providers/adapters/adapter-base.ts'
import type { RuntimeSetupMode } from '../runtime/setup-handshake.ts'
import type { SkillPolicy } from '../skills/skill-policy.ts'
import {
  isThreadCreationMode,
  type ThreadCreationMode,
} from '../threads/thread-creation-mode.ts'

export interface PortalRuntimeSettings {
  browserLaunch: BrowserLaunchOptions
  providerTimings: ProviderTimingOptions
  initializationAttemptLimit: number
  requestAttemptLimit: number
  cancelWaitTimeoutMs: number
  shutdownCloseTimeoutMs: number
  childRuntimeCloseTimeoutMs: number
  runCommand: RunCommandJobManagerOptions
  skillPolicy: SkillPolicy
  api: {
    bodyLimitBytes: number
    requestTimeoutMs: number
    sseHeartbeatMs: number
  }
  instructionLimits: ProjectInstructionLimits
  hookCommandOutputLimitBytes: number
}

export function createPortalRuntimeSettings(
  advanced: PortalAdvancedConfig
): PortalRuntimeSettings {
  const kb = (value: number) => value * 1024
  const mb = (value: number) => value * 1024 * 1024
  const seconds = (value: number) => value * 1000
  return {
    browserLaunch: {
      startupTimeoutMs: seconds(advanced.browser.startupTimeoutSeconds),
      closeTimeoutMs: seconds(advanced.browser.closeTimeoutSeconds),
    },
    providerTimings: {
      requestStartWarningAfterMs: seconds(
        advanced.provider.requestStartWarningAfterSeconds
      ),
      blockedWarningIntervalMs: seconds(
        advanced.provider.blockedWarningEverySeconds
      ),
      responseStartTimeoutMs: seconds(
        advanced.provider.responseStartTimeoutSeconds
      ),
      responseStallTimeoutMs: seconds(
        advanced.provider.responseStallTimeoutSeconds
      ),
      restoreTimeoutMs: seconds(advanced.provider.restoreTimeoutSeconds),
      historyLoadTimeoutMs: seconds(
        advanced.provider.historyLoadTimeoutSeconds
      ),
      historyPageTimeoutMs: seconds(
        advanced.provider.historyPageTimeoutSeconds
      ),
    },
    initializationAttemptLimit: advanced.runtime.initializationAttemptLimit,
    requestAttemptLimit: advanced.runtime.requestAttemptLimit,
    cancelWaitTimeoutMs: seconds(advanced.runtime.cancelWaitTimeoutSeconds),
    shutdownCloseTimeoutMs: seconds(
      advanced.runtime.shutdownCloseTimeoutSeconds
    ),
    childRuntimeCloseTimeoutMs: seconds(
      advanced.runtime.childRuntimeCloseTimeoutSeconds
    ),
    runCommand: {
      maxOutputBufferBytes: mb(advanced.command.resultOutputLimitMB),
      terminationGraceMs: seconds(advanced.command.stopGraceSeconds),
      terminationSettleTimeoutMs: seconds(advanced.command.stopTimeoutSeconds),
    },
    skillPolicy: {
      downloadTimeoutMs: seconds(advanced.skillInstall.downloadTimeoutSeconds),
      maxDownloadBytes: mb(advanced.skillInstall.downloadLimitMB),
      maxExtractedBytes: mb(advanced.skillInstall.extractedSizeLimitMB),
      maxFiles: advanced.skillInstall.fileCountLimit,
      maxResourceFiles: advanced.skillInstall.resourceFileCountLimit,
      maxManifestBytes: kb(advanced.skillInstall.manifestSizeLimitKB),
      maxRedirects: advanced.skillInstall.redirectLimit,
    },
    api: {
      bodyLimitBytes: kb(advanced.api.requestBodyLimitKB),
      requestTimeoutMs: seconds(advanced.api.requestTimeoutSeconds),
      sseHeartbeatMs: seconds(advanced.api.sseHeartbeatSeconds),
    },
    instructionLimits: {
      codexMaxBytes: kb(advanced.instructions.codexSizeLimitKB),
      claudeMaxBytes: kb(advanced.instructions.claudeSizeLimitKB),
      maxFiles: advanced.instructions.fileCountLimit,
      maxImportDepth: advanced.instructions.importDepthLimit,
    },
    hookCommandOutputLimitBytes: mb(advanced.hooks.commandOutputLimitMB),
  }
}

export function runtimeSetupModeForThreadCreation(
  mode: ThreadCreationMode
): Exclude<RuntimeSetupMode, 'skip'> {
  return mode === 'chat' ? 'handshake' : 'full'
}

export function parseApiThreadCreationMode(value: unknown): ThreadCreationMode {
  if (value === undefined) {
    return 'agent'
  }
  if (isThreadCreationMode(value)) {
    return value
  }
  throw new ApiHttpError(
    400,
    'INVALID_REQUEST',
    'mode must be "agent" or "chat".'
  )
}
