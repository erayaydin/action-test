import * as fs from 'node:fs'
import * as path from 'node:path'
import { loadConfig, mapSourceToTarget, getManagedTargetDirs } from './config'
import { resolveRefs } from './resolve'
import { filterFile, filterFiles } from './filter'
import { computeDiff } from './diff'
import { writeFiles, deleteFiles } from './writer'
import { handlePrLifecycle } from './pr'
import type { DiffResult, SyncConfig } from './types'

/** Parse CLI arguments into a key-value map. */
function parseArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = args[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        result[key] = next
        i++
      } else {
        result[key] = 'true'
      }
    }
  }
  return result
}

/** Write a GitHub Actions output variable. */
function setOutput(name: string, value: string): void {
  const outputFile = process.env.GITHUB_OUTPUT
  if (outputFile) {
    const delimiter = 'EOF_OPENAPI_SYNC'
    fs.appendFileSync(outputFile, `${name}<<${delimiter}\n${value}\n${delimiter}\n`)
  }
}

/** Format a collapsible file list as a markdown details block. */
function formatFileSection(title: string, files: string[]): string[] {
  return ['', '<details>', `<summary>${title}</summary>`, '', ...files.map((f) => `- \`${f}\``), '', '</details>']
}

/** Generate the markdown body for the target PR. */
function generatePrBody(diff: DiffResult): string {
  const lines: string[] = [
    'This PR automatically updates the OpenAPI schema.',
    '',
    '### Changes',
    '',
    `**${diff.summary}**`,
  ]

  if (diff.modified.length > 0) {
    lines.push(...formatFileSection('Modified files', diff.modified))
  }

  if (diff.added.length > 0) {
    lines.push(...formatFileSection('Added files', diff.added))
  }

  if (diff.deleted.length > 0) {
    lines.push(...formatFileSection('Deleted files', diff.deleted))
  }

  lines.push(
    '',
    '---',
    '',
    '**Note for reviewers**: Please review the schema changes.',
    'You likely need to manually add a changeset file to this PR before merging.'
  )

  return lines.join('\n')
}

/** Resolve refs, filter internal content, and map source paths to target paths. */
async function syncMultiFile(config: SyncConfig, sourceRoot: string): Promise<Map<string, string>> {
  console.log('Resolving $ref graph...')
  const reachableFiles = await resolveRefs(config.entrypoint, sourceRoot)
  console.log(`Found ${reachableFiles.size} reachable files`)

  const sourceFiles = new Map<string, string>()
  for (const filePath of reachableFiles) {
    const absPath = path.resolve(sourceRoot, filePath)
    sourceFiles.set(filePath, fs.readFileSync(absPath, 'utf-8'))
  }

  console.log('Filtering internal content...')
  const filterResult = filterFiles(sourceFiles, reachableFiles, config.internal)
  for (const warning of filterResult.warnings) {
    console.warn(warning)
  }
  console.log(`Filtered: ${filterResult.filtered.size} files kept, ${filterResult.excludedFiles.size} files excluded`)

  const targetFiles = new Map<string, string>()
  for (const [sourcePath, content] of filterResult.filtered) {
    const targetPath = mapSourceToTarget(config, sourcePath)
    if (targetPath) {
      targetFiles.set(targetPath, content)
    } else {
      console.warn(`Warning: No mapping for source file: ${sourcePath}`)
    }
  }

  return targetFiles
}

/** Read the pre-bundled file, strip internal fields, and map to target path. */
function syncBundled(config: SyncConfig, sourceRoot: string): Map<string, string> {
  const bundledFile = config.bundled_file
  if (!bundledFile) {
    console.error('Error: bundled_file is required in bundled mode')
    process.exit(1)
  }

  const absPath = path.resolve(sourceRoot, bundledFile)
  const content = fs.readFileSync(absPath, 'utf-8')

  const result = filterFile(content, config.internal)
  for (const warning of result.warnings) {
    console.warn(warning)
  }

  const targetFiles = new Map<string, string>()
  if (result.content !== null) {
    const targetPath = mapSourceToTarget(config, bundledFile)
    if (targetPath) {
      targetFiles.set(targetPath, result.content)
    }
  }

  return targetFiles
}

/** Run the sync pipeline: load config, build target files, compute diff, and apply changes. */
async function runSync(args: Record<string, string>): Promise<void> {
  const configPath = args['config']
  const sourceRoot = args['source-root'] ?? '.'
  const targetRoot = args['target-root'] ?? 'target'
  const dryRun = args['dry-run'] === 'true'

  if (!configPath) {
    console.error('Error: --config is required')
    process.exit(1)
  }

  console.log(`Loading config from ${configPath}`)
  const config = loadConfig(configPath)
  console.log(`Mode: ${config.mode}, Entrypoint: ${config.entrypoint}`)

  const targetFiles =
    config.mode === 'multi_file' ? await syncMultiFile(config, sourceRoot) : syncBundled(config, sourceRoot)

  const managedDirs = getManagedTargetDirs(config)
  console.log('Computing diff...')
  const diff = computeDiff(targetFiles, targetRoot, managedDirs)

  setOutput('has_diff', String(diff.hasDiff))
  setOutput('diff_summary', diff.summary)

  if (!diff.hasDiff) {
    console.log('No meaningful changes detected.')
    return
  }

  console.log(`Changes: ${diff.summary}`)

  if (dryRun) {
    console.log('Dry run — skipping file writes.')
    if (diff.added.length > 0) {
      console.log('Added:', diff.added.join(', '))
    }
    if (diff.modified.length > 0) {
      console.log('Modified:', diff.modified.join(', '))
    }
    if (diff.deleted.length > 0) {
      console.log('Deleted:', diff.deleted.join(', '))
    }
    return
  }

  writeFiles(targetFiles, targetRoot)
  deleteFiles(diff.deleted, targetRoot)
  console.log('Files written successfully.')

  const prBody = generatePrBody(diff)
  setOutput('pr_body', prBody)
}

/** Run the PR lifecycle: comment on source PR and add/remove target PR warning. */
async function runPr(args: Record<string, string>): Promise<void> {
  const githubToken = process.env.GITHUB_TOKEN
  const sourceRepo = args['source-repo']
  const sourcePr = args['source-pr']
  const sourcePrMerged = args['source-pr-merged']
  const targetRepo = args['target-repo']
  const targetPr = args['target-pr']

  if (!githubToken || !sourceRepo || !sourcePr || !targetRepo || !targetPr) {
    console.error(
      'Error: GITHUB_TOKEN env var, --source-repo, --source-pr, --target-repo, and --target-pr are required'
    )
    process.exit(1)
  }

  await handlePrLifecycle({
    githubToken,
    sourceRepo,
    sourcePrNumber: parseInt(sourcePr, 10),
    sourcePrMerged: sourcePrMerged === 'true',
    targetRepo,
    targetPrNumber: parseInt(targetPr, 10),
  })

  console.log('PR lifecycle actions completed.')
}

/** CLI entrypoint — dispatches to `sync` or `pr` subcommand. */
async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const subcommand = args[0]
  const parsedArgs = parseArgs(args.slice(1))

  if (subcommand === undefined) {
    console.error('Error: subcommand is required')
    console.error('Usage: node dist/index.js <sync|pr> [options]')
    process.exit(1)
  }

  switch (subcommand) {
    case 'sync':
      await runSync(parsedArgs)
      break
    case 'pr':
      await runPr(parsedArgs)
      break
    default:
      console.error(`Unknown subcommand: ${subcommand}`)
      console.error('Usage: node dist/index.js <sync|pr> [options]')
      process.exit(1)
  }
}

main().catch((error: unknown) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
