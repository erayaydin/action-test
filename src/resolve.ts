import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as yaml from 'js-yaml'

/** Walk the $ref graph starting from an entrypoint file and return all reachable file paths. */
export async function resolveRefs(entrypoint: string, sourceRoot: string): Promise<Set<string>> {
  const visited = new Set<string>()
  const normalizedEntry = path.relative(sourceRoot, path.resolve(sourceRoot, entrypoint))
  await walkFile(normalizedEntry, sourceRoot, visited)
  return visited
}

/** Recursively visit a file, parse its $refs, and walk each referenced file. */
async function walkFile(relPath: string, sourceRoot: string, visited: Set<string>): Promise<void> {
  if (visited.has(relPath)) {
    return
  }
  visited.add(relPath)

  const absPath = path.resolve(sourceRoot, relPath)
  let content: string
  try {
    content = await fs.readFile(absPath, 'utf-8')
  } catch {
    console.warn(`Warning: Referenced file not found: ${relPath}`)
    return
  }

  // Only parse YAML files for refs
  const ext = path.extname(relPath).toLowerCase()
  if (ext !== '.yaml' && ext !== '.yml') {
    return
  }

  let doc: unknown
  try {
    doc = yaml.load(content)
  } catch {
    console.warn(`Warning: Failed to parse YAML in: ${relPath}`)
    return
  }

  const currentDir = path.dirname(relPath)
  const refs = extractFileRefs(doc, currentDir)

  for (const ref of refs) {
    await walkFile(ref, sourceRoot, visited)
  }
}

/** Extract all external file $ref paths from a parsed YAML document. */
function extractFileRefs(node: unknown, currentDir: string): string[] {
  const refs: string[] = []
  collectRefs(node, currentDir, refs)
  return refs
}

/** Recursively walk a parsed node, collecting resolved file paths from $ref values. */
function collectRefs(node: unknown, currentDir: string, refs: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      collectRefs(item, currentDir, refs)
    }
    return
  }

  if (typeof node !== 'object' || node === null) {
    return
  }

  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref' && typeof value === 'string') {
      // Skip internal refs (within same file)
      if (value.startsWith('#')) {
        continue
      }

      // Extract file path from fragment refs: ./foo.yaml#/schemas/Bar -> ./foo.yaml
      const filePart = value.split('#')[0]
      if (filePart.length === 0) {
        continue
      }

      // Resolve relative to current directory and normalize
      const resolved = path.normalize(path.join(currentDir, filePart))
      // Normalize to forward slashes
      const normalized = resolved.split(path.sep).join('/')
      refs.push(normalized)
    } else {
      collectRefs(value, currentDir, refs)
    }
  }
}
