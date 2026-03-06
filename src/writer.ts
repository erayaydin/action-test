import * as fs from 'node:fs'
import * as path from 'node:path'

/** Write new files to the target directory. */
export function writeFiles(files: Map<string, string>, targetRoot: string): void {
  for (const [targetPath, content] of files) {
    const absPath = path.resolve(targetRoot, targetPath)
    const dir = path.dirname(absPath)

    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(absPath, content, 'utf-8')
  }
}

/** Delete files from the target directory. */
export function deleteFiles(filePaths: string[], targetRoot: string): void {
  for (const filePath of filePaths) {
    const absPath = path.resolve(targetRoot, filePath)

    if (fs.existsSync(absPath)) {
      fs.unlinkSync(absPath)
    }
  }

  // Clean up empty directories
  const dirs = new Set<string>()
  for (const filePath of filePaths) {
    let dir = path.dirname(filePath)
    while (dir !== '.') {
      dirs.add(dir)
      dir = path.dirname(dir)
    }
  }
  const sortedDirs = [...dirs].sort((a, b) => b.split('/').length - a.split('/').length)

  for (const dir of sortedDirs) {
    const absDir = path.resolve(targetRoot, dir)
    if (fs.existsSync(absDir)) {
      const entries = fs.readdirSync(absDir)
      if (entries.length === 0) {
        fs.rmdirSync(absDir)
      }
    }
  }
}
