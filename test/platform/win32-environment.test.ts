import test from 'node:test'
import assert from 'node:assert/strict'

import { getRunCommandEnvironment } from '../../src/platform/win32-environment.ts'

test('getRunCommandEnvironment leaves non-Windows environments unchanged', () => {
  const environment = { PORTAL_ENV_TEST: 'value' }

  assert.equal(getRunCommandEnvironment('linux', environment), environment)
})

test(
  'getRunCommandEnvironment refreshes Windows variables and inherits process-only values',
  { skip: process.platform !== 'win32' },
  () => {
    const key = 'PORTAL_WIN32_ENVIRONMENT_TEST'
    const original = process.env[key]
    process.env[key] = 'process-only-value'

    try {
      const environment = getRunCommandEnvironment()
      const normalized = new Map(
        Object.entries(environment).map(([name, value]) => [
          name.toLowerCase(),
          value,
        ])
      )

      assert.notEqual(environment, process.env)
      assert.equal(normalized.get(key.toLowerCase()), 'process-only-value')
      assert.ok((normalized.get('path') ?? '').length > 0)
      assert.equal(normalized.size, Object.keys(environment).length)
    } finally {
      if (original === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = original
      }
    }
  }
)
