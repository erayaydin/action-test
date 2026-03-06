import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { computeDiff } from '../src/diff'

describe('computeDiff', () => {
  let targetRoot: string

  beforeEach(() => {
    targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-test-'))
  })

  afterEach(() => {
    fs.rmSync(targetRoot, { recursive: true, force: true })
  })

  function writeTargetFile(relPath: string, content: string) {
    const absPath = path.join(targetRoot, relPath)
    fs.mkdirSync(path.dirname(absPath), { recursive: true })
    fs.writeFileSync(absPath, content, 'utf-8')
  }

  it('reports no diff when content is identical', () => {
    writeTargetFile('schemas/api.yaml', 'openapi: 3.0.0\ninfo:\n  title: API\n')

    const newFiles = new Map([['schemas/api.yaml', 'openapi: 3.0.0\ninfo:\n  title: API\n']])
    const result = computeDiff(newFiles, targetRoot, ['schemas'])

    expect(result.hasDiff).toBe(false)
    expect(result.added).toEqual([])
    expect(result.modified).toEqual([])
    expect(result.deleted).toEqual([])
    expect(result.summary).toBe('No changes')
  })

  it('treats whitespace-only differences as no diff', () => {
    writeTargetFile('schemas/api.yaml', 'openapi: 3.0.0  \ninfo:\n  title: API\n\n\n')

    const newFiles = new Map([['schemas/api.yaml', 'openapi: 3.0.0\ninfo:\n  title: API']])
    const result = computeDiff(newFiles, targetRoot, ['schemas'])

    expect(result.hasDiff).toBe(false)
  })

  it('treats CRLF vs LF as no diff after normalization', () => {
    writeTargetFile('schemas/api.yaml', 'openapi: 3.0.0\r\ninfo:\r\n  title: API\r\n')

    const newFiles = new Map([['schemas/api.yaml', 'openapi: 3.0.0\ninfo:\n  title: API\n']])
    const result = computeDiff(newFiles, targetRoot, ['schemas'])

    expect(result.hasDiff).toBe(false)
  })

  it('detects modified files', () => {
    writeTargetFile('schemas/api.yaml', 'openapi: 3.0.0\ninfo:\n  title: Old API\n')

    const newFiles = new Map([['schemas/api.yaml', 'openapi: 3.0.0\ninfo:\n  title: New API\n']])
    const result = computeDiff(newFiles, targetRoot, ['schemas'])

    expect(result.hasDiff).toBe(true)
    expect(result.modified).toEqual(['schemas/api.yaml'])
    expect(result.added).toEqual([])
    expect(result.deleted).toEqual([])
    expect(result.summary).toBe('1 file(s) modified')
  })

  it('detects added files', () => {
    const newFiles = new Map([['schemas/new-file.yaml', 'content: new\n']])
    const result = computeDiff(newFiles, targetRoot, ['schemas'])

    expect(result.hasDiff).toBe(true)
    expect(result.added).toEqual(['schemas/new-file.yaml'])
    expect(result.modified).toEqual([])
    expect(result.deleted).toEqual([])
    expect(result.summary).toBe('1 file(s) added')
  })

  it('detects deleted files in managed directories', () => {
    writeTargetFile('schemas/components/OldSchema.yaml', 'type: object\n')
    writeTargetFile('schemas/components/Kept.yaml', 'type: string\n')

    const newFiles = new Map([['schemas/components/Kept.yaml', 'type: string\n']])
    const result = computeDiff(newFiles, targetRoot, ['schemas/components'])

    expect(result.hasDiff).toBe(true)
    expect(result.deleted).toEqual(['schemas/components/OldSchema.yaml'])
    expect(result.modified).toEqual([])
    expect(result.added).toEqual([])
  })

  it('does not delete files outside managed directories', () => {
    writeTargetFile('schemas/v1-api.yaml', 'openapi: 3.0.0\n')
    writeTargetFile('schemas/components/Event.yaml', 'type: object\n')

    // Only manage schemas/components, not schemas/ root
    const newFiles = new Map([['schemas/components/Event.yaml', 'type: object\n']])
    const result = computeDiff(newFiles, targetRoot, ['schemas/components'])

    expect(result.hasDiff).toBe(false)
    // v1-api.yaml should NOT be in deleted since it's not under a managed dir
    expect(result.deleted).toEqual([])
  })

  it('handles mixed added, modified, and deleted files', () => {
    writeTargetFile('schemas/api.yaml', 'old content\n')
    writeTargetFile('schemas/components/Old.yaml', 'old model\n')

    const newFiles = new Map([
      ['schemas/api.yaml', 'new content\n'],
      ['schemas/components/New.yaml', 'new model\n'],
    ])
    const result = computeDiff(newFiles, targetRoot, ['schemas', 'schemas/components'])

    expect(result.hasDiff).toBe(true)
    expect(result.modified).toEqual(['schemas/api.yaml'])
    expect(result.added).toEqual(['schemas/components/New.yaml'])
    expect(result.deleted).toEqual(['schemas/components/Old.yaml'])
    expect(result.summary).toBe('1 file(s) modified, 1 file(s) added, 1 file(s) deleted')
  })

  it('handles empty target directory', () => {
    const newFiles = new Map([['schemas/api.yaml', 'openapi: 3.0.0\n']])
    const result = computeDiff(newFiles, targetRoot, ['schemas'])

    expect(result.hasDiff).toBe(true)
    expect(result.added).toEqual(['schemas/api.yaml'])
  })

  it('handles empty new files map (all deleted)', () => {
    writeTargetFile('schemas/components/Event.yaml', 'type: object\n')

    const newFiles = new Map<string, string>()
    const result = computeDiff(newFiles, targetRoot, ['schemas/components'])

    expect(result.hasDiff).toBe(true)
    expect(result.deleted).toEqual(['schemas/components/Event.yaml'])
    expect(result.summary).toBe('1 file(s) deleted')
  })

  it('sorts results alphabetically', () => {
    const newFiles = new Map([
      ['schemas/z-file.yaml', 'z\n'],
      ['schemas/a-file.yaml', 'a\n'],
      ['schemas/m-file.yaml', 'm\n'],
    ])
    const result = computeDiff(newFiles, targetRoot, ['schemas'])

    expect(result.added).toEqual(['schemas/a-file.yaml', 'schemas/m-file.yaml', 'schemas/z-file.yaml'])
  })

  it('handles nested files in managed directories', () => {
    writeTargetFile('schemas/components/schemas/deep/Nested.yaml', 'old\n')
    writeTargetFile('schemas/components/schemas/deep/Keep.yaml', 'keep\n')

    const newFiles = new Map([['schemas/components/schemas/deep/Keep.yaml', 'keep\n']])
    const result = computeDiff(newFiles, targetRoot, ['schemas/components'])

    expect(result.hasDiff).toBe(true)
    expect(result.deleted).toEqual(['schemas/components/schemas/deep/Nested.yaml'])
  })

  it('deduplicates deleted files from overlapping managed dirs', () => {
    writeTargetFile('schemas/components/Old.yaml', 'old\n')

    const newFiles = new Map<string, string>()
    // Both managed dirs cover the same file
    const result = computeDiff(newFiles, targetRoot, ['schemas', 'schemas/components'])

    expect(result.deleted).toEqual(['schemas/components/Old.yaml'])
    // Should only appear once despite being under two managed dirs
    expect(result.deleted.length).toBe(1)
  })

  it('formats summary with multiple counts', () => {
    writeTargetFile('schemas/a.yaml', 'old-a\n')
    writeTargetFile('schemas/b.yaml', 'old-b\n')

    const newFiles = new Map([
      ['schemas/a.yaml', 'new-a\n'],
      ['schemas/b.yaml', 'new-b\n'],
      ['schemas/c.yaml', 'new-c\n'],
    ])
    const result = computeDiff(newFiles, targetRoot, ['schemas'])

    expect(result.summary).toBe('2 file(s) modified, 1 file(s) added')
  })
})
