import { mkdir, writeFile } from 'fs/promises'
import path from 'path'

export async function createTestSkill(
  parentDirectory: string,
  name: string,
  options: { description?: string; body?: string; resource?: boolean } = {}
): Promise<string> {
  const directory = path.join(parentDirectory, name)
  await mkdir(directory, { recursive: true })
  await writeFile(
    path.join(directory, 'SKILL.md'),
    [
      '---',
      `name: ${name}`,
      `description: ${options.description ?? `Use ${name} for tests.`}`,
      '---',
      '',
      options.body ?? `# ${name}\n\nFollow the test workflow.`,
      '',
    ].join('\n'),
    'utf8'
  )
  if (options.resource === true) {
    await mkdir(path.join(directory, 'references'), { recursive: true })
    await writeFile(
      path.join(directory, 'references', 'guide.md'),
      '# Test guide\n',
      'utf8'
    )
  }
  return directory
}
