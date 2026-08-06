import assert from 'node:assert/strict'
import { access, readFile, rm, mkdtemp, mkdir, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const packageMetadata = JSON.parse(
  await readFile(path.join(projectRoot, 'package.json'), 'utf8')
)
const npmCli = process.env.npm_execpath
const [packageMode, packagePath, ...extraArguments] = process.argv.slice(2)

assert.equal(typeof npmCli, 'string', 'npm_execpath must identify the npm CLI')
assert.equal(packageMetadata.name, '@kabxx/portal')
assert.equal(packageMetadata.bin?.portal, 'dist/index.js')
assert.equal(
  packageMetadata.bundleDependencies,
  undefined,
  'published packages must not bundle Git dependencies'
)
assertNoLocalDependencies(packageMetadata.dependencies)
assert.ok(
  (packageMode === undefined && packagePath === undefined) ||
    ((packageMode === '--output' || packageMode === '--tarball') &&
      typeof packagePath === 'string' &&
      extraArguments.length === 0),
  'usage: package-smoke.mjs [--output <directory> | --tarball <file>]'
)

const suppliedTarball =
  packageMode === '--tarball'
    ? path.resolve(projectRoot, packagePath)
    : undefined
const outputDirectory =
  packageMode === '--output'
    ? path.resolve(projectRoot, packagePath)
    : undefined

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'portal-package-'))

try {
  const packDirectory = path.join(temporaryRoot, 'pack')
  const globalPrefix = path.join(temporaryRoot, 'global-prefix')
  const workspaceDirectory = path.join(temporaryRoot, 'workspace')
  await Promise.all([
    mkdir(packDirectory),
    mkdir(globalPrefix),
    mkdir(workspaceDirectory),
    ...(outputDirectory === undefined
      ? []
      : [mkdir(outputDirectory, { recursive: true })]),
  ])

  let pack
  let tarball
  if (suppliedTarball !== undefined) {
    await access(suppliedTarball)
    tarball = suppliedTarball
    const auditResult = runNode(
      [
        npmCli,
        'pack',
        '--silent',
        '--json',
        '--dry-run',
        '--ignore-scripts',
        tarball,
      ],
      { cwd: packDirectory }
    )
    const packs = JSON.parse(auditResult.stdout)
    assert.equal(packs.length, 1)
    pack = packs[0]
  } else {
    const packDestination = outputDirectory ?? packDirectory
    const packResult = runNode(
      [
        npmCli,
        'pack',
        '--silent',
        '--json',
        '--pack-destination',
        packDestination,
      ],
      { cwd: projectRoot }
    )
    const packs = JSON.parse(packResult.stdout)
    assert.equal(packs.length, 1)
    pack = packs[0]
    tarball = path.join(packDestination, pack.filename)
  }
  auditPack(pack)

  const unavailableGit = path.join(temporaryRoot, 'unavailable-git')
  const installEnvironment = {
    ...process.env,
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
  }
  for (const key of Object.keys(installEnvironment)) {
    if (key.toLowerCase() === 'npm_config_git') {
      delete installEnvironment[key]
    }
  }
  installEnvironment.npm_config_git = unavailableGit
  const configuredGit = runNode([npmCli, 'config', 'get', 'git'], {
    env: installEnvironment,
  }).stdout.trim()
  assert.equal(path.resolve(configuredGit), unavailableGit)
  const gitProbe = spawnSync(unavailableGit, ['--version'], {
    env: installEnvironment,
    encoding: 'utf8',
  })
  assert.equal(
    gitProbe.error?.code,
    'ENOENT',
    'configured Git must be unavailable'
  )

  runNode(
    [
      npmCli,
      'install',
      '--global',
      '--prefix',
      globalPrefix,
      '--no-audit',
      '--no-fund',
      tarball,
    ],
    { env: installEnvironment, timeout: 300_000 }
  )

  const globalNodeModules = path.join(
    globalPrefix,
    process.platform === 'win32' ? 'node_modules' : 'lib/node_modules'
  )
  const binDirectory = path.join(
    globalPrefix,
    process.platform === 'win32' ? '' : 'bin'
  )
  const portalBin = path.join(
    binDirectory,
    process.platform === 'win32' ? 'portal.cmd' : 'portal'
  )
  assert.equal(await pathExists(portalBin), true, 'npm must create the CLI bin')
  const installedPackage = path.join(globalNodeModules, '@kabxx', 'portal')

  const versionResult = runInstalledPortal(portalBin, ['--version'], {
    cwd: workspaceDirectory,
    env: installEnvironment,
  })
  assertNoModuleTypeWarning(versionResult)
  const version = versionResult.stdout.trim()
  assert.equal(version, packageMetadata.version)

  const helpResult = runInstalledPortal(portalBin, ['--help'], {
    cwd: workspaceDirectory,
    env: installEnvironment,
  })
  assertNoModuleTypeWarning(helpResult)
  const help = helpResult.stdout
  assert.match(help, /--data-dir <path>/)
  assert.equal(
    await pathExists(path.join(workspaceDirectory, 'data')),
    false,
    'CLI metadata commands must not create workspace data'
  )

  const installedMetadata = JSON.parse(
    await readFile(path.join(installedPackage, 'package.json'), 'utf8')
  )
  const installedInkMetadata = JSON.parse(
    await readFile(path.join(installedPackage, 'dist', 'package.json'), 'utf8')
  )
  assert.equal(installedMetadata.name, packageMetadata.name)
  assert.equal(installedMetadata.version, packageMetadata.version)
  assert.equal(installedInkMetadata.name, 'ink')
  assert.equal(typeof installedInkMetadata.version, 'string')
  assert.equal(installedInkMetadata.type, 'module')
  const installedEntry = await readFile(
    path.join(installedPackage, 'dist', 'index.js'),
    'utf8'
  )
  assert.match(installedEntry, /^#!\/usr\/bin\/env node\r?\n/)
  for (const buildOnlyDependency of ['ink', 'markdansi']) {
    assert.equal(
      await pathExists(
        path.join(installedPackage, 'node_modules', buildOnlyDependency)
      ),
      false,
      `${buildOnlyDependency} must not be installed as a runtime dependency`
    )
  }

  const inkBundle = await readFile(
    path.join(installedPackage, 'dist', 'vendor', 'ink.js'),
    'utf8'
  )
  const markdansiBundle = await readFile(
    path.join(installedPackage, 'dist', 'vendor', 'markdansi.js'),
    'utf8'
  )
  assert.doesNotMatch(inkBundle, /from\s+["']ink(?:\/|["'])/)
  assert.doesNotMatch(markdansiBundle, /from\s+["']markdansi(?:\/|["'])/)
  assert.match(inkBundle, /koffi/)

  runNode(
    [
      '--input-type=module',
      '--eval',
      [
        "import { createRequire } from 'node:module'",
        "import { existsSync, readFileSync } from 'node:fs'",
        "import path from 'node:path'",
        'const require = createRequire(process.env.PORTAL_PACKAGE_JSON)',
        "for (const name of ['fs-native-extensions', 'koffi', '7zip-bin']) require(name)",
        "let koffiRoot = path.dirname(require.resolve('koffi'))",
        'let koffiMetadata = null',
        "for (let depth = 0; depth < 5; depth += 1) { const metadataPath = path.join(koffiRoot, 'package.json'); if (existsSync(metadataPath)) { const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')); if (metadata.name === 'koffi') { koffiMetadata = metadata; break } } koffiRoot = path.dirname(koffiRoot) }",
        "if (koffiMetadata === null) throw new Error('Unable to locate the Koffi package root')",
        "if (!existsSync(path.join(koffiRoot, 'cnoke.cjs'))) throw new Error('koffi/cnoke.cjs is missing')",
        "const Database = require('better-sqlite3')",
        "const database = new Database(':memory:')",
        "if (database.prepare('select 1 as value').get().value !== 1) throw new Error('SQLite probe failed')",
        'database.close()',
      ].join(';'),
    ],
    {
      env: {
        ...installEnvironment,
        PORTAL_PACKAGE_JSON: path.join(installedPackage, 'package.json'),
      },
    }
  )

  runNode(
    [
      '--input-type=module',
      '--eval',
      [
        "import { createRequire } from 'node:module'",
        'const require = createRequire(process.env.PORTAL_PACKAGE_JSON)',
        "const { createElement } = require('react')",
        'const entry = new URL(process.env.PORTAL_INK_ENTRY, import.meta.url)',
        'const ink = await import(entry.href)',
        'const markdansi = await import(new URL(process.env.PORTAL_MARKDANSI_ENTRY, import.meta.url).href)',
        "const output = ink.renderToString(createElement(ink.Text, null, 'package-smoke'))",
        "if (!output.includes('package-smoke')) throw new Error('Ink bundle did not render')",
        "const markdown = markdansi.render('**package-smoke**', { color: false, hyperlinks: false })",
        "if (!markdown.includes('package-smoke')) throw new Error('Markdansi bundle did not render')",
      ].join(';'),
    ],
    {
      env: {
        ...installEnvironment,
        DEV: 'true',
        PORTAL_PACKAGE_JSON: path.join(installedPackage, 'package.json'),
        PORTAL_INK_ENTRY: pathToFileURL(
          path.join(installedPackage, 'dist', 'vendor', 'ink.js')
        ).href,
        PORTAL_MARKDANSI_ENTRY: pathToFileURL(
          path.join(installedPackage, 'dist', 'vendor', 'markdansi.js')
        ).href,
      },
    }
  )

  console.log(
    JSON.stringify({
      package: `${packageMetadata.name}@${packageMetadata.version}`,
      platform: `${process.platform}-${process.arch}`,
      packedBytes: (await stat(tarball)).size,
      ...(pack === undefined
        ? {}
        : {
            unpackedBytes: pack.unpackedSize,
            entries: pack.entryCount,
          }),
    })
  )
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}

function assertNoLocalDependencies(dependencies) {
  const local = Object.entries(dependencies ?? {}).filter(([, value]) =>
    /^(?:file|link):/.test(value)
  )
  assert.deepEqual(local, [], 'published dependencies must not use local paths')
}

function auditPack(pack) {
  assert.equal(pack.name, '@kabxx/portal')
  assert.equal(pack.version, packageMetadata.version)
  assert.deepEqual(pack.bundled ?? [], [])

  const allowedFiles = pack.files.map(({ path: filePath }) => filePath)
  for (const required of [
    'LICENSE',
    'README.md',
    'dist/index.js',
    'dist/package.json',
    'dist/THIRD-PARTY-NOTICES.txt',
    'dist/vendor/ink.js',
    'dist/vendor/markdansi.js',
    'package.json',
  ]) {
    assert.ok(
      allowedFiles.includes(required),
      `missing package file: ${required}`
    )
  }
  assert.ok(
    allowedFiles.some((filePath) => filePath.startsWith('dist/vendor/chunks/')),
    'tarball must contain the generated vendor chunks'
  )
  assert.deepEqual(
    allowedFiles.filter((filePath) =>
      /(^|\/)node_modules(?:\/|$)/.test(filePath)
    ),
    [],
    'tarball must not contain node_modules'
  )
  assert.deepEqual(
    allowedFiles.filter((filePath) => !isAllowedPackagePath(filePath)),
    [],
    'tarball contains an unexpected top-level path'
  )
}

function isAllowedPackagePath(filePath) {
  return (
    filePath === 'LICENSE' ||
    filePath === 'README.md' ||
    filePath === 'package.json' ||
    filePath.startsWith('dist/')
  )
}

function runNode(args, options = {}) {
  return run(process.execPath, args, options)
}

function runInstalledPortal(portalBin, args, options) {
  if (process.platform === 'win32') {
    return run(
      process.env.ComSpec ?? 'cmd.exe',
      ['/d', '/s', '/c', portalBin, ...args],
      options
    )
  }
  return run(portalBin, args, options)
}

function assertNoModuleTypeWarning(result) {
  assert.doesNotMatch(result.stderr, /MODULE_TYPELESS_PACKAGE_JSON/)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
    timeout: options.timeout ?? 120_000,
  })
  if (result.error !== undefined) {
    throw result.error
  }
  assert.equal(
    result.status,
    0,
    [
      `${command} ${args.join(' ')} exited with ${String(result.status)}`,
      result.stdout,
      result.stderr,
    ].join('\n')
  )
  return result
}

async function pathExists(target) {
  try {
    await access(target)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false
    }
    throw error
  }
}
