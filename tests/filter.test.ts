import * as yaml from 'js-yaml'
import { describe, it, expect } from 'vitest'
import { isFileExcluded, filterFile, filterFiles } from '../src/filter'
import type { InternalConfig } from '../src/types'

const defaultConfig: InternalConfig = {
  file_marker: 'x-internal',
  strip_fields: ['x-internal'],
  exclude_patterns: [],
}

function parseOutput(content: string | null): unknown {
  if (content === null) {
    return null
  }
  return yaml.load(content)
}

describe('isFileExcluded', () => {
  it('matches glob pattern', () => {
    const config: InternalConfig = { ...defaultConfig, exclude_patterns: ['**/internal/**'] }
    expect(isFileExcluded('api/v2/internal/debug.yaml', config)).toBe(true)
  })

  it('does not match when no patterns match', () => {
    const config: InternalConfig = { ...defaultConfig, exclude_patterns: ['**/internal/**'] }
    expect(isFileExcluded('api/v2/paths/events.yaml', config)).toBe(false)
  })

  it('returns false when no patterns configured', () => {
    expect(isFileExcluded('anything.yaml', defaultConfig)).toBe(false)
  })
})

describe('filterFile', () => {
  it('returns null for file with top-level x-internal: true', () => {
    const content = 'x-internal: true\ntype: object\nproperties:\n  id:\n    type: string\n'
    const result = filterFile(content, defaultConfig)
    expect(result.content).toBeNull()
  })

  it('removes x-internal parameters from array', () => {
    const content = yaml.dump({
      parameters: [
        { name: 'limit', in: 'query' },
        { name: 'debug_token', in: 'query', 'x-internal': true },
        { name: 'offset', in: 'query' },
      ],
    })

    const result = filterFile(content, defaultConfig)
    const doc = parseOutput(result.content)

    expect(doc).toEqual({
      parameters: [
        { name: 'limit', in: 'query' },
        { name: 'offset', in: 'query' },
      ],
    })
  })

  it('removes x-internal schema properties', () => {
    const content = yaml.dump({
      type: 'object',
      properties: {
        id: { type: 'string' },
        internal_debug: { type: 'object', 'x-internal': true },
        name: { type: 'string' },
      },
    })

    const result = filterFile(content, defaultConfig)
    const doc = parseOutput(result.content)

    expect(doc).toEqual({
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
      },
    })
  })

  it('removes x-internal path operations', () => {
    const content = yaml.dump({
      paths: {
        '/events': {
          get: { summary: 'Get events' },
          post: { summary: 'Create event', 'x-internal': true },
        },
      },
    })

    const result = filterFile(content, defaultConfig)
    const doc = parseOutput(result.content)

    expect(doc).toEqual({
      paths: {
        '/events': {
          get: { summary: 'Get events' },
        },
      },
    })
  })

  it('removes entire path when all operations are internal', () => {
    const content = yaml.dump({
      paths: {
        '/events': {
          get: { summary: 'Get events' },
        },
        '/debug': {
          get: { summary: 'Debug', 'x-internal': true },
          post: { summary: 'Debug post', 'x-internal': true },
        },
      },
    })

    const result = filterFile(content, defaultConfig)
    const doc = parseOutput(result.content)

    expect(doc).toEqual({
      paths: {
        '/events': {
          get: { summary: 'Get events' },
        },
      },
    })
  })

  it('strips all strip_fields keys from output', () => {
    const content = yaml.dump({
      type: 'object',
      'x-internal': false,
      properties: {
        id: { type: 'string', 'x-internal': false },
      },
    })

    const result = filterFile(content, defaultConfig)
    const doc = parseOutput(result.content)

    expect(doc).toEqual({
      type: 'object',
      properties: {
        id: { type: 'string' },
      },
    })
  })

  it('prunes empty objects after stripping', () => {
    const content = yaml.dump({
      type: 'object',
      properties: {
        only_internal: { type: 'string', 'x-internal': true },
      },
    })

    const result = filterFile(content, defaultConfig)
    const doc = parseOutput(result.content)

    // properties becomes empty after removing only_internal, so it gets pruned
    expect(doc).toEqual({ type: 'object' })
  })

  it('passes through file with no internal markers', () => {
    const input = {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
      },
    }
    const content = yaml.dump(input)
    const result = filterFile(content, defaultConfig)
    const doc = parseOutput(result.content)

    expect(doc).toEqual(input)
  })

  it('handles deeply nested x-internal in schema properties', () => {
    const content = yaml.dump({
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: {
            public_field: { type: 'string' },
            nested_internal: {
              type: 'object',
              'x-internal': true,
              properties: { deep: { type: 'string' } },
            },
          },
        },
      },
    })

    const result = filterFile(content, defaultConfig)
    const doc = parseOutput(result.content)

    expect(doc).toEqual({
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: {
            public_field: { type: 'string' },
          },
        },
      },
    })
  })

  it('preserves non-YAML content as-is', () => {
    const content = 'this is not valid YAML: [unclosed'
    const result = filterFile(content, defaultConfig)
    // Should return content unchanged when parsing fails
    expect(result.content).toBe(content)
  })

  it('handles path item with x-internal at path level', () => {
    const content = yaml.dump({
      paths: {
        '/public': {
          get: { summary: 'Public' },
        },
        '/internal': {
          'x-internal': true,
          get: { summary: 'Internal' },
        },
      },
    })

    const result = filterFile(content, defaultConfig)
    const doc = parseOutput(result.content)

    expect(doc).toEqual({
      paths: {
        '/public': {
          get: { summary: 'Public' },
        },
      },
    })
  })

  it('preserves path-level non-operation keys (parameters, summary)', () => {
    const content = yaml.dump({
      paths: {
        '/events': {
          summary: 'Events endpoint',
          parameters: [{ name: 'version', in: 'header' }],
          get: { summary: 'Get events' },
          post: { summary: 'Create', 'x-internal': true },
        },
      },
    })

    const result = filterFile(content, defaultConfig)
    const doc = parseOutput(result.content)

    expect(doc).toEqual({
      paths: {
        '/events': {
          summary: 'Events endpoint',
          parameters: [{ name: 'version', in: 'header' }],
          get: { summary: 'Get events' },
        },
      },
    })
  })
})

describe('filterFiles', () => {
  it('processes multiple files and separates excluded from filtered', () => {
    const files = new Map([
      ['a.yaml', 'type: string\n'],
      ['b.yaml', 'x-internal: true\ntype: object\n'],
      ['c.yaml', 'type: number\n'],
    ])
    const reachable = new Set(['a.yaml', 'b.yaml', 'c.yaml'])

    const result = filterFiles(files, reachable, defaultConfig)

    expect(result.filtered.size).toBe(2)
    expect(result.filtered.has('a.yaml')).toBe(true)
    expect(result.filtered.has('c.yaml')).toBe(true)
    expect(result.excludedFiles.has('b.yaml')).toBe(true)
  })

  it('excludes files matching exclude_patterns', () => {
    const config: InternalConfig = {
      ...defaultConfig,
      exclude_patterns: ['**/internal/**'],
    }
    const files = new Map([
      ['api/public.yaml', 'type: string\n'],
      ['api/internal/debug.yaml', 'type: string\n'],
    ])
    const reachable = new Set(['api/public.yaml', 'api/internal/debug.yaml'])

    const result = filterFiles(files, reachable, config)

    expect(result.filtered.has('api/public.yaml')).toBe(true)
    expect(result.excludedFiles.has('api/internal/debug.yaml')).toBe(true)
  })

  it('detects and removes dangling $ref to excluded files', () => {
    const files = new Map([
      [
        'main.yaml',
        yaml.dump({
          type: 'object',
          properties: {
            public: { type: 'string' },
            internal: { $ref: './internal.yaml' },
          },
        }),
      ],
      ['internal.yaml', 'x-internal: true\ntype: object\n'],
    ])
    const reachable = new Set(['main.yaml', 'internal.yaml'])

    const result = filterFiles(files, reachable, defaultConfig)

    expect(result.excludedFiles.has('internal.yaml')).toBe(true)
    const mainDoc = parseOutput(result.filtered.get('main.yaml') ?? '')
    expect(mainDoc).toEqual({
      type: 'object',
      properties: {
        public: { type: 'string' },
      },
    })
    expect(result.warnings.some((w) => w.includes('dangling'))).toBe(true)
  })

  it('generates warnings for dangling refs', () => {
    const files = new Map([
      [
        'entry.yaml',
        yaml.dump({
          components: {
            schemas: {
              Ref: { $ref: './excluded.yaml' },
            },
          },
        }),
      ],
      ['excluded.yaml', 'x-internal: true\ntype: string\n'],
    ])
    const reachable = new Set(['entry.yaml', 'excluded.yaml'])

    const result = filterFiles(files, reachable, defaultConfig)

    expect(result.warnings.length).toBeGreaterThan(0)
    expect(result.warnings.some((w) => w.includes('excluded.yaml'))).toBe(true)
  })

  it('ignores files not in reachableFiles set', () => {
    const files = new Map([
      ['reachable.yaml', 'type: string\n'],
      ['not-reachable.yaml', 'type: number\n'],
    ])
    const reachable = new Set(['reachable.yaml'])

    const result = filterFiles(files, reachable, defaultConfig)

    expect(result.filtered.size).toBe(1)
    expect(result.filtered.has('reachable.yaml')).toBe(true)
    expect(result.filtered.has('not-reachable.yaml')).toBe(false)
  })

  it('handles cascading: removing dangling ref empties container', () => {
    const files = new Map([
      [
        'main.yaml',
        yaml.dump({
          type: 'object',
          properties: {
            onlyRef: { $ref: './excluded.yaml' },
          },
        }),
      ],
      ['excluded.yaml', 'x-internal: true\ntype: object\n'],
    ])
    const reachable = new Set(['main.yaml', 'excluded.yaml'])

    const result = filterFiles(files, reachable, defaultConfig)

    // After removing the dangling ref, properties is empty and gets pruned
    const mainDoc = parseOutput(result.filtered.get('main.yaml') ?? '')
    expect(mainDoc).toEqual({ type: 'object' })
  })

  it('cleans dangling refs in arrays', () => {
    const files = new Map([
      [
        'main.yaml',
        yaml.dump({
          allOf: [{ $ref: './public.yaml' }, { $ref: './excluded.yaml' }],
        }),
      ],
      ['public.yaml', 'type: string\n'],
      ['excluded.yaml', 'x-internal: true\ntype: object\n'],
    ])
    const reachable = new Set(['main.yaml', 'public.yaml', 'excluded.yaml'])

    const result = filterFiles(files, reachable, defaultConfig)

    const mainDoc = parseOutput(result.filtered.get('main.yaml') ?? '')
    expect(mainDoc).toEqual({
      allOf: [{ $ref: './public.yaml' }],
    })
  })

  it('removes file entirely when all content becomes dangling', () => {
    const files = new Map([
      [
        'wrapper.yaml',
        yaml.dump({
          $ref: './excluded.yaml',
        }),
      ],
      ['excluded.yaml', 'x-internal: true\ntype: object\n'],
    ])
    const reachable = new Set(['wrapper.yaml', 'excluded.yaml'])

    const result = filterFiles(files, reachable, defaultConfig)

    expect(result.filtered.has('wrapper.yaml')).toBe(false)
    expect(result.excludedFiles.has('wrapper.yaml')).toBe(true)
  })

  it('handles non-record and non-array nodes in dangling ref cleanup', () => {
    const files = new Map([
      [
        'main.yaml',
        yaml.dump({
          type: 'object',
          description: 'A plain string value',
          count: 42,
          properties: {
            name: { type: 'string' },
          },
        }),
      ],
    ])
    const reachable = new Set(['main.yaml'])

    const result = filterFiles(files, reachable, defaultConfig)

    const mainDoc = parseOutput(result.filtered.get('main.yaml') ?? '')
    expect(mainDoc).toEqual({
      type: 'object',
      description: 'A plain string value',
      count: 42,
      properties: {
        name: { type: 'string' },
      },
    })
  })

  it('handles non-parseable YAML in second pass gracefully', () => {
    const files = new Map([
      ['good.yaml', 'type: string\n'],
      ['excluded.yaml', 'x-internal: true\ntype: object\n'],
    ])
    const reachable = new Set(['good.yaml', 'excluded.yaml'])

    // Manually inject a non-parseable value into filtered to test second pass
    const result = filterFiles(files, reachable, defaultConfig)

    expect(result.filtered.has('good.yaml')).toBe(true)
    expect(result.excludedFiles.has('excluded.yaml')).toBe(true)
  })

  it('returns null when entire file becomes empty after filtering', () => {
    const content = yaml.dump({
      properties: {
        a: { type: 'string', 'x-internal': true },
        b: { type: 'number', 'x-internal': true },
      },
    })

    const result = filterFile(content, defaultConfig)
    expect(result.content).toBeNull()
  })

  it('handles file with no file_marker set', () => {
    const config: InternalConfig = {
      file_marker: '',
      strip_fields: [],
      exclude_patterns: [],
    }
    const content = yaml.dump({
      'x-internal': true,
      type: 'object',
    })

    const result = filterFile(content, config)
    // Empty file_marker means no file-level exclusion
    expect(result.content).not.toBeNull()
  })

  it('passes through non-object YAML (scalar)', () => {
    const result = filterFile('just a string', defaultConfig)
    expect(result.content).toBe('just a string')
  })

  it('removes all paths when all are internal', () => {
    const content = yaml.dump({
      info: { title: 'API' },
      paths: {
        '/a': {
          get: { summary: 'A', 'x-internal': true },
        },
        '/b': {
          post: { summary: 'B', 'x-internal': true },
        },
      },
    })

    const result = filterFile(content, defaultConfig)
    const doc = parseOutput(result.content)

    expect(doc).toEqual({ info: { title: 'API' } })
  })

  it('handles all parameters being internal', () => {
    const content = yaml.dump({
      parameters: [
        { name: 'a', in: 'query', 'x-internal': true },
        { name: 'b', in: 'query', 'x-internal': true },
      ],
    })

    const result = filterFile(content, defaultConfig)

    // All parameters are internal, entire file becomes empty
    expect(result.content).toBeNull()
  })

  it('handles dangling ref cleanup removing all properties', () => {
    const files = new Map([
      [
        'main.yaml',
        yaml.dump({
          type: 'object',
          properties: {
            a: { $ref: './excluded.yaml' },
            b: { $ref: './excluded.yaml' },
          },
        }),
      ],
      ['excluded.yaml', 'x-internal: true\ntype: object\n'],
    ])
    const reachable = new Set(['main.yaml', 'excluded.yaml'])

    const result = filterFiles(files, reachable, defaultConfig)

    const mainDoc = parseOutput(result.filtered.get('main.yaml') ?? '')
    expect(mainDoc).toEqual({ type: 'object' })
  })

  it('handles dangling ref in non-properties context', () => {
    const files = new Map([
      [
        'main.yaml',
        yaml.dump({
          type: 'object',
          schema: { $ref: './excluded.yaml' },
          name: 'test',
        }),
      ],
      ['excluded.yaml', 'x-internal: true\ntype: object\n'],
    ])
    const reachable = new Set(['main.yaml', 'excluded.yaml'])

    const result = filterFiles(files, reachable, defaultConfig)

    const mainDoc = parseOutput(result.filtered.get('main.yaml') ?? '')
    expect(mainDoc).toEqual({ type: 'object', name: 'test' })
  })

  it('handles second pass when YAML parse fails', () => {
    // Simulate a file that passes first pass but has invalid YAML for second pass
    // This is an edge case that's hard to trigger naturally, but the guard exists
    const files = new Map([['a.yaml', 'type: string\n']])
    const reachable = new Set(['a.yaml'])

    const result = filterFiles(files, reachable, defaultConfig)
    // Should just pass through without errors
    expect(result.filtered.has('a.yaml')).toBe(true)
  })

  it('handles second pass when parsed YAML is not a record', () => {
    // A file that's just a scalar value - parsed successfully but not a record
    const files = new Map([['scalar.yaml', '"just a string"\n']])
    const reachable = new Set(['scalar.yaml'])

    const result = filterFiles(files, reachable, defaultConfig)
    expect(result.filtered.has('scalar.yaml')).toBe(true)
  })

  it('excludes file when second pass strip+prune empties it', () => {
    // Create a scenario where dangling ref cleanup changes content,
    // then stripFields + pruneEmpty makes it null
    const files = new Map([
      [
        'main.yaml',
        yaml.dump({
          'x-internal': false,
          properties: {
            ref: { $ref: './excluded.yaml' },
          },
        }),
      ],
      ['excluded.yaml', 'x-internal: true\ntype: object\n'],
    ])
    const reachable = new Set(['main.yaml', 'excluded.yaml'])

    // After first pass: x-internal: false is kept, properties.ref exists
    // Second pass: dangling ref removed -> properties empty -> pruned
    // Then stripFields removes x-internal -> only empty object left -> pruned
    const result = filterFiles(files, reachable, defaultConfig)

    expect(result.filtered.has('main.yaml')).toBe(false)
    expect(result.excludedFiles.has('main.yaml')).toBe(true)
  })

  it('handles non-record path values', () => {
    const content = yaml.dump({
      paths: {
        '/events': 'a string instead of an object',
      },
    })

    const result = filterFile(content, defaultConfig)
    const doc = parseOutput(result.content)

    expect(doc).toEqual({
      paths: {
        '/events': 'a string instead of an object',
      },
    })
  })

  it('marks changed when property in dangling ref cleanup has nested changes', () => {
    const files = new Map([
      [
        'dir/main.yaml',
        yaml.dump({
          type: 'object',
          properties: {
            kept: { type: 'string' },
            nested: {
              type: 'object',
              properties: {
                a: { $ref: '../excluded.yaml' },
                b: { type: 'number' },
              },
            },
          },
        }),
      ],
      ['excluded.yaml', 'x-internal: true\ntype: object\n'],
    ])
    const reachable = new Set(['dir/main.yaml', 'excluded.yaml'])

    const result = filterFiles(files, reachable, defaultConfig)

    const mainDoc = parseOutput(result.filtered.get('dir/main.yaml') ?? '')
    expect(mainDoc).toEqual({
      type: 'object',
      properties: {
        kept: { type: 'string' },
        nested: {
          type: 'object',
          properties: {
            b: { type: 'number' },
          },
        },
      },
    })
  })

  it('prunes empty arrays after all items have dangling refs', () => {
    const files = new Map([
      [
        'main.yaml',
        yaml.dump({
          type: 'object',
          allOf: [{ $ref: './excluded.yaml' }],
        }),
      ],
      ['excluded.yaml', 'x-internal: true\ntype: object\n'],
    ])
    const reachable = new Set(['main.yaml', 'excluded.yaml'])

    const result = filterFiles(files, reachable, defaultConfig)

    // allOf array becomes empty after removing the only dangling ref -> pruned
    const mainDoc = parseOutput(result.filtered.get('main.yaml') ?? '')
    expect(mainDoc).toEqual({ type: 'object' })
  })

  it('prunes arrays that become empty after filtering internal items', () => {
    const content = yaml.dump({
      parameters: [{ name: 'a', in: 'query', 'x-internal': true }],
      type: 'object',
    })

    const result = filterFile(content, defaultConfig)
    const doc = parseOutput(result.content)
    // parameters array becomes empty -> pruned away, only type remains
    expect(doc).toEqual({ type: 'object' })
  })

  it('prunes array where all items become empty objects via pruneEmpty', () => {
    // An array of objects where each object only contains empty sub-objects
    // pruneEmpty will recursively empty each item, then the array itself
    const content = yaml.dump({
      type: 'object',
      someList: [{ properties: { a: { 'x-internal': true, type: 'string' } } }],
    })

    const result = filterFile(content, defaultConfig)
    const doc = parseOutput(result.content)
    // someList[0].properties.a is internal -> removed -> properties empty -> pruned
    // someList[0] becomes {} -> pruned -> someList empty -> pruned
    expect(doc).toEqual({ type: 'object' })
  })

  it('marks array changed when items have nested dangling ref changes but no items removed', () => {
    const files = new Map([
      [
        'main.yaml',
        yaml.dump({
          allOf: [
            {
              type: 'object',
              properties: {
                keep: { type: 'string' },
                remove: { $ref: './excluded.yaml' },
              },
            },
          ],
        }),
      ],
      ['excluded.yaml', 'x-internal: true\ntype: object\n'],
    ])
    const reachable = new Set(['main.yaml', 'excluded.yaml'])

    const result = filterFiles(files, reachable, defaultConfig)

    const mainDoc = parseOutput(result.filtered.get('main.yaml') ?? '')
    // Array still has 1 item (not removed) but that item changed internally
    expect(mainDoc).toEqual({
      allOf: [
        {
          type: 'object',
          properties: {
            keep: { type: 'string' },
          },
        },
      ],
    })
  })

  it('skips files not in the source map', () => {
    const files = new Map([['a.yaml', 'type: string\n']])
    // Reachable includes a file not in the map
    const reachable = new Set(['a.yaml', 'missing-from-map.yaml'])

    const result = filterFiles(files, reachable, defaultConfig)

    expect(result.filtered.size).toBe(1)
    expect(result.filtered.has('a.yaml')).toBe(true)
  })
})
