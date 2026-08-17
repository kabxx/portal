import type { CommandJobService } from '../cli-commands/core/command-services.ts'

export const MCP_JOB_MANAGEMENT_FEATURE_ID =
  'portal.tool.run-command.mcp-job-management'
export const MCP_SURFACE_ID = 'portal.mcp'

export type McpJobManagementFeature = CommandJobService

export function isMcpJobManagementFeature(
  value: unknown
): value is McpJobManagementFeature {
  return (
    value !== null &&
    typeof value === 'object' &&
    'list' in value &&
    typeof value.list === 'function' &&
    'stop' in value &&
    typeof value.stop === 'function'
  )
}
