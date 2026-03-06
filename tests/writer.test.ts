import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFiles, deleteFiles } from '../src/writer'

describe('writeFiles', () => {
  let targetRoot: string

  beforeEach(() => {
    targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-test-'))
  })

  afterEach(() => {
    fs.rmSync(targetRoot, { recursive: true, force: true })
  })

  it('writes a file to the target directory', () => {
    const files = new Map([['schemas/api.yaml', 'openapi: 3.0.0\n']])
    writeFiles(files, targetRoot)

    const written = fs.readFileSync(path.join(targetRoot, 'schemas/api.yaml'), 'utf-8')
    expect(written).toBe('openapi: 3.0.0\n')
  })

  it('creates nested parent directories', () => {
    const files = new Map([['schemas/components/schemas/Event.yaml', 'type: object\n']])
    writeFiles(files, targetRoot)

    const written = fs.readFileSync(path.join(targetRoot, 'schemas/components/schemas/Event.yaml'), 'utf-8')
    expect(written).toBe('type: object\n')
  })

  it('overwrites existing files', () => {
    const dir = path.join(targetRoot, 'schemas')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'api.yaml'), 'old content\n')

    const files = new Map([['schemas/api.yaml', 'new content\n']])
    writeFiles(files, targetRoot)

    const written = fs.readFileSync(path.join(targetRoot, 'schemas/api.yaml'), 'utf-8')
    expect(written).toBe('new content\n')
  })

  it('writes multiple files', () => {
    const files = new Map([
      ['schemas/a.yaml', 'a\n'],
      ['schemas/b.yaml', 'b\n'],
      ['schemas/nested/c.yaml', 'c\n'],
    ])
    writeFiles(files, targetRoot)

    expect(fs.readFileSync(path.join(targetRoot, 'schemas/a.yaml'), 'utf-8')).toBe('a\n')
    expect(fs.readFileSync(path.join(targetRoot, 'schemas/b.yaml'), 'utf-8')).toBe('b\n')
    expect(fs.readFileSync(path.join(targetRoot, 'schemas/nested/c.yaml'), 'utf-8')).toBe('c\n')
  })

  it('handles empty file map', () => {
    const files = new Map<string, string>()
    writeFiles(files, targetRoot)
    // Should not throw, no files created
    expect(fs.readdirSync(targetRoot)).toEqual([])
  })
})

describe('deleteFiles', () => {
  let targetRoot: string

  beforeEach(() => {
    targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-delete-test-'))
  })

  afterEach(() => {
    fs.rmSync(targetRoot, { recursive: true, force: true })
  })

  function writeFile(relPath: string, content: string) {
    const absPath = path.join(targetRoot, relPath)
    fs.mkdirSync(path.dirname(absPath), { recursive: true })
    fs.writeFileSync(absPath, content, 'utf-8')
  }

  it('deletes specified files', () => {
    writeFile('schemas/components/Old.yaml', 'old\n')
    writeFile('schemas/components/Keep.yaml', 'keep\n')

    deleteFiles(['schemas/components/Old.yaml'], targetRoot)

    expect(fs.existsSync(path.join(targetRoot, 'schemas/components/Old.yaml'))).toBe(false)
    expect(fs.existsSync(path.join(targetRoot, 'schemas/components/Keep.yaml'))).toBe(true)
  })

  it('cleans up empty directories after deletion', () => {
    writeFile('schemas/components/deep/nested/Only.yaml', 'only\n')

    deleteFiles(['schemas/components/deep/nested/Only.yaml'], targetRoot)

    expect(fs.existsSync(path.join(targetRoot, 'schemas/components/deep/nested'))).toBe(false)
    expect(fs.existsSync(path.join(targetRoot, 'schemas/components/deep'))).toBe(false)
    expect(fs.existsSync(path.join(targetRoot, 'schemas/components'))).toBe(false)
    expect(fs.existsSync(path.join(targetRoot, 'schemas'))).toBe(false)
  })

  it('does not delete non-empty parent directories', () => {
    writeFile('schemas/components/Delete.yaml', 'delete\n')
    writeFile('schemas/components/Keep.yaml', 'keep\n')

    deleteFiles(['schemas/components/Delete.yaml'], targetRoot)

    expect(fs.existsSync(path.join(targetRoot, 'schemas/components'))).toBe(true)
    expect(fs.existsSync(path.join(targetRoot, 'schemas/components/Keep.yaml'))).toBe(true)
  })

  it('handles already-deleted files gracefully', () => {
    // Should not throw for non-existent files
    deleteFiles(['schemas/nonexistent.yaml'], targetRoot)
  })

  it('handles empty delete list', () => {
    writeFile('schemas/keep.yaml', 'keep\n')

    deleteFiles([], targetRoot)

    expect(fs.existsSync(path.join(targetRoot, 'schemas/keep.yaml'))).toBe(true)
  })

  it('deletes multiple files and cleans up mixed directories', () => {
    writeFile('schemas/components/a/File1.yaml', 'f1\n')
    writeFile('schemas/components/a/File2.yaml', 'f2\n')
    writeFile('schemas/components/b/File3.yaml', 'f3\n')

    deleteFiles(['schemas/components/a/File1.yaml', 'schemas/components/a/File2.yaml'], targetRoot)

    // Dir 'a' should be cleaned up (empty)
    expect(fs.existsSync(path.join(targetRoot, 'schemas/components/a'))).toBe(false)
    // Dir 'b' should still exist
    expect(fs.existsSync(path.join(targetRoot, 'schemas/components/b/File3.yaml'))).toBe(true)
  })
})
