import assert from 'node:assert/strict'
import { access, readFile, rm, mkdtemp, mkdir, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const packageMetadata = JSON.parse(
  await readFile(path.join(projectRoot, 'package.json'), 'utf8')
)
const npmCli = process.env.npm_execpath
const [packageMode, packagePath, ...extraArguments] = process.argv.slice(2)

assert.equal(typeof npmCli, 'string', 'npm_execpath must identify the npm CLI')
assert.equal(packageMetadata.name, '@kabxx/portal')
assert.equal(packageMetadata.bin?.portal, 'dist/index.js')
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
  const installDirectory = path.join(temporaryRoot, 'install')
  const workspaceDirectory = path.join(temporaryRoot, 'workspace')
  await Promise.all([
    mkdir(packDirectory),
    mkdir(installDirectory),
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

    assert.equal(pack.name, '@kabxx/portal')
    assert.equal(pack.version, packageMetadata.version)
    assert.deepEqual(
      ['ink', 'markdansi'].filter((name) => !pack.bundled.includes(name)),
      [],
      'Ink and Markdansi must be bundled'
    )
    assert.equal(pack.bundled.includes('koffi'), false)
    assert.deepEqual(
      pack.bundled.filter((name) => name.startsWith('@koromix/koffi-')),
      []
    )

    const allowedFiles = pack.files.map(({ path: filePath }) => filePath)
    for (const required of [
      'LICENSE',
      'README.md',
      'dist/index.js',
      'package.json',
    ]) {
      assert.ok(
        allowedFiles.includes(required),
        `missing package file: ${required}`
      )
    }
    assert.deepEqual(
      allowedFiles.filter((filePath) => !isAllowedPackagePath(filePath)),
      [],
      'tarball contains an unexpected top-level path'
    )

    const builtEntry = await readFile(
      path.join(projectRoot, 'dist', 'index.js'),
      'utf8'
    )
    assert.match(builtEntry, /^#!\/usr\/bin\/env node\r?\n/)
  }

  const installEnvironment = withoutGitOnPath({
    ...process.env,
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
  })
  const gitProbe = spawnSync('git', ['--version'], {
    env: installEnvironment,
    encoding: 'utf8',
  })
  assert.equal(gitProbe.error?.code, 'ENOENT', 'Git must not be visible')

  runNode(
    [
      npmCli,
      'install',
      '--prefix',
      installDirectory,
      '--no-audit',
      '--no-fund',
      tarball,
    ],
    { env: installEnvironment }
  )

  const binDirectory = path.join(installDirectory, 'node_modules', '.bin')
  const portalBin = path.join(
    binDirectory,
    process.platform === 'win32' ? 'portal.cmd' : 'portal'
  )
  assert.equal(await pathExists(portalBin), true, 'npm must create the CLI bin')

  const version = runInstalledPortal(installDirectory, ['--version'], {
    cwd: workspaceDirectory,
    env: installEnvironment,
  }).stdout.trim()
  assert.equal(version, packageMetadata.version)

  const help = runInstalledPortal(installDirectory, ['--help'], {
    cwd: workspaceDirectory,
    env: installEnvironment,
  }).stdout
  assert.match(help, /--data-dir <path>/)
  assert.equal(
    await pathExists(path.join(workspaceDirectory, 'data')),
    false,
    'CLI metadata commands must not create workspace data'
  )

  const installedPackage = path.join(
    installDirectory,
    'node_modules',
    '@kabxx',
    'portal'
  )
  const installedMetadata = JSON.parse(
    await readFile(path.join(installedPackage, 'package.json'), 'utf8')
  )
  assert.equal(installedMetadata.name, packageMetadata.name)
  assert.equal(installedMetadata.version, packageMetadata.version)
  for (const bundledDependency of ['ink', 'markdansi']) {
    assert.equal(
      await pathExists(
        path.join(installedPackage, 'node_modules', bundledDependency)
      ),
      true,
      `${bundledDependency} must be installed from the bundle`
    )
  }

  runNode(
    [
      '--input-type=module',
      '--eval',
      [
        "import { createRequire } from 'node:module'",
        'const require = createRequire(process.env.PORTAL_PACKAGE_JSON)',
        "for (const name of ['better-sqlite3', 'fs-native-extensions', 'koffi', '7zip-bin']) require(name)",
      ].join(';'),
    ],
    {
      env: {
        ...installEnvironment,
        PORTAL_PACKAGE_JSON: path.join(installedPackage, 'package.json'),
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

function isAllowedPackagePath(filePath) {
  return (
    filePath === 'LICENSE' ||
    filePath === 'README.md' ||
    filePath === 'package.json' ||
    filePath.startsWith('dist/') ||
    filePath.startsWith('node_modules/')
  )
}

function withoutGitOnPath(environment) {
  const pathKey =
    Object.keys(environment).find((key) => key.toLowerCase() === 'path') ??
    'PATH'
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === 'path' && key !== pathKey) {
      delete environment[key]
    }
  }
  environment[pathKey] = path.dirname(process.execPath)
  return environment
}

function runNode(args, options = {}) {
  return run(process.execPath, args, options)
}

function runInstalledPortal(installDirectory, args, options) {
  return runNode(
    [
      npmCli,
      'exec',
      '--prefix',
      installDirectory,
      '--offline',
      '--',
      'portal',
      ...args,
    ],
    options
  )
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
    timeout: 120_000,
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
