export interface FileMapping {
  source?: string
  target?: string
  source_dir?: string
  target_dir?: string
}

export interface InternalConfig {
  file_marker: string
  strip_fields: string[]
  exclude_patterns: string[]
}

export interface SyncConfig {
  entrypoint: string
  mode: 'multi_file' | 'bundled'
  bundled_file?: string
  file_mappings: FileMapping[]
  internal: InternalConfig
}

export interface DiffResult {
  hasDiff: boolean
  added: string[]
  modified: string[]
  deleted: string[]
  summary: string
}
