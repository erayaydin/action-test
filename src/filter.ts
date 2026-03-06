import * as path from 'node:path'
import * as yaml from 'js-yaml'
import { minimatch } from 'minimatch'
import type { InternalConfig } from './types'
import { isRecord } from './utils'

const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'trace'])

export interface FilterFileResult {
  content: string | null
  warnings: string[]
}

export interface FilterFilesResult {
  filtered: Map<string, string>
  excludedFiles: Set<string>
  warnings: string[]
}

/** Check if a file path matches any of the configured exclude glob patterns. */
export function isFileExcluded(filePath: string, config: InternalConfig): boolean {
  return config.exclude_patterns.some((pattern) => minimatch(filePath, pattern))
}

/**
 * Filter a single YAML file's content: exclude if marked internal at top level,
 * strip internal operations/parameters/properties, and prune empty objects.
 * Returns null content if the entire file is internal.
 */
export function filterFile(content: string, config: InternalConfig): FilterFileResult {
  const warnings: string[] = []

  let doc: unknown
  try {
    doc = yaml.load(content)
  } catch {
    return { content, warnings }
  }

  if (!isRecord(doc)) {
    return { content, warnings }
  }

  // File-level check: top-level x-internal marker
  if (config.file_marker && doc[config.file_marker] === true) {
    return { content: null, warnings }
  }

  // Field-level filtering
  let filtered = filterNode(doc, config)

  // Strip all strip_fields keys
  filtered = stripFields(filtered, config.strip_fields)

  // Prune empty objects
  filtered = pruneEmpty(filtered)

  if (filtered === undefined || filtered === null) {
    return { content: null, warnings }
  }

  const output = yaml.dump(filtered, {
    lineWidth: -1,
    noRefs: true,
    quotingType: "'",
    forceQuotes: false,
  })

  return { content: output, warnings }
}

/**
 * Filter a set of reachable files: exclude internal files, strip internal fields,
 * clean dangling $refs to excluded files, and pass non-YAML files through unchanged.
 * Two-pass process: first filters individual files, then cleans cross-file dangling refs.
 */
export function filterFiles(
  files: Map<string, string>,
  reachableFiles: Set<string>,
  config: InternalConfig
): FilterFilesResult {
  const filtered = new Map<string, string>()
  const excludedFiles = new Set<string>()
  const warnings: string[] = []

  // First pass: filter individual files
  for (const filePath of reachableFiles) {
    const content = files.get(filePath)
    if (content === undefined) {
      continue
    }

    // Check glob exclusion
    if (isFileExcluded(filePath, config)) {
      excludedFiles.add(filePath)
      continue
    }

    // Only filter YAML/YML files; pass through others (e.g. JSON examples) as-is
    const ext = path.extname(filePath).toLowerCase()
    if (ext !== '.yaml' && ext !== '.yml') {
      filtered.set(filePath, content)
      continue
    }

    const result = filterFile(content, config)
    warnings.push(...result.warnings)

    if (result.content === null) {
      excludedFiles.add(filePath)
    } else {
      filtered.set(filePath, result.content)
    }
  }

  // Second pass: clean dangling $refs
  // Content was produced by yaml.dump in the first pass, so yaml.load and isRecord are guaranteed.
  // stripFields was already applied in the first pass, so no need to repeat.
  for (const [filePath, content] of filtered) {
    const doc = yaml.load(content)
    if (!isRecord(doc)) {
      continue
    }

    const currentDir = path.dirname(filePath)
    const result = cleanDanglingRefs(doc, excludedFiles, currentDir)
    warnings.push(...result.warnings)

    if (result.changed) {
      const cleaned = pruneEmpty(result.node)
      if (cleaned === undefined || cleaned === null) {
        filtered.delete(filePath)
        excludedFiles.add(filePath)
        continue
      }

      const output = yaml.dump(cleaned, {
        lineWidth: -1,
        noRefs: true,
        quotingType: "'",
        forceQuotes: false,
      })
      filtered.set(filePath, output)
    }
  }

  return { filtered, excludedFiles, warnings }
}

// --- Internal helpers ---

/** Check if a node is a record with `x-internal: true`. */
function hasInternalMarker(node: unknown): boolean {
  return isRecord(node) && node['x-internal'] === true
}

/**
 * Recursively filter a parsed YAML node: remove internal paths, parameters,
 * properties, and HTTP method operations marked with x-internal.
 */
function filterNode(node: unknown, config: InternalConfig): unknown {
  if (Array.isArray(node)) {
    return node.filter((item) => !hasInternalMarker(item)).map((item) => filterNode(item, config))
  }

  if (!isRecord(node)) {
    return node
  }

  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(node)) {
    // Filter path operations: if this looks like a path item (has HTTP method keys)
    if (key === 'paths' && isRecord(value)) {
      const filteredPaths = filterPaths(value, config)
      if (filteredPaths !== null && Object.keys(filteredPaths).length > 0) {
        result[key] = filteredPaths
      }
      continue
    }

    // Filter parameters arrays
    if (key === 'parameters' && Array.isArray(value)) {
      const filteredParams = value.filter((param) => !hasInternalMarker(param))
      if (filteredParams.length > 0) {
        result[key] = filteredParams.map((p) => filterNode(p, config))
      }
      continue
    }

    // Filter schema properties
    if (key === 'properties' && isRecord(value)) {
      const filteredProps: Record<string, unknown> = {}
      for (const [propName, propValue] of Object.entries(value)) {
        if (!hasInternalMarker(propValue)) {
          filteredProps[propName] = filterNode(propValue, config)
        }
      }
      if (Object.keys(filteredProps).length > 0) {
        result[key] = filteredProps
      }
      continue
    }

    // Filter HTTP method operations in path items (handles $ref'd path item files)
    if (HTTP_METHODS.has(key) && hasInternalMarker(value)) {
      continue
    }

    // Recurse into other objects
    result[key] = filterNode(value, config)
  }

  return result
}

/**
 * Filter a `paths` object: remove entirely internal paths, remove internal operations
 * within path items, and drop path items with no remaining public operations.
 */
function filterPaths(paths: Record<string, unknown>, config: InternalConfig): Record<string, unknown> | null {
  const result: Record<string, unknown> = {}

  for (const [pathKey, pathValue] of Object.entries(paths)) {
    if (!isRecord(pathValue)) {
      result[pathKey] = pathValue
      continue
    }

    // Check if entire path is internal
    if (hasInternalMarker(pathValue)) {
      continue
    }

    const filteredPath: Record<string, unknown> = {}
    let hasPublicOperation = false

    for (const [opKey, opValue] of Object.entries(pathValue)) {
      if (HTTP_METHODS.has(opKey)) {
        if (!hasInternalMarker(opValue)) {
          filteredPath[opKey] = filterNode(opValue, config)
          hasPublicOperation = true
        }
      } else {
        // Non-operation keys (parameters, summary, etc.)
        filteredPath[opKey] = filterNode(opValue, config)
      }
    }

    if (hasPublicOperation) {
      result[pathKey] = filteredPath
    }
  }

  return Object.keys(result).length > 0 ? result : null
}

/** Recursively remove all occurrences of the specified field keys from a node tree. */
function stripFields(node: unknown, fields: string[]): unknown {
  if (fields.length === 0) {
    return node
  }

  if (Array.isArray(node)) {
    return node.map((item) => stripFields(item, fields))
  }

  if (!isRecord(node)) {
    return node
  }

  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    if (fields.includes(key)) {
      continue
    }
    result[key] = stripFields(value, fields)
  }
  return result
}

/** Recursively remove empty objects and arrays, returning undefined if the node becomes empty. */
function pruneEmpty(node: unknown): unknown {
  if (Array.isArray(node)) {
    const pruned = node.map((item) => pruneEmpty(item)).filter((item) => item !== undefined)
    if (pruned.length === 0) {
      return undefined
    }
    return pruned
  }

  if (!isRecord(node)) {
    return node
  }

  const result: Record<string, unknown> = {}
  let hasKeys = false

  for (const [key, value] of Object.entries(node)) {
    const pruned = pruneEmpty(value)
    if (pruned !== undefined) {
      result[key] = pruned
      hasKeys = true
    }
  }

  return hasKeys ? result : undefined
}

interface DanglingRefResult {
  node: unknown
  changed: boolean
  warnings: string[]
}

/** Recursively remove $ref nodes that point to excluded files. Returns the cleaned node. */
function cleanDanglingRefs(node: unknown, excludedFiles: Set<string>, currentDir: string): DanglingRefResult {
  if (Array.isArray(node)) {
    let changed = false
    const warnings: string[] = []
    const result = []

    for (const item of node) {
      const itemResult = cleanDanglingRefs(item, excludedFiles, currentDir)
      warnings.push(...itemResult.warnings)
      if (itemResult.changed) {
        changed = true
      }
      if (itemResult.node !== undefined) {
        result.push(itemResult.node)
      }
    }

    return {
      node: result.length > 0 ? result : undefined,
      changed: result.length !== node.length || changed,
      warnings,
    }
  }

  if (!isRecord(node)) {
    return { node, changed: false, warnings: [] }
  }

  // Check if this node itself has a dangling $ref
  if (typeof node['$ref'] === 'string') {
    const ref = node['$ref']
    if (!ref.startsWith('#')) {
      const filePart = ref.split('#')[0]
      const resolved = path.normalize(path.join(currentDir, filePart)).split(path.sep).join('/')
      if (excludedFiles.has(resolved)) {
        return {
          node: undefined,
          changed: true,
          warnings: [`Removed dangling $ref to excluded file: ${ref} (resolved: ${resolved})`],
        }
      }
    }
  }

  const result: Record<string, unknown> = {}
  let changed = false
  const warnings: string[] = []

  for (const [key, value] of Object.entries(node)) {
    if (key === 'properties' && isRecord(value)) {
      // For properties, remove entries with dangling refs
      const filteredProps: Record<string, unknown> = {}
      for (const [propName, propValue] of Object.entries(value)) {
        const propResult = cleanDanglingRefs(propValue, excludedFiles, currentDir)
        warnings.push(...propResult.warnings)
        if (propResult.node !== undefined) {
          filteredProps[propName] = propResult.node
          if (propResult.changed) {
            changed = true
          }
        } else {
          changed = true
        }
      }
      if (Object.keys(filteredProps).length > 0) {
        result[key] = filteredProps
      } else {
        changed = true
      }
    } else {
      const childResult = cleanDanglingRefs(value, excludedFiles, currentDir)
      warnings.push(...childResult.warnings)
      if (childResult.changed) {
        changed = true
      }
      if (childResult.node !== undefined) {
        result[key] = childResult.node
      } else {
        changed = true
      }
    }
  }

  return { node: result, changed, warnings }
}
