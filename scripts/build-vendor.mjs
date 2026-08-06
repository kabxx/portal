import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
)
const distDirectory = path.join(projectRoot, 'dist')
const licenseFallbacks = new Map([
  [
    'yoga-layout@3.2.1',
    path.join(projectRoot, 'vendor', 'licenses', 'yoga-layout-3.2.1.LICENSE'),
  ],
])
const external = [
  'koffi',
  'koffi/*',
  'react',
  'react/*',
  'react-devtools-core',
  'react-devtools-core/*',
]
const packages = new Map()

const result = await build({
  banner: {
    js: "import { createRequire as __portalCreateRequire } from 'node:module'; const require = __portalCreateRequire(import.meta.url);",
  },
  bundle: true,
  chunkNames: 'chunks/[name]-[hash]',
  entryNames: '[name]',
  entryPoints: {
    ink: path.join(distDirectory, 'vendor', 'ink.js'),
    markdansi: path.join(distDirectory, 'vendor', 'markdansi.js'),
  },
  external,
  format: 'esm',
  legalComments: 'none',
  metafile: true,
  outdir: path.join(distDirectory, 'vendor'),
  platform: 'node',
  splitting: true,
  target: 'node24',
  write: false,
})
for (const output of result.outputFiles) {
  await mkdir(path.dirname(output.path), { recursive: true })
  await writeFile(output.path, output.contents)
}
await collectPackages(result.metafile?.inputs ?? {})

const inkMetadata = JSON.parse(
  await readFile(
    path.join(projectRoot, 'node_modules', 'ink', 'package.json'),
    'utf8'
  )
)
if (inkMetadata.name !== 'ink' || typeof inkMetadata.version !== 'string') {
  throw new Error('The vendored Ink package metadata is invalid')
}
await writeFile(
  path.join(distDirectory, 'package.json'),
  `${JSON.stringify(
    { name: inkMetadata.name, version: inkMetadata.version, type: 'module' },
    null,
    2
  )}\n`
)
await writeFile(
  path.join(distDirectory, 'THIRD-PARTY-NOTICES.txt'),
  await createThirdPartyNotices()
)

async function collectPackages(inputs) {
  for (const input of Object.keys(inputs)) {
    const absolutePath = path.resolve(projectRoot, input)
    const packageJsonPath = await findPackageJson(path.dirname(absolutePath))
    if (packageJsonPath === undefined) continue
    const packageRoot = path.dirname(packageJsonPath)
    if (packageRoot === projectRoot) continue
    const metadata = JSON.parse(await readFile(packageJsonPath, 'utf8'))
    if (typeof metadata.name !== 'string') continue
    const key = `${metadata.name}@${metadata.version ?? 'unknown'}`
    if (!packages.has(key)) {
      packages.set(key, { metadata, packageRoot })
    }
  }
}

async function findPackageJson(startDirectory) {
  let directory = startDirectory
  while (directory.startsWith(projectRoot)) {
    const candidate = path.join(directory, 'package.json')
    try {
      await readFile(candidate, 'utf8')
      return candidate
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    const parent = path.dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return undefined
}

async function createThirdPartyNotices() {
  const lines = [
    'Portal bundles Ink and Markdansi build-time dependencies into its distribution.',
    'The following notices cover the packages included in those bundles.',
    '',
  ]
  const ordered = [...packages.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0
  )
  for (const [key, { metadata, packageRoot }] of ordered) {
    lines.push(`${key} — license: ${formatLicense(metadata.license)}`)
    const licenseText =
      (await readLicenseText(packageRoot)) ?? (await readLicenseFallback(key))
    if (licenseText === undefined) {
      throw new Error(`Missing license text for bundled package ${key}`)
    }
    lines.push(licenseText.trim())
    lines.push('', '---', '')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

function formatLicense(license) {
  if (typeof license === 'string') return license
  if (license && typeof license.type === 'string') return license.type
  return 'unspecified'
}

async function readLicenseText(packageRoot) {
  for (const name of [
    'LICENSE',
    'LICENSE.md',
    'LICENSE.txt',
    'license',
    'license.md',
    'license.txt',
    'COPYING',
    'COPYING.txt',
    'NOTICE',
    'NOTICE.txt',
  ]) {
    try {
      return await readFile(path.join(packageRoot, name), 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  return undefined
}

async function readLicenseFallback(key) {
  const fallback = licenseFallbacks.get(key)
  return fallback === undefined ? undefined : await readFile(fallback, 'utf8')
}
