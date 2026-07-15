import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ApiHttpError,
  mapApiError,
  parseBearerToken,
  requireRecordBody,
} from '../../src/api/api-errors.ts'
import {
  McpDuplicateNameError,
  McpStoredConfigError,
} from '../../src/mcp/mcp-config.ts'

test('mapApiError preserves API errors and hides server messages', () => {
  assert.deepEqual(
    mapApiError(new ApiHttpError(400, 'INVALID_REQUEST', 'bad input')),
    { statusCode: 400, code: 'INVALID_REQUEST', message: 'bad input' }
  )
  assert.deepEqual(
    mapApiError(new ApiHttpError(501, 'NOT_SUPPORTED', 'private detail')),
    {
      statusCode: 501,
      code: 'NOT_SUPPORTED',
      message: 'Internal server error.',
    }
  )
  assert.deepEqual(mapApiError(new Error('private detail')), {
    statusCode: 500,
    code: 'INTERNAL_ERROR',
    message: 'Internal server error.',
  })
})

test('mapApiError maps MCP and Fastify boundary errors', () => {
  assert.deepEqual(mapApiError(new McpDuplicateNameError('local')), {
    statusCode: 409,
    code: 'MCP_ALREADY_EXISTS',
    message: 'MCP server already exists: local',
  })
  assert.deepEqual(mapApiError(new McpStoredConfigError('broken config')), {
    statusCode: 500,
    code: 'MCP_CONFIG_INVALID',
    message: 'Internal server error.',
  })

  const validation = Object.assign(new Error('details'), {
    code: 'FST_ERR_VALIDATION',
    statusCode: 400,
  })
  assert.deepEqual(mapApiError(validation), {
    statusCode: 400,
    code: 'INVALID_REQUEST',
    message: 'Invalid request body.',
  })

  const tooLarge = Object.assign(new Error('details'), {
    code: 'FST_ERR_CTP_BODY_TOO_LARGE',
    statusCode: 413,
  })
  assert.deepEqual(mapApiError(tooLarge), {
    statusCode: 413,
    code: 'REQUEST_TOO_LARGE',
    message: 'Request body is too large.',
  })
})

test('parseBearerToken ignores scheme case but preserves credentials', () => {
  assert.equal(parseBearerToken('Bearer secret'), 'secret')
  assert.equal(parseBearerToken('bearer secret'), 'secret')
  assert.equal(parseBearerToken('BEARER secret'), 'secret')
  assert.equal(parseBearerToken('Basic secret'), null)
  assert.equal(parseBearerToken('Bearer'), null)
  assert.equal(parseBearerToken(undefined), null)
})

test('requireRecordBody rejects missing and non-object bodies', () => {
  assert.deepEqual(requireRecordBody({ value: 1 }), { value: 1 })
  for (const value of [undefined, null, [], 'text']) {
    assert.throws(
      () => requireRecordBody(value),
      /Request body must be an object\./
    )
  }
})
