import { parse } from 'yaml'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseYamlRecord(value: string): Record<string, unknown> {
  const document: unknown = parse(value)
  if (!isRecord(document)) {
    throw new Error('Expected the YAML document root to be an object.')
  }
  return document
}
