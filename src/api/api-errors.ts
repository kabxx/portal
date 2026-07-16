import { McpConfigError } from '../mcp/mcp-config.ts'
export { parseBearerToken } from '../shared/http-auth.ts'

export class ApiHttpError extends Error {
  public readonly statusCode: number
  public readonly code: string

  public constructor(statusCode: number, code: string, message: string) {
    super(message)
    this.name = 'ApiHttpError'
    this.statusCode = statusCode
    this.code = code
  }
}

export interface ApiErrorDescriptor {
  statusCode: number
  code: string
  message: string
}

export function mapApiError(error: unknown): ApiErrorDescriptor {
  if (error instanceof ApiHttpError) {
    return {
      statusCode: error.statusCode,
      code: error.code,
      message: exposeMessage(error.statusCode, error.message),
    }
  }

  if (error instanceof McpConfigError) {
    if (error.kind === 'duplicate-name') {
      return {
        statusCode: 409,
        code: 'MCP_ALREADY_EXISTS',
        message: error.message,
      }
    }
    if (error.kind === 'invalid-input') {
      return {
        statusCode: 400,
        code: 'INVALID_MCP_CONFIG',
        message: error.message,
      }
    }
    return {
      statusCode: 500,
      code: 'MCP_CONFIG_INVALID',
      message: 'Internal server error.',
    }
  }

  const fastifyCode = getFastifyCode(error)
  switch (fastifyCode) {
    case 'FST_ERR_VALIDATION':
    case 'FST_ERR_CTP_EMPTY_JSON_BODY':
    case 'FST_ERR_CTP_INVALID_JSON_BODY':
    case 'FST_ERR_CTP_INVALID_CONTENT_LENGTH':
      return {
        statusCode: 400,
        code: 'INVALID_REQUEST',
        message: 'Invalid request body.',
      }
    case 'FST_ERR_CTP_BODY_TOO_LARGE':
      return {
        statusCode: 413,
        code: 'REQUEST_TOO_LARGE',
        message: 'Request body is too large.',
      }
    case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
      return {
        statusCode: 415,
        code: 'UNSUPPORTED_MEDIA_TYPE',
        message: 'Unsupported media type.',
      }
    case 'FST_ERR_NOT_FOUND':
      return {
        statusCode: 404,
        code: 'NOT_FOUND',
        message: 'Route not found.',
      }
    case null:
    default:
      return {
        statusCode: 500,
        code: 'INTERNAL_ERROR',
        message: 'Internal server error.',
      }
  }
}

export function requireRecordBody(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) {
    throw new ApiHttpError(
      400,
      'INVALID_REQUEST',
      'Request body must be an object.'
    )
  }
  return body
}

function exposeMessage(statusCode: number, message: string): string {
  return statusCode >= 500 ? 'Internal server error.' : message
}

function getFastifyCode(error: unknown): string | null {
  if (!isRecord(error) || typeof error.code !== 'string') {
    return null
  }
  return error.code
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
