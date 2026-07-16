import { parse } from 'yaml'

export function parseYamlRecord(value: string): Record<string, unknown> {
  const document: unknown = parse(value)
  if (
    document === null ||
    typeof document !== 'object' ||
    Array.isArray(document)
  ) {
    throw new Error('Expected the YAML document root to be an object.')
  }
  return document as Record<string, unknown>
}
