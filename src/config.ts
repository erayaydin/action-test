import * as fs from 'node:fs'
import * as path from 'node:path'
import * as yaml from 'js-yaml'
import type { FileMapping, InternalConfig, SyncConfig } from './types'
import { isRecord, isStringArray } from './utils'

/** Validate and parse a single file_mapping entry from the config. */
function validateFileMapping(raw: unknown, index: number): FileMapping {
  if (!isRecord(raw)) {
    throw new Error(`file_mappings[${index}] must be an object`)
  }

  const mapping: FileMapping = {}

  if (raw.source !== undefined) {
    if (typeof raw.source !== 'string') {
      throw new Error(`file_mappings[${index}].source must be a string`)
    }
    mapping.source = raw.source
  }

  if (raw.target !== undefined) {
    if (typeof raw.target !== 'string') {
      throw new Error(`file_mappings[${index}].target must be a string`)
    }
    mapping.target = raw.target
  }

  if (raw.source_dir !== undefined) {
    if (typeof raw.source_dir !== 'string') {
      throw new Error(`file_mappings[${index}].source_dir must be a string`)
    }
    mapping.source_dir = raw.source_dir
  }

  if (raw.target_dir !== undefined) {
    if (typeof raw.target_dir !== 'string') {
      throw new Error(`file_mappings[${index}].target_dir must be a string`)
    }
    mapping.target_dir = raw.target_dir
  }

  const hasExact = mapping.source !== undefined && mapping.target !== undefined
  const hasDir = mapping.source_dir !== undefined && mapping.target_dir !== undefined

  if (!hasExact && !hasDir) {
    throw new Error(`file_mappings[${index}] must have either (source + target) or (source_dir + target_dir)`)
  }

  return mapping
}

/** Validate and parse the `internal` section of the config. */
function validateInternalConfig(raw: unknown): InternalConfig {
  if (!isRecord(raw)) {
    throw new Error('"internal" must be an object')
  }

  if (typeof raw.file_marker !== 'string') {
    throw new Error('"internal.file_marker" must be a string')
  }

  if (!isStringArray(raw.strip_fields)) {
    throw new Error('"internal.strip_fields" must be an array of strings')
  }

  if (!isStringArray(raw.exclude_patterns)) {
    throw new Error('"internal.exclude_patterns" must be an array of strings')
  }

  return {
    file_marker: raw.file_marker,
    strip_fields: raw.strip_fields,
    exclude_patterns: raw.exclude_patterns,
  }
}

/** Load and validate a sync config file. */
export function loadConfig(configPath: string): SyncConfig {
  const absolutePath = path.resolve(configPath)
  const content = fs.readFileSync(absolutePath, 'utf-8')
  const raw = yaml.load(content)

  if (!isRecord(raw)) {
    throw new Error('Config file must contain a YAML object')
  }

  if (typeof raw.entrypoint !== 'string' || raw.entrypoint.length === 0) {
    throw new Error('Config must have a non-empty `entrypoint`')
  }

  const mode = raw.mode ?? 'multi_file'
  if (mode !== 'multi_file' && mode !== 'bundled') {
    throw new Error(`Invalid mode \`${String(mode)}\`. Must be \`multi_file\` or \`bundled\``)
  }

  if (mode === 'bundled') {
    if (typeof raw.bundled_file !== 'string' || raw.bundled_file.length === 0) {
      throw new Error('Bundled mode requires a non-empty `bundled_file` string')
    }
  }

  if (!Array.isArray(raw.file_mappings)) {
    throw new Error('`file_mappings` must be an array')
  }

  const fileMappings = raw.file_mappings.map((item: unknown, i: number) => validateFileMapping(item, i))
  const internal = validateInternalConfig(raw.internal)

  const config: SyncConfig = {
    entrypoint: raw.entrypoint,
    mode,
    file_mappings: fileMappings,
    internal,
  }

  if (mode === 'bundled' && typeof raw.bundled_file === 'string') {
    config.bundled_file = raw.bundled_file
  }

  return config
}

/** Map a source-relative file path to its target-relative path using the config's file_mappings. */
export function mapSourceToTarget(config: SyncConfig, sourcePath: string): string | null {
  for (const mapping of config.file_mappings) {
    if (mapping.source !== undefined && mapping.target !== undefined) {
      if (sourcePath === mapping.source) {
        return mapping.target
      }
    }
  }

  for (const mapping of config.file_mappings) {
    if (mapping.source_dir !== undefined && mapping.target_dir !== undefined) {
      const prefix = mapping.source_dir.endsWith('/') ? mapping.source_dir : mapping.source_dir + '/'
      if (sourcePath.startsWith(prefix)) {
        const relativePath = sourcePath.slice(prefix.length)
        const targetPrefix = mapping.target_dir.endsWith('/') ? mapping.target_dir : mapping.target_dir + '/'
        return targetPrefix + relativePath
      }
    }
  }

  return null
}

/** Extract all unique target directories from file_mappings. */
export function getManagedTargetDirs(config: SyncConfig): string[] {
  const dirs = new Set<string>()

  for (const mapping of config.file_mappings) {
    if (mapping.target_dir !== undefined) {
      dirs.add(mapping.target_dir)
    }
    if (mapping.target !== undefined) {
      const dir = path.posix.dirname(mapping.target)
      if (dir !== '.') {
        dirs.add(dir)
      }
    }
  }

  return [...dirs]
}
