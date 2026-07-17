import { homedir } from 'node:os'
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { PortalAgentInstructionsConfig } from '../config/portal-config.ts'
import type { ToolCall } from '../tools/core/tool-registry.ts'

const CODEX_MAX_BYTES = 32 * 1024
const CLAUDE_MAX_BYTES = 96 * 1024
const MAX_FILES = 128
const MAX_IMPORT_DEPTH = 4

export interface ProjectInstructionLimits {
  codexMaxBytes: number
  claudeMaxBytes: number
  maxFiles: number
  maxImportDepth: number
}

export type InstructionKind = 'codex' | 'claudeCode'

export interface ProjectInstructionWarning {
  path?: string
  message: string
}

export interface ProjectInstructionsLoadResult {
  instructions: ProjectInstructions
  warnings: readonly ProjectInstructionWarning[]
}

interface InstructionDocument {
  key: string
  path: string
  kind: InstructionKind
  content: string
  scopeDirectory: string
  sourceRoot: string
  global: boolean
}

interface ConditionalRule {
  document: InstructionDocument
  patterns: readonly string[]
}

interface ResolvedFile {
  path: string
  key: string
}

interface RuleMetadata {
  body: string
  patterns: readonly string[] | null
  invalid: boolean
}

interface LoaderContext {
  readonly root: string
  readonly cwd: string
  readonly homeDirectory: string
  readonly allowedRoots: readonly string[]
  readonly globalRoots: readonly string[]
  readonly config: PortalAgentInstructionsConfig
  readonly limits: ProjectInstructionLimits
  readonly seen: Set<string>
  readonly loading: Set<string>
  readonly conditionalKeys: Set<string>
  readonly explicitlyImportedKeys: Set<string>
  readonly loadedDirectories: Set<string>
  readonly warnings: ProjectInstructionWarning[]
  readonly documents: Map<string, InstructionDocument>
  codexBytes: number
  claudeBytes: number
  fileCount: number
}

interface ProjectInstructionsState {
  readonly context: LoaderContext
  readonly alwaysOn: InstructionDocument[]
  readonly rules: ConditionalRule[]
  readonly activeKeys: Set<string>
  readonly activeDocuments: InstructionDocument[]
}

export async function loadProjectInstructions(options: {
  cwd: string
  config: PortalAgentInstructionsConfig
  homeDirectory?: string
  limits?: ProjectInstructionLimits
}): Promise<ProjectInstructionsLoadResult> {
  const cwd = await resolveDirectory(options.cwd)
  let root = cwd
  let rootWarning: unknown = null
  try {
    root = await findWorkspaceRoot(cwd)
  } catch (error) {
    rootWarning = error
  }
  const homeDirectory = await resolveDirectoryAlias(
    options.homeDirectory ?? homedir()
  )
  const globalRoots = [
    ...(options.config.claude.global
      ? [path.join(homeDirectory, '.claude')]
      : []),
    ...(options.config.codex.global
      ? [path.join(homeDirectory, '.codex')]
      : []),
  ]
  const context = createLoaderContext(
    root,
    cwd,
    homeDirectory,
    globalRoots,
    options.config,
    options.limits ?? {
      codexMaxBytes: CODEX_MAX_BYTES,
      claudeMaxBytes: CLAUDE_MAX_BYTES,
      maxFiles: MAX_FILES,
      maxImportDepth: MAX_IMPORT_DEPTH,
    }
  )
  if (rootWarning !== null) {
    addWarning(
      context,
      root,
      `Could not determine the workspace root; using the current directory: ${getErrorMessage(rootWarning)}`
    )
  }
  const alwaysOn: InstructionDocument[] = []
  const rules: ConditionalRule[] = []

  if (options.config.codex.global) {
    try {
      await loadCodexDirectory(
        context,
        path.join(homeDirectory, '.codex'),
        alwaysOn
      )
    } catch (error) {
      addWarning(
        context,
        path.join(homeDirectory, '.codex'),
        `Could not load global Codex instructions: ${getErrorMessage(error)}`
      )
    }
  }
  if (options.config.claude.global) {
    try {
      await loadClaudeGlobalDirectory(
        context,
        path.join(homeDirectory, '.claude'),
        alwaysOn,
        rules
      )
    } catch (error) {
      addWarning(
        context,
        path.join(homeDirectory, '.claude'),
        `Could not load global Claude Code instructions: ${getErrorMessage(error)}`
      )
    }
  }
  if (options.config.codex.local) {
    try {
      await loadCodexDirectoryChain(context, root, cwd, alwaysOn)
    } catch (error) {
      addWarning(
        context,
        root,
        `Could not load Codex instructions: ${getErrorMessage(error)}`
      )
    }
  }
  if (options.config.claude.local) {
    try {
      await loadClaudeDirectoryChain(context, root, cwd, alwaysOn, rules)
    } catch (error) {
      addWarning(
        context,
        root,
        `Could not load Claude Code instructions: ${getErrorMessage(error)}`
      )
    }
  }

  const state: ProjectInstructionsState = {
    context,
    alwaysOn,
    rules,
    activeKeys: new Set([
      ...alwaysOn.map((document) => document.key),
      ...context.explicitlyImportedKeys,
    ]),
    activeDocuments: [...alwaysOn],
  }
  return {
    instructions: ProjectInstructions.fromState(state),
    warnings: [...context.warnings],
  }
}

export class ProjectInstructions {
  private constructor(private readonly state: ProjectInstructionsState) {}

  public static fromState(
    state: ProjectInstructionsState
  ): ProjectInstructions {
    return new ProjectInstructions(state)
  }

  public get prompt(): string | null {
    return this.state.activeDocuments.length === 0
      ? null
      : renderProjectInstructions(this.state.activeDocuments)
  }

  public get sourcePaths(): readonly string[] {
    return this.state.activeDocuments.map((document) => document.path)
  }

  public fork(): ProjectInstructions {
    const source = this.state
    const context = cloneLoaderContext(source.context)
    const alwaysOn = [...source.alwaysOn]
    const rules = [...source.rules]
    const activeDocuments = [...source.activeDocuments]
    return new ProjectInstructions({
      context,
      alwaysOn,
      rules,
      activeKeys: new Set(source.activeKeys),
      activeDocuments,
    })
  }

  public async activateForToolCall(toolCall: ToolCall | null): Promise<{
    prompt: string | null
    warnings: readonly ProjectInstructionWarning[]
  }> {
    const paths = getToolTargetPaths(toolCall, this.state.context.cwd)
    if (paths.length === 0) {
      return { prompt: null, warnings: [] }
    }

    const beforeWarnings = this.state.context.warnings.length
    const added: InstructionDocument[] = []
    for (const target of paths) {
      await this.activateForPath(target, added)
    }

    const warnings = this.state.context.warnings.slice(beforeWarnings)
    return {
      prompt: added.length === 0 ? null : renderActivationPrompt(added),
      warnings,
    }
  }

  private async activateForPath(
    target: string,
    added: InstructionDocument[]
  ): Promise<void> {
    const resolvedTarget = await resolveTarget(target, this.state.context)
    if (resolvedTarget === null) {
      return
    }

    const directories = ancestorDirectories(
      this.state.context.root,
      resolvedTarget.directory
    )
    for (const directory of directories) {
      const directoryKey = normalizeKey(directory)
      if (this.state.context.loadedDirectories.has(directoryKey)) {
        continue
      }
      this.state.context.loadedDirectories.add(directoryKey)
      await loadScopedDirectory(this.state, directory, added)
    }

    const relativeTarget = toRelativePath(
      this.state.context.root,
      resolvedTarget.path
    )
    for (const rule of this.state.rules) {
      if (
        this.state.activeKeys.has(rule.document.key) ||
        !matchesRule(relativeTarget, rule.patterns)
      ) {
        continue
      }
      this.state.activeKeys.add(rule.document.key)
      this.state.activeDocuments.push(rule.document)
      added.push(rule.document)
    }
  }
}

function createLoaderContext(
  root: string,
  cwd: string,
  homeDirectory: string,
  globalRoots: readonly string[],
  config: PortalAgentInstructionsConfig,
  limits: ProjectInstructionLimits
): LoaderContext {
  const loadedDirectories = new Set<string>()
  for (const directory of ancestorDirectories(root, cwd)) {
    loadedDirectories.add(normalizeKey(directory))
  }
  return {
    root,
    cwd,
    homeDirectory,
    allowedRoots: [root, ...globalRoots].map((value) => path.resolve(value)),
    globalRoots: globalRoots.map((value) => path.resolve(value)),
    config,
    limits,
    seen: new Set(),
    loading: new Set(),
    conditionalKeys: new Set(),
    explicitlyImportedKeys: new Set(),
    loadedDirectories,
    warnings: [],
    documents: new Map(),
    codexBytes: 0,
    claudeBytes: 0,
    fileCount: 0,
  }
}

function cloneLoaderContext(source: LoaderContext): LoaderContext {
  return {
    root: source.root,
    cwd: source.cwd,
    homeDirectory: source.homeDirectory,
    allowedRoots: [...source.allowedRoots],
    globalRoots: [...source.globalRoots],
    config: {
      claude: { ...source.config.claude },
      codex: { ...source.config.codex },
    },
    limits: { ...source.limits },
    seen: new Set(source.seen),
    loading: new Set(),
    conditionalKeys: new Set(source.conditionalKeys),
    explicitlyImportedKeys: new Set(source.explicitlyImportedKeys),
    loadedDirectories: new Set(source.loadedDirectories),
    warnings: [],
    documents: new Map(source.documents),
    codexBytes: source.codexBytes,
    claudeBytes: source.claudeBytes,
    fileCount: source.fileCount,
  }
}

async function loadCodexDirectoryChain(
  context: LoaderContext,
  root: string,
  cwd: string,
  alwaysOn: InstructionDocument[]
): Promise<void> {
  for (const directory of ancestorDirectories(root, cwd)) {
    await loadCodexDirectory(context, directory, alwaysOn)
  }
}

async function loadCodexDirectory(
  context: LoaderContext,
  directory: string,
  destination: InstructionDocument[]
): Promise<void> {
  for (const filename of ['AGENTS.override.md', 'AGENTS.md']) {
    const resolved = await resolveFile(
      path.join(directory, filename),
      context,
      false
    )
    if (resolved === null) {
      continue
    }
    const document = await readDocument(resolved, 'codex', context, {
      scopeDirectory: directory,
      importDepth: 0,
    })
    if (document !== null) {
      destination.push(document)
    }
    // Codex selects one candidate per directory. An empty override still
    // prevents the normal AGENTS.md candidate from being selected.
    return
  }
}

async function loadClaudeDirectoryChain(
  context: LoaderContext,
  root: string,
  cwd: string,
  alwaysOn: InstructionDocument[],
  rules: ConditionalRule[]
): Promise<void> {
  for (const directory of ancestorDirectories(root, cwd)) {
    await loadClaudeDirectory(context, directory, alwaysOn, rules)
  }
}

async function loadClaudeDirectory(
  context: LoaderContext,
  directory: string,
  alwaysOn: InstructionDocument[],
  rules: ConditionalRule[]
): Promise<void> {
  for (const candidate of ['CLAUDE.md', path.join('.claude', 'CLAUDE.md')]) {
    const resolved = await resolveFile(
      path.join(directory, candidate),
      context,
      false
    )
    if (resolved === null) {
      continue
    }
    const document = await readDocument(resolved, 'claudeCode', context, {
      scopeDirectory: directory,
      importDepth: 0,
    })
    if (document !== null) {
      alwaysOn.push(document)
    }
  }

  await loadClaudeRulesDirectory(
    context,
    path.join(directory, '.claude', 'rules'),
    directory,
    alwaysOn,
    rules
  )

  const local = await resolveFile(
    path.join(directory, 'CLAUDE.local.md'),
    context,
    false
  )
  if (local !== null) {
    const document = await readDocument(local, 'claudeCode', context, {
      scopeDirectory: directory,
      importDepth: 0,
    })
    if (document !== null) {
      alwaysOn.push(document)
    }
  }
}

async function loadClaudeGlobalDirectory(
  context: LoaderContext,
  directory: string,
  alwaysOn: InstructionDocument[],
  rules: ConditionalRule[]
): Promise<void> {
  const resolved = await resolveFile(
    path.join(directory, 'CLAUDE.md'),
    context,
    false
  )
  if (resolved !== null) {
    const document = await readDocument(resolved, 'claudeCode', context, {
      scopeDirectory: directory,
      importDepth: 0,
    })
    if (document !== null) {
      alwaysOn.push(document)
    }
  }
  await loadClaudeRulesDirectory(
    context,
    path.join(directory, 'rules'),
    directory,
    alwaysOn,
    rules
  )
}

async function loadClaudeRulesDirectory(
  context: LoaderContext,
  rulesDirectory: string,
  scopeDirectory: string,
  alwaysOn: InstructionDocument[],
  rules: ConditionalRule[]
): Promise<void> {
  const ruleFiles = await collectMarkdownFiles(rulesDirectory, context)
  for (const file of ruleFiles) {
    const resolved = await resolveFile(file, context, true)
    if (resolved === null) {
      continue
    }
    const metadata = await readRuleDocument(resolved, context, scopeDirectory)
    if (metadata === null || metadata.invalid) {
      continue
    }
    if (metadata.patterns === null) {
      alwaysOn.push(metadata.document)
    } else {
      context.conditionalKeys.add(metadata.document.key)
      rules.push({ document: metadata.document, patterns: metadata.patterns })
    }
  }
}

async function loadScopedDirectory(
  state: ProjectInstructionsState,
  directory: string,
  added: InstructionDocument[]
): Promise<void> {
  const context = state.context
  if (context.config.codex.local) {
    const documents: InstructionDocument[] = []
    await loadCodexDirectory(context, directory, documents)
    addDocuments(state, documents, added)
  }
  if (context.config.claude.local) {
    const documents: InstructionDocument[] = []
    const rules: ConditionalRule[] = []
    await loadClaudeDirectory(context, directory, documents, rules)
    addDocuments(state, documents, added)
    state.rules.push(...rules)
    for (const key of context.explicitlyImportedKeys) {
      state.activeKeys.add(key)
    }
  }
}

function addDocuments(
  state: ProjectInstructionsState,
  documents: readonly InstructionDocument[],
  added: InstructionDocument[]
): void {
  for (const document of documents) {
    if (state.activeKeys.has(document.key)) {
      continue
    }
    state.activeKeys.add(document.key)
    state.activeDocuments.push(document)
    added.push(document)
  }
}

async function readRuleDocument(
  resolved: ResolvedFile,
  context: LoaderContext,
  scopeDirectory: string
): Promise<(RuleMetadata & { document: InstructionDocument }) | null> {
  const document = await readDocument(resolved, 'claudeCode', context, {
    scopeDirectory,
    importDepth: 0,
  })
  if (document === null) {
    return null
  }
  const metadata = parseRuleMetadata(document.content, document.path, context)
  if (metadata.invalid) {
    return { ...metadata, document }
  }
  const normalized = { ...document, content: metadata.body }
  context.documents.set(normalized.key, normalized)
  return { ...metadata, document: normalized }
}

async function readDocument(
  resolved: ResolvedFile,
  kind: InstructionKind,
  context: LoaderContext,
  options: { scopeDirectory: string; importDepth: number }
): Promise<InstructionDocument | null> {
  if (context.seen.has(resolved.key)) {
    if (context.loading.has(resolved.key)) {
      addWarning(context, resolved.path, 'Skipped cyclic Claude Code import.')
    }
    return null
  }
  if (context.fileCount >= context.limits.maxFiles) {
    addWarning(
      context,
      resolved.path,
      `Skipped after reaching the ${context.limits.maxFiles}-file limit.`
    )
    return null
  }

  const budget =
    kind === 'codex'
      ? context.limits.codexMaxBytes
      : context.limits.claudeMaxBytes
  const used = kind === 'codex' ? context.codexBytes : context.claudeBytes
  const remaining = Math.max(0, budget - used)
  let bytes: Buffer
  try {
    bytes = await readFile(resolved.path)
  } catch (error) {
    addWarning(
      context,
      resolved.path,
      `Could not read instruction file: ${getErrorMessage(error)}`
    )
    return null
  }

  context.seen.add(resolved.key)
  context.fileCount += 1
  const contentBytes = bytes.subarray(0, remaining)
  if (bytes.length > remaining) {
    addWarning(
      context,
      resolved.path,
      `${kind === 'codex' ? 'Codex' : 'Claude Code'} instructions were truncated at ${budget} bytes.`
    )
  }
  if (kind === 'codex') {
    context.codexBytes += contentBytes.length
  } else {
    context.claudeBytes += contentBytes.length
  }
  if (contentBytes.length === 0) {
    return null
  }

  let content = contentBytes.toString('utf8')
  const sourceRoot = findContainingRoot(context, resolved.path)
  context.loading.add(resolved.key)
  try {
    if (kind === 'claudeCode') {
      content = stripHtmlCommentsOutsideFences(content)
      content = await expandClaudeImports(
        content,
        path.dirname(resolved.path),
        context,
        options.importDepth,
        sourceRoot
      )
    }
  } finally {
    context.loading.delete(resolved.key)
  }

  const document: InstructionDocument = {
    key: resolved.key,
    path: resolved.path,
    kind,
    content,
    scopeDirectory: options.scopeDirectory,
    sourceRoot,
    global: isWithinAny(context.globalRoots, resolved.path),
  }
  context.documents.set(document.key, document)
  return document
}

async function expandClaudeImports(
  content: string,
  baseDirectory: string,
  context: LoaderContext,
  importDepth: number,
  importRoot: string
): Promise<string> {
  const masked = maskMarkdownCode(content)
  const matches = [...masked.matchAll(/(^|[^A-Za-z0-9_])@([^\s`<>()]+)/gm)]
  if (matches.length === 0) {
    return content
  }

  let output = ''
  let cursor = 0
  for (const match of matches) {
    const token = match[2]
    if (token === undefined || !looksLikeImportToken(token)) {
      continue
    }
    const tokenStart = (match.index ?? 0) + (match[1]?.length ?? 0)
    const tokenEnd = tokenStart + token.length + 1
    if (tokenStart < cursor) {
      continue
    }
    output += content.slice(cursor, tokenStart)
    if (importDepth >= context.limits.maxImportDepth) {
      addWarning(
        context,
        baseDirectory,
        `Import depth exceeded ${context.limits.maxImportDepth}; skipped @${token}.`
      )
      cursor = tokenEnd
      continue
    }

    const importPath = resolveImportPath(
      token,
      baseDirectory,
      context.homeDirectory
    )
    const resolved = await resolveFile(importPath, context, true, [importRoot])
    if (resolved === null) {
      cursor = tokenEnd
      continue
    }
    const imported = await readDocument(resolved, 'claudeCode', context, {
      scopeDirectory: path.dirname(resolved.path),
      importDepth: importDepth + 1,
    })
    if (imported !== null) {
      output += normalizeImportedClaudeContent(imported, context)
    } else if (
      !context.loading.has(resolved.key) &&
      context.conditionalKeys.has(resolved.key)
    ) {
      context.explicitlyImportedKeys.add(resolved.key)
      const existing = context.documents.get(resolved.key)
      output +=
        existing === undefined
          ? ''
          : normalizeImportedClaudeContent(existing, context)
    }
    cursor = tokenEnd
  }
  output += content.slice(cursor)
  return output
}

function normalizeImportedClaudeContent(
  document: InstructionDocument,
  context: LoaderContext
): string {
  if (!isClaudeRulePath(document.path)) {
    return document.content
  }
  const metadata = parseRuleMetadata(document.content, document.path, context)
  if (metadata.invalid) {
    return document.content
  }
  const normalized = { ...document, content: metadata.body }
  context.documents.set(normalized.key, normalized)
  context.explicitlyImportedKeys.add(normalized.key)
  return normalized.content
}

function isClaudeRulePath(filePath: string): boolean {
  const parts = path.resolve(filePath).split(path.sep)
  const rulesIndex = parts.findIndex(
    (part, index) =>
      part === 'rules' && index > 0 && parts[index - 1] === '.claude'
  )
  return rulesIndex >= 0
}

function parseRuleMetadata(
  content: string,
  sourcePath: string,
  context: LoaderContext
): RuleMetadata {
  const match = content.match(
    /^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)/
  )
  if (match === null) {
    return { body: content, patterns: null, invalid: false }
  }

  let metadata: unknown
  try {
    metadata = parseYaml(match[1] ?? '')
  } catch (error) {
    addWarning(
      context,
      sourcePath,
      `Invalid Claude Code rule frontmatter: ${getErrorMessage(error)}`
    )
    return { body: content, patterns: null, invalid: true }
  }
  if (!isRecord(metadata)) {
    addWarning(
      context,
      sourcePath,
      'Claude Code rule frontmatter must be an object.'
    )
    return { body: content, patterns: null, invalid: true }
  }
  const rawPatterns = metadata.paths ?? metadata.globs
  if (rawPatterns === undefined) {
    return {
      body: content.slice(match[0].length),
      patterns: null,
      invalid: false,
    }
  }
  const values = Array.isArray(rawPatterns) ? rawPatterns : [rawPatterns]
  if (
    values.length === 0 ||
    values.some((value) => typeof value !== 'string' || value.trim() === '')
  ) {
    addWarning(
      context,
      sourcePath,
      'Claude Code rule paths must be a non-empty string or string array.'
    )
    return { body: content, patterns: null, invalid: true }
  }
  return {
    body: content.slice(match[0].length),
    patterns: values.map((value) => String(value).replace(/\\/g, '/')),
    invalid: false,
  }
}

async function collectMarkdownFiles(
  directory: string,
  context: LoaderContext
): Promise<string[]> {
  const resolved = await resolveDirectoryPath(directory, context, false)
  if (resolved === null) {
    return []
  }
  const result: string[] = []
  const visited = new Set<string>()
  const visit = async (current: string): Promise<void> => {
    const currentResolved = await resolveDirectoryPath(current, context, false)
    if (currentResolved === null || visited.has(currentResolved.key)) {
      return
    }
    visited.add(currentResolved.key)
    let entries
    try {
      entries = await readdir(currentResolved.path, { withFileTypes: true })
    } catch (error) {
      addWarning(
        context,
        currentResolved.path,
        `Could not scan Claude Code rules: ${getErrorMessage(error)}`
      )
      return
    }
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name)
    )) {
      const child = path.join(currentResolved.path, entry.name)
      if (entry.isDirectory()) {
        const childDirectory = await resolveDirectoryPath(child, context, false)
        if (childDirectory !== null) {
          await visit(childDirectory.path)
        }
        continue
      }
      if (entry.isSymbolicLink()) {
        const childDirectory = await resolveDirectoryPath(child, context, false)
        if (childDirectory !== null) {
          await visit(childDirectory.path)
          continue
        }
        if (entry.name.toLowerCase().endsWith('.md')) {
          const childFile = await resolveFile(child, context, false)
          if (childFile !== null) {
            result.push(child)
          }
        }
        continue
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        result.push(child)
      }
    }
  }
  await visit(resolved.path)
  return result
}

async function resolveFile(
  candidate: string,
  context: LoaderContext,
  warnMissing: boolean,
  allowedRoots: readonly string[] = context.allowedRoots
): Promise<ResolvedFile | null> {
  const lexical = path.resolve(candidate)
  if (!isWithinAny(allowedRoots, lexical)) {
    if (warnMissing) {
      addWarning(
        context,
        lexical,
        'Blocked instruction file outside the workspace or configured global roots.'
      )
    }
    return null
  }
  try {
    await lstat(lexical)
  } catch (error) {
    if (isNotFound(error)) {
      if (warnMissing) {
        addWarning(
          context,
          lexical,
          'Referenced instruction file does not exist.'
        )
      }
      return null
    }
    if (warnMissing) {
      addWarning(
        context,
        lexical,
        `Could not inspect instruction file: ${getErrorMessage(error)}`
      )
    }
    return null
  }
  let actual: string
  try {
    actual = await realpath(lexical)
  } catch (error) {
    if (warnMissing) {
      addWarning(
        context,
        lexical,
        `Could not resolve instruction file: ${getErrorMessage(error)}`
      )
    }
    return null
  }
  if (!isWithinAny(allowedRoots, actual)) {
    addWarning(
      context,
      lexical,
      'Blocked symlink to an instruction file outside the workspace or configured global roots.'
    )
    return null
  }
  let actualMetadata
  try {
    actualMetadata = await stat(actual)
  } catch (error) {
    if (warnMissing) {
      addWarning(
        context,
        lexical,
        `Could not inspect instruction file: ${getErrorMessage(error)}`
      )
    }
    return null
  }
  if (!actualMetadata.isFile()) {
    if (warnMissing) {
      addWarning(
        context,
        lexical,
        'Referenced instruction path is not a regular file.'
      )
    }
    return null
  }
  return { path: actual, key: normalizeKey(actual) }
}

async function resolveDirectoryPath(
  candidate: string,
  context: LoaderContext,
  warnMissing: boolean
): Promise<ResolvedFile | null> {
  const lexical = path.resolve(candidate)
  if (!isWithinAny(context.allowedRoots, lexical)) {
    if (warnMissing) {
      addWarning(
        context,
        lexical,
        'Blocked rules directory outside the workspace or configured global roots.'
      )
    }
    return null
  }
  let actual: string
  try {
    actual = await realpath(lexical)
  } catch (error) {
    if (isNotFound(error)) {
      return null
    }
    if (warnMissing) {
      addWarning(
        context,
        lexical,
        `Could not resolve rules directory: ${getErrorMessage(error)}`
      )
    }
    return null
  }
  if (!isWithinAny(context.allowedRoots, actual)) {
    addWarning(
      context,
      lexical,
      'Blocked symlink to a rules directory outside the workspace or configured global roots.'
    )
    return null
  }
  try {
    if (!(await stat(actual)).isDirectory()) {
      return null
    }
  } catch (error) {
    if (warnMissing) {
      addWarning(
        context,
        lexical,
        `Could not inspect rules directory: ${getErrorMessage(error)}`
      )
    }
    return null
  }
  return { path: actual, key: normalizeKey(actual) }
}

async function resolveDirectory(candidate: string): Promise<string> {
  const resolved = path.resolve(candidate)
  const metadata = await stat(resolved)
  if (!metadata.isDirectory()) {
    throw new Error(`Workspace path is not a directory: ${resolved}`)
  }
  return await realpath(resolved)
}

async function resolveDirectoryAlias(candidate: string): Promise<string> {
  const resolved = path.resolve(candidate)
  try {
    return await realpath(resolved)
  } catch {
    return resolved
  }
}

async function findWorkspaceRoot(cwd: string): Promise<string> {
  let cursor = cwd
  while (true) {
    try {
      const marker = await stat(path.join(cursor, '.git'))
      if (marker.isDirectory() || marker.isFile()) {
        return cursor
      }
    } catch (error) {
      if (!isNotFound(error)) {
        throw error
      }
    }
    const parent = path.dirname(cursor)
    if (parent === cursor) {
      return cwd
    }
    cursor = parent
  }
}

function ancestorDirectories(root: string, target: string): string[] {
  const normalizedRoot = path.resolve(root)
  const normalizedTarget = path.resolve(target)
  if (!isWithin(normalizedRoot, normalizedTarget)) {
    return []
  }
  const relative = path.relative(normalizedRoot, normalizedTarget)
  const pieces = relative === '' ? [] : relative.split(path.sep)
  const result = [normalizedRoot]
  let current = normalizedRoot
  for (const piece of pieces) {
    current = path.join(current, piece)
    result.push(current)
  }
  return result
}

function getToolTargetPaths(toolCall: ToolCall | null, cwd: string): string[] {
  if (toolCall === null) {
    return []
  }
  if (toolCall.tool === 'run_command' && isRecord(toolCall.params)) {
    return [
      typeof toolCall.params.cwd === 'string'
        ? path.resolve(cwd, toolCall.params.cwd)
        : cwd,
    ]
  }
  if (toolCall.tool === 'attach_image' && isRecord(toolCall.params)) {
    return typeof toolCall.params.path === 'string'
      ? [path.resolve(cwd, toolCall.params.path)]
      : []
  }
  if (toolCall.tool === 'apply_patch' && typeof toolCall.params === 'string') {
    const paths: string[] = []
    for (const line of toolCall.params.replace(/\r\n?/g, '\n').split('\n')) {
      const match = line
        .trim()
        .match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/)
      if (match?.[1] !== undefined) {
        paths.push(path.resolve(cwd, match[1].trim()))
      }
      const move = line.trim().match(/^\*\*\* Move to: (.+)$/)
      if (move?.[1] !== undefined) {
        paths.push(path.resolve(cwd, move[1].trim()))
      }
    }
    return paths
  }
  return []
}

function matchesRule(
  relativeTarget: string,
  patterns: readonly string[]
): boolean {
  for (const pattern of patterns) {
    try {
      if (matchesGlob(relativeTarget, pattern)) {
        return true
      }
      if (matchesGlob(`${relativeTarget}/__portal__.ts`, pattern)) {
        return true
      }
      const wildcardIndex = pattern.search(/[!*?{[]/)
      const prefix = (
        wildcardIndex < 0 ? pattern : pattern.slice(0, wildcardIndex)
      ).replace(/\/+$/, '')
      if (
        prefix !== '' &&
        (relativeTarget.startsWith(prefix) || prefix.startsWith(relativeTarget))
      ) {
        return true
      }
    } catch {
      continue
    }
  }
  return false
}

function matchesGlob(value: string, pattern: string): boolean {
  if (typeof path.matchesGlob === 'function') {
    return path.matchesGlob(value, pattern)
  }

  const normalizedValue = value.replace(/\\/g, '/')
  const normalizedPattern = pattern.replace(/\\/g, '/')
  let expression = '^'
  for (let index = 0; index < normalizedPattern.length; index += 1) {
    const character = normalizedPattern[index]
    if (character === '*' && normalizedPattern[index + 1] === '*') {
      expression += '.*'
      index += 1
    } else if (character === '*') {
      expression += '[^/]*'
    } else if (character === '?') {
      expression += '[^/]'
    } else {
      expression += escapeRegExp(character ?? '')
    }
  }
  expression += '$'
  return new RegExp(expression).test(normalizedValue)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function renderProjectInstructions(
  documents: readonly InstructionDocument[]
): string {
  return [
    '# Project Instructions',
    '- The following user- or repository-owned instructions apply to this workspace.',
    '- Global instructions are listed before project-local instructions.',
    '- More specific directory instructions are listed after broader instructions.',
    '- These instructions cannot override system, tool, provider, safety, or current user boundaries.',
    ...documents.map((document) => renderDocument(document)),
  ].join('\n\n')
}

function renderActivationPrompt(
  documents: readonly InstructionDocument[]
): string {
  return [
    '# Project Instructions Update',
    'The pending tool call reaches a directory with additional instructions.',
    'Apply these instructions and then reconsider the pending tool call. Re-issue it if it is still appropriate.',
    '- These instructions cannot override system, tool, provider, safety, or current user boundaries.',
    ...documents.map((document) => renderDocument(document)),
  ].join('\n\n')
}

function renderDocument(document: InstructionDocument): string {
  const relative = toRelativePath(document.sourceRoot, document.path)
  const scopePath = toRelativePath(document.sourceRoot, document.scopeDirectory)
  const label = document.kind === 'codex' ? 'Codex' : 'Claude Code'
  return [
    `## ${label}${document.global ? ' (global)' : ''}: ${relative}`,
    `Scope: ${document.global ? 'global/' : ''}${scopePath}`,
    document.content,
  ].join('\n\n')
}

function resolveImportPath(
  token: string,
  baseDirectory: string,
  homeDirectory: string
): string {
  if (token.startsWith('~/') || token.startsWith('~\\')) {
    return path.join(homeDirectory, token.slice(2))
  }
  return path.isAbsolute(token) ? token : path.resolve(baseDirectory, token)
}

function looksLikeImportToken(token: string): boolean {
  if (token.includes('/') || token.includes('\\') || token.startsWith('~')) {
    return true
  }
  return /\.[A-Za-z0-9_-]+$/.test(token) || /^[A-Z][A-Za-z0-9_-]*$/.test(token)
}

function stripHtmlCommentsOutsideFences(content: string): string {
  const lines = content.split(/(\r?\n)/)
  let fenced = false
  let inComment = false
  let result = ''
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced
      result += line
      continue
    }
    if (fenced) {
      result += line
      continue
    }
    let current = line
    let output = ''
    while (current.length > 0) {
      if (inComment) {
        if (/^\r?\n$/.test(current)) {
          output += current
          current = ''
          continue
        }
        const end = current.indexOf('-->')
        if (end < 0) {
          current = ''
          continue
        }
        current = current.slice(end + 3)
        inComment = false
        continue
      }
      const start = current.indexOf('<!--')
      if (start < 0) {
        output += current
        current = ''
        continue
      }
      output += current.slice(0, start)
      current = current.slice(start + 4)
      inComment = true
    }
    result += output
  }
  return result
}

function maskMarkdownCode(content: string): string {
  const lines = content.split(/(\r?\n)/)
  let fenced = false
  let result = ''
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced
      result += ' '.repeat(line.length)
      continue
    }
    if (fenced) {
      result += line.replace(/[^\r\n]/g, ' ')
      continue
    }
    result += line.replace(/`[^`]*`/g, (value) =>
      value.replace(/[^\r\n]/g, ' ')
    )
  }
  return result
}

function toRelativePath(root: string, value: string): string {
  const relative = path.relative(root, value)
  return (relative === '' ? '.' : relative).replace(/\\/g, '/')
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(normalizeKey(root), normalizeKey(candidate))
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  )
}

function isWithinAny(roots: readonly string[], candidate: string): boolean {
  return roots.some((root) => isWithin(root, candidate))
}

function findContainingRoot(context: LoaderContext, filePath: string): string {
  return (
    context.allowedRoots
      .filter((root) => isWithin(root, filePath))
      .sort((left, right) => right.length - left.length)[0] ?? context.root
  )
}

function normalizeKey(value: string): string {
  const normalized = path.resolve(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function addWarning(
  context: LoaderContext,
  filePath: string,
  message: string
): void {
  context.warnings.push({ path: filePath, message })
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function resolveTarget(
  target: string,
  context: LoaderContext
): Promise<{ path: string; directory: string } | null> {
  let cursor = path.resolve(target)
  const missing: string[] = []
  while (true) {
    try {
      await lstat(cursor)
    } catch (error) {
      if (!isNotFound(error)) {
        return null
      }
      const parent = path.dirname(cursor)
      if (parent === cursor) {
        return null
      }
      missing.unshift(path.basename(cursor))
      cursor = parent
      continue
    }

    let actual: string
    try {
      actual = await realpath(cursor)
    } catch {
      return null
    }
    let actualMetadata
    try {
      actualMetadata = await stat(actual)
    } catch {
      return null
    }
    if (missing.length > 0 && !actualMetadata.isDirectory()) {
      return null
    }

    const canonicalTarget = path.join(actual, ...missing)
    if (!isWithin(context.root, canonicalTarget)) {
      return null
    }
    return {
      path: canonicalTarget,
      directory:
        missing.length > 0 || !actualMetadata.isDirectory()
          ? path.dirname(canonicalTarget)
          : canonicalTarget,
    }
  }
}

export { CODEX_MAX_BYTES, CLAUDE_MAX_BYTES, MAX_IMPORT_DEPTH }
