import assert from 'node:assert/strict'
import { access, readFile, rm, mkdtemp, mkdir, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const packageMetadata = JSON.parse(
  await readFile(path.join(projectRoot, 'package.json'), 'utf8')
)
const packageLock = JSON.parse(
  await readFile(path.join(projectRoot, 'package-lock.json'), 'utf8')
)
const portalRuntimePackages = new Map([
  ['@kabxx/ink', '7.1.1-portal.1'],
  ['@kabxx/markdansi', '0.3.3-portal.1'],
])
const PACKAGE_INSTALL_TIMEOUT_MS = 600_000
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
assertNoNonRegistryDependencies(packageMetadata.dependencies)
assertRegistryRuntimePackages(packageMetadata, packageLock)
assert.equal(
  packageLock.packages?.['node_modules/prebuild-install'],
  undefined,
  'production lockfile must not contain deprecated prebuild-install'
)
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

  const installResult = runNode(
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
    { env: installEnvironment, timeout: PACKAGE_INSTALL_TIMEOUT_MS }
  )
  assert.doesNotMatch(
    `${installResult.stdout}\n${installResult.stderr}`,
    /prebuild-install|npm warn deprecated/i,
    'package installation must not emit dependency deprecation warnings'
  )
  const installedTree = JSON.parse(
    runNode(
      [npmCli, 'ls', '--global', '--prefix', globalPrefix, '--all', '--json'],
      { env: installEnvironment }
    ).stdout
  )
  assertDependencyAbsent(installedTree, 'prebuild-install')

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
  assert.match(help, /^Commands:\r?$/m)
  assert.match(help, /^ {2}exec \[options\] \[task\] {2}/m)
  assert.match(help, /^ {2}config \[options\] {7}/m)
  const execHelpResult = runInstalledPortal(portalBin, ['exec', '--help'], {
    cwd: workspaceDirectory,
    env: installEnvironment,
  })
  assertNoModuleTypeWarning(execHelpResult)
  assert.match(execHelpResult.stdout, /--provider <provider>/)
  assert.match(execHelpResult.stdout, /--timeout <seconds>/)
  const configDataDirectory = path.join(workspaceDirectory, 'config-probe')
  const configResult = runInstalledPortal(
    portalBin,
    ['config', '--data-dir', configDataDirectory],
    { cwd: workspaceDirectory, env: installEnvironment }
  )
  assertNoModuleTypeWarning(configResult)
  assert.equal(
    configResult.stdout,
    `${path.join(configDataDirectory, 'config.yaml')}\n`
  )
  assert.equal(configResult.stderr, '')
  assert.equal(
    await pathExists(configDataDirectory),
    false,
    'portal config must not create the selected data directory'
  )
  const invalidOptionResult = runInstalledPortal(
    portalBin,
    ['--portal-invalid-option'],
    {
      cwd: workspaceDirectory,
      env: installEnvironment,
      expectedStatus: 1,
    }
  )
  assert.match(invalidOptionResult.stderr, /unknown option/i)
  assert.equal(
    await pathExists(path.join(workspaceDirectory, 'data')),
    false,
    'CLI metadata commands must not create workspace data'
  )
  const pluginDataDirectory = path.join(workspaceDirectory, 'plugin-probe')
  const pluginList = runInstalledPortal(
    portalBin,
    ['plugins', '--data-dir', pluginDataDirectory, '--json', 'list'],
    { cwd: workspaceDirectory, env: installEnvironment }
  )
  const installedPlugins = JSON.parse(pluginList.stdout)
  assert.ok(
    installedPlugins.some(
      (record) =>
        record.manifest?.id === 'portal.tool.run-command' &&
        record.enabled === true
    )
  )
  const disablePlugin = runInstalledPortal(
    portalBin,
    [
      'plugins',
      '--data-dir',
      pluginDataDirectory,
      'disable',
      'portal.tool.run-command',
    ],
    { cwd: workspaceDirectory, env: installEnvironment }
  )
  assert.match(disablePlugin.stdout, /Disabled portal\.tool\.run-command/)
  const enablePlugin = runInstalledPortal(
    portalBin,
    [
      'plugins',
      '--data-dir',
      pluginDataDirectory,
      'enable',
      'portal.tool.run-command',
    ],
    { cwd: workspaceDirectory, env: installEnvironment }
  )
  assert.match(enablePlugin.stdout, /Enabled portal\.tool\.run-command/)

  const installedMetadata = JSON.parse(
    await readFile(path.join(installedPackage, 'package.json'), 'utf8')
  )
  assert.equal(installedMetadata.name, packageMetadata.name)
  assert.equal(installedMetadata.version, packageMetadata.version)
  const installedRequire = createRequire(
    path.join(installedPackage, 'package.json')
  )
  for (const [name, expectedVersion] of portalRuntimePackages) {
    assert.equal(installedMetadata.dependencies?.[name], expectedVersion)
    const dependencyRoot = await findInstalledPackageRoot(
      installedRequire.resolve(name),
      name
    )
    const dependencyMetadata = JSON.parse(
      await readFile(path.join(dependencyRoot, 'package.json'), 'utf8')
    )
    assert.equal(dependencyMetadata.name, name)
    assert.equal(dependencyMetadata.version, expectedVersion)
  }
  const installedEntry = await readFile(
    path.join(installedPackage, 'dist', 'index.js'),
    'utf8'
  )
  assert.match(installedEntry, /^#!\/usr\/bin\/env node\r?\n/)
  for (const obsoleteDependency of ['ink', 'markdansi']) {
    assert.equal(
      await pathExists(path.join(globalNodeModules, obsoleteDependency)),
      false,
      `${obsoleteDependency} must not be installed as an unscoped dependency`
    )
  }

  const inkFacade = await readFile(
    path.join(installedPackage, 'dist', 'vendor', 'ink.js'),
    'utf8'
  )
  const markdansiFacade = await readFile(
    path.join(installedPackage, 'dist', 'vendor', 'markdansi.js'),
    'utf8'
  )
  assert.match(inkFacade, /from\s+["']@kabxx\/ink["']/)
  assert.match(markdansiFacade, /from\s+["']@kabxx\/markdansi["']/)

  runNode(
    [
      '--input-type=module',
      '--eval',
      [
        "import { createRequire } from 'node:module'",
        'const require = createRequire(process.env.PORTAL_PACKAGE_JSON)',
        "for (const name of ['fs-native-extensions', '7zip-bin']) require(name)",
        "const koffi = require('koffi')",
        "if (typeof koffi.load !== 'function') throw new Error('Koffi native API did not load')",
        "const Database = require('better-sqlite3')",
        'let database = new Database(process.env.PORTAL_SQLITE_PATH)',
        "database.pragma('journal_mode = WAL')",
        "database.exec('CREATE TABLE package_smoke (id INTEGER PRIMARY KEY, value TEXT NOT NULL)')",
        "const write = database.transaction(() => { database.prepare('INSERT INTO package_smoke (value) VALUES (?)').run('created'); database.prepare('UPDATE package_smoke SET value = ? WHERE id = 1').run('updated') })",
        'write()',
        'database.close()',
        'database = new Database(process.env.PORTAL_SQLITE_PATH)',
        "if (database.prepare('SELECT value FROM package_smoke WHERE id = 1').get().value !== 'updated') throw new Error('SQLite persistence probe failed')",
        "if (database.pragma('journal_mode', { simple: true }) !== 'wal') throw new Error('SQLite WAL probe failed')",
        'database.close()',
      ].join(';'),
    ],
    {
      env: {
        ...installEnvironment,
        PORTAL_PACKAGE_JSON: path.join(installedPackage, 'package.json'),
        PORTAL_SQLITE_PATH: path.join(workspaceDirectory, 'package-smoke.db'),
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
        "if (!output.includes('package-smoke')) throw new Error('Ink facade did not render')",
        "const markdown = markdansi.render('**package-smoke**', { color: false, hyperlinks: false })",
        "if (!markdown.includes('package-smoke')) throw new Error('Markdansi facade did not render')",
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

function assertNoNonRegistryDependencies(dependencies) {
  const nonRegistry = Object.entries(dependencies ?? {}).filter(([, value]) =>
    /^(?:file|git|github|gitlab|bitbucket|link|workspace)(?:\+[^:]+)?:/i.test(
      value
    )
  )
  assert.deepEqual(
    nonRegistry,
    [],
    'published dependencies must use registry versions'
  )
}

function assertRegistryRuntimePackages(metadata, lock) {
  const rootLock = lock.packages?.['']
  assert.ok(rootLock, 'package lock must contain the project root')
  for (const [name, expectedVersion] of portalRuntimePackages) {
    assert.equal(metadata.dependencies?.[name], expectedVersion)
    assert.equal(metadata.devDependencies?.[name], undefined)
    assert.equal(rootLock.dependencies?.[name], expectedVersion)
    assert.equal(rootLock.devDependencies?.[name], undefined)
    const lockEntry = lock.packages?.[`node_modules/${name}`]
    assert.ok(lockEntry, `package lock must contain ${name}`)
    assert.equal(lockEntry.version, expectedVersion)
    assert.equal(lockEntry.dev, undefined)
    assert.match(lockEntry.resolved, /^https:\/\/registry\.npmjs\.org\//)
    assert.equal(typeof lockEntry.integrity, 'string')
  }
  assert.equal(metadata.devDependencies?.ink, undefined)
  assert.equal(metadata.devDependencies?.markdansi, undefined)
  assert.equal(lock.packages?.['node_modules/ink'], undefined)
  assert.equal(lock.packages?.['node_modules/markdansi'], undefined)
}

function assertDependencyAbsent(tree, packageName) {
  const visit = (node) => {
    for (const [name, dependency] of Object.entries(node.dependencies ?? {})) {
      assert.notEqual(name, packageName, `${packageName} must not be installed`)
      if (dependency !== null && typeof dependency === 'object') {
        visit(dependency)
      }
    }
  }
  visit(tree)
}

function auditPack(pack) {
  assert.equal(pack.name, '@kabxx/portal')
  assert.equal(pack.version, packageMetadata.version)
  assert.deepEqual(pack.bundled ?? [], [])
  const allowedFiles = pack.files.map(({ path: filePath }) => filePath)
  assert.equal(pack.entryCount, allowedFiles.length)
  for (const required of [
    'LICENSE',
    'README.md',
    'README.zh-CN.md',
    'dist/agents/agent-extension.js',
    'dist/agents/agent-host.js',
    'dist/agents/portal-agent-plugin.js',
    'dist/cli-entry.js',
    'dist/cli-commands/builtin-commands.js',
    'dist/cli-commands/core/command-plan.js',
    'dist/cli-commands/core/command-runtime.js',
    'dist/bootstrap/first-party-plugins.js',
    'dist/bootstrap/kernel-bootstrap.js',
    'dist/bootstrap/plugins-command.js',
    'dist/attachments/attachment-service.js',
    'dist/exec/exec-command.js',
    'dist/exec/exec-surface-plugin.js',
    'dist/extensions/extension-registry.js',
    'dist/extensions/plugin-manager.js',
    'dist/extensions/plugin-store.js',
    'dist/extensions/portal-hooks.js',
    'dist/host/portal-host.js',
    'dist/host/portal-command-services.js',
    'dist/index.js',
    'dist/mcp-server/mcp-server.js',
    'dist/mcp-server/mcp-command-plugin.js',
    'dist/mcp-server/mcp-surface-plugin.js',
    'dist/providers/portal-action-protocol.js',
    'dist/providers/provider-host.js',
    'dist/prompts/prompt-extension.js',
    'dist/prompts/prompt-host.js',
    'dist/prompts/portal-prompt-plugin.js',
    'dist/skills/skill-plugin.js',
    'dist/surfaces/surface-host.js',
    'dist/tools/tool-host.js',
    'dist/vendor/ink.js',
    'dist/vendor/markdansi.js',
    'package.json',
  ]) {
    assert.ok(
      allowedFiles.includes(required),
      `missing package file: ${required}`
    )
  }
  assert.deepEqual(
    allowedFiles.filter(
      (filePath) =>
        filePath === 'CONTRIBUTING.md' ||
        filePath === 'SECURITY.md' ||
        filePath.startsWith('docs/')
    ),
    [],
    'tarball must not contain contributor, security, or docs files'
  )
  assert.deepEqual(
    allowedFiles.filter(
      (filePath) =>
        filePath === 'dist/package.json' ||
        filePath === 'dist/THIRD-PARTY-NOTICES.txt' ||
        filePath.startsWith('dist/vendor/chunks/')
    ),
    [],
    'tarball must not contain obsolete vendor bundle artifacts'
  )
  assert.deepEqual(
    allowedFiles.filter(
      (filePath) =>
        filePath.startsWith('dist/api/') ||
        filePath.startsWith('dist/mcp/') ||
        [
          'dist/cli-commands/commands/command-serve.js',
          'dist/terminal-ui/skill-hints.js',
          'dist/tools/builtins/load-skill-tool.js',
          'dist/tools/builtins/mcp-call-tool.js',
          'dist/tools/builtins/mcp-search-tool.js',
        ].includes(filePath)
    ),
    [],
    'tarball must not contain unavailable package surfaces'
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
    filePath === 'README.zh-CN.md' ||
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
    options.expectedStatus ?? 0,
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

async function findInstalledPackageRoot(entryPath, expectedName) {
  let directory = path.dirname(entryPath)
  while (true) {
    const metadataPath = path.join(directory, 'package.json')
    try {
      const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
      if (metadata.name === expectedName) return directory
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    const parent = path.dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  throw new Error(`Unable to locate installed package root for ${expectedName}`)
}
