import * as fs from 'node:fs'
import * as path from 'node:path'
import type { DiffResult } from './types'

/** Normalize content. */
function normalizeContent(content: string): string {
  return content
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trimEnd()
}

/** Recursively collect all files under a directory, returning paths relative to baseDir. */
function collectFiles(dir: string, baseDir: string): string[] {
  const results: string[] = []

  if (!fs.existsSync(dir)) {
    return results
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...collectFiles(fullPath, baseDir))
    } else if (entry.isFile()) {
      results.push(path.relative(baseDir, fullPath).split(path.sep).join('/'))
    }
  }

  return results
}

/**
 * Detect differences between new content and the existing target directory.
 *
 * @param newFiles - Map of target-relative paths to new content
 * @param targetRoot - Absolute path to the target directory root
 * @param managedDirs - List of target-relative directory paths that this sync manages.
 */
export function computeDiff(newFiles: Map<string, string>, targetRoot: string, managedDirs: string[]): DiffResult {
  const added: string[] = []
  const modified: string[] = []
  const deleted: string[] = []

  // Check new files
  for (const [targetPath, newContent] of newFiles) {
    const absPath = path.resolve(targetRoot, targetPath)

    if (!fs.existsSync(absPath)) {
      added.push(targetPath)
      continue
    }

    const existingContent = fs.readFileSync(absPath, 'utf-8')
    if (normalizeContent(existingContent) !== normalizeContent(newContent)) {
      modified.push(targetPath)
    }
  }

  // Check deleted files
  for (const managedDir of managedDirs) {
    const absDir = path.resolve(targetRoot, managedDir)
    const existingFiles = collectFiles(absDir, targetRoot)

    for (const existingFile of existingFiles) {
      if (!newFiles.has(existingFile)) {
        deleted.push(existingFile)
      }
    }
  }

  // Deduplicate deleted files
  const uniqueDeleted = [...new Set(deleted)]
  uniqueDeleted.sort()
  added.sort()
  modified.sort()

  const hasDiff = added.length > 0 || modified.length > 0 || uniqueDeleted.length > 0

  const parts: string[] = []
  if (modified.length > 0) {
    parts.push(`${modified.length} file(s) modified`)
  }
  if (added.length > 0) {
    parts.push(`${added.length} file(s) added`)
  }
  if (uniqueDeleted.length > 0) {
    parts.push(`${uniqueDeleted.length} file(s) deleted`)
  }
  const summary = parts.length > 0 ? parts.join(', ') : 'No changes'

  return { hasDiff, added, modified, deleted: uniqueDeleted, summary }
}
