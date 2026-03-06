import * as path from 'node:path'
import { describe, it, expect } from 'vitest'
import { loadConfig, mapSourceToTarget, getManagedTargetDirs } from '../src/config'
import type { SyncConfig } from '../src/types'

const fixturesDir = path.resolve(__dirname, 'fixtures/configs')

describe('loadConfig', () => {
  it('loads valid multi_file config', () => {
    const config = loadConfig(path.join(fixturesDir, 'v2-config.yaml'))

    expect(config.entrypoint).toBe('api/v2/petstore-api.yaml')
    expect(config.mode).toBe('multi_file')
    expect(config.bundled_file).toBeUndefined()
    expect(config.file_mappings).toHaveLength(3)
    expect(config.file_mappings[0]).toEqual({
      source: 'api/v2/petstore-api.yaml',
      target: 'schemas/petstore-api-v2.yaml',
    })
    expect(config.file_mappings[1]).toEqual({
      source_dir: 'api/v2/components',
      target_dir: 'schemas/components',
    })
    expect(config.internal.file_marker).toBe('x-internal')
    expect(config.internal.strip_fields).toEqual(['x-internal'])
    expect(config.internal.exclude_patterns).toEqual([])
  })

  it('loads valid bundled config', () => {
    const config = loadConfig(path.join(fixturesDir, 'v1-bundled-config.yaml'))

    expect(config.entrypoint).toBe('api/v1/petstore-api.yaml')
    expect(config.mode).toBe('bundled')
    expect(config.bundled_file).toBe('api/v1/dist/petstore-api.yaml')
    expect(config.file_mappings).toHaveLength(1)
  })

  it('defaults mode to multi_file if omitted', () => {
    const config = loadConfig(path.join(fixturesDir, 'minimal-config.yaml'))

    expect(config.mode).toBe('multi_file')
  })

  it('throws on missing entrypoint', () => {
    expect(() => loadConfig(path.join(fixturesDir, 'invalid-missing-entrypoint.yaml'))).toThrow(
      'non-empty `entrypoint`'
    )
  })

  it('throws on invalid mode', () => {
    expect(() => loadConfig(path.join(fixturesDir, 'invalid-bad-mode.yaml'))).toThrow('Invalid mode')
  })

  it('throws on bundled mode without bundled_file', () => {
    expect(() => loadConfig(path.join(fixturesDir, 'invalid-bundled-no-file.yaml'))).toThrow('bundled_file')
  })

  it('throws on non-existent config file', () => {
    expect(() => loadConfig('/nonexistent/path/config.yaml')).toThrow()
  })

  it('throws on empty YAML content', () => {
    // An empty YAML file loads as null/undefined, not a record
    expect(() => loadConfig(path.join(fixturesDir, 'invalid-empty.yaml'))).toThrow('YAML object')
  })

  it('throws when file_mappings is not an array', () => {
    expect(() => loadConfig(path.join(fixturesDir, 'invalid-mappings-not-array.yaml'))).toThrow(
      '`file_mappings` must be an array'
    )
  })

  it('throws when file_mapping entry is not an object', () => {
    expect(() => loadConfig(path.join(fixturesDir, 'invalid-mapping-not-object.yaml'))).toThrow('must be an object')
  })

  it('throws when file_mapping source is not a string', () => {
    expect(() => loadConfig(path.join(fixturesDir, 'invalid-mapping-bad-source.yaml'))).toThrow(
      'source must be a string'
    )
  })

  it('throws when file_mapping target is not a string', () => {
    expect(() => loadConfig(path.join(fixturesDir, 'invalid-mapping-bad-target.yaml'))).toThrow(
      'target must be a string'
    )
  })

  it('throws when file_mapping source_dir is not a string', () => {
    expect(() => loadConfig(path.join(fixturesDir, 'invalid-mapping-bad-source-dir.yaml'))).toThrow(
      'source_dir must be a string'
    )
  })

  it('throws when file_mapping target_dir is not a string', () => {
    expect(() => loadConfig(path.join(fixturesDir, 'invalid-mapping-bad-target-dir.yaml'))).toThrow(
      'target_dir must be a string'
    )
  })

  it('throws when file_mapping has neither exact nor dir pair', () => {
    expect(() => loadConfig(path.join(fixturesDir, 'invalid-mapping-incomplete.yaml'))).toThrow('must have either')
  })

  it('throws when internal config is not an object', () => {
    expect(() => loadConfig(path.join(fixturesDir, 'invalid-internal-not-object.yaml'))).toThrow(
      '"internal" must be an object'
    )
  })

  it('throws when internal.file_marker is not a string', () => {
    expect(() => loadConfig(path.join(fixturesDir, 'invalid-internal-bad-marker.yaml'))).toThrow('file_marker')
  })

  it('throws when internal.strip_fields is not a string array', () => {
    expect(() => loadConfig(path.join(fixturesDir, 'invalid-internal-bad-strip.yaml'))).toThrow('strip_fields')
  })

  it('throws when internal.exclude_patterns is not a string array', () => {
    expect(() => loadConfig(path.join(fixturesDir, 'invalid-internal-bad-patterns.yaml'))).toThrow('exclude_patterns')
  })
})

describe('mapSourceToTarget', () => {
  const config: SyncConfig = {
    entrypoint: 'api/v2/petstore-api.yaml',
    mode: 'multi_file',
    file_mappings: [
      { source: 'api/v2/petstore-api.yaml', target: 'schemas/petstore-api-v2.yaml' },
      { source_dir: 'api/v2/components', target_dir: 'schemas/components' },
      { source_dir: 'api/v2/paths', target_dir: 'schemas/paths' },
    ],
    internal: { file_marker: 'x-internal', strip_fields: ['x-internal'], exclude_patterns: [] },
  }

  it('matches exact file mapping', () => {
    expect(mapSourceToTarget(config, 'api/v2/petstore-api.yaml')).toBe('schemas/petstore-api-v2.yaml')
  })

  it('matches directory prefix mapping', () => {
    expect(mapSourceToTarget(config, 'api/v2/components/schemas/Pet.yaml')).toBe('schemas/components/schemas/Pet.yaml')
  })

  it('exact match takes priority over directory match', () => {
    const configWithOverlap: SyncConfig = {
      ...config,
      file_mappings: [
        { source: 'api/v2/components/special.yaml', target: 'schemas/special-override.yaml' },
        { source_dir: 'api/v2/components', target_dir: 'schemas/components' },
      ],
    }

    expect(mapSourceToTarget(configWithOverlap, 'api/v2/components/special.yaml')).toBe('schemas/special-override.yaml')
  })

  it('returns null for unmapped path', () => {
    expect(mapSourceToTarget(config, 'api/v1/something.yaml')).toBeNull()
  })

  it('handles source_dir with trailing slash', () => {
    const configWithSlash: SyncConfig = {
      ...config,
      file_mappings: [{ source_dir: 'api/v2/components/', target_dir: 'schemas/components' }],
    }

    expect(mapSourceToTarget(configWithSlash, 'api/v2/components/schemas/Pet.yaml')).toBe(
      'schemas/components/schemas/Pet.yaml'
    )
  })

  it('handles target_dir with trailing slash', () => {
    const configWithSlash: SyncConfig = {
      ...config,
      file_mappings: [{ source_dir: 'api/v2/components', target_dir: 'schemas/components/' }],
    }

    expect(mapSourceToTarget(configWithSlash, 'api/v2/components/schemas/Pet.yaml')).toBe(
      'schemas/components/schemas/Pet.yaml'
    )
  })

  it('handles nested paths under directory mapping', () => {
    expect(mapSourceToTarget(config, 'api/v2/paths/examples/pets/get_pet_200.json')).toBe(
      'schemas/paths/examples/pets/get_pet_200.json'
    )
  })

  it('does not match partial directory names', () => {
    // "api/v2/components-extra/foo.yaml" should NOT match "api/v2/components" dir mapping
    expect(mapSourceToTarget(config, 'api/v2/components-extra/foo.yaml')).toBeNull()
  })
})

describe('getManagedTargetDirs', () => {
  it('extracts all unique target directories', () => {
    const config: SyncConfig = {
      entrypoint: 'api/v2/petstore-api.yaml',
      mode: 'multi_file',
      file_mappings: [
        { source: 'api/v2/petstore-api.yaml', target: 'schemas/petstore-api-v2.yaml' },
        { source_dir: 'api/v2/components', target_dir: 'schemas/components' },
        { source_dir: 'api/v2/paths', target_dir: 'schemas/paths' },
      ],
      internal: { file_marker: 'x-internal', strip_fields: [], exclude_patterns: [] },
    }

    const dirs = getManagedTargetDirs(config)
    expect(dirs).toContain('schemas')
    expect(dirs).toContain('schemas/components')
    expect(dirs).toContain('schemas/paths')
    expect(dirs).toHaveLength(3)
  })

  it('deduplicates directories', () => {
    const config: SyncConfig = {
      entrypoint: 'api/v2/petstore-api.yaml',
      mode: 'multi_file',
      file_mappings: [
        { source: 'api/v2/a.yaml', target: 'schemas/a.yaml' },
        { source: 'api/v2/b.yaml', target: 'schemas/b.yaml' },
      ],
      internal: { file_marker: 'x-internal', strip_fields: [], exclude_patterns: [] },
    }

    const dirs = getManagedTargetDirs(config)
    expect(dirs).toEqual(['schemas'])
  })

  it('includes dirname of exact file targets', () => {
    const config: SyncConfig = {
      entrypoint: 'e.yaml',
      mode: 'multi_file',
      file_mappings: [{ source: 'e.yaml', target: 'out/nested/file.yaml' }],
      internal: { file_marker: 'x-internal', strip_fields: [], exclude_patterns: [] },
    }

    const dirs = getManagedTargetDirs(config)
    expect(dirs).toContain('out/nested')
  })
})
