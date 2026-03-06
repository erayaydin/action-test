import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { loadConfig, mapSourceToTarget, getManagedTargetDirs } from '../src/config'
import { resolveRefs } from '../src/resolve'
import { filterFiles } from '../src/filter'
import { computeDiff } from '../src/diff'
import { writeFiles, deleteFiles } from '../src/writer'

const fixturesDir = path.resolve(__dirname, 'fixtures')
const sourceRoot = path.join(fixturesDir, 'source')
const configPath = path.join(fixturesDir, 'configs/v2-config.yaml')

describe('integration: multi_file sync pipeline', () => {
  let targetRoot: string

  beforeEach(() => {
    targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'integration-test-'))
  })

  afterEach(() => {
    fs.rmSync(targetRoot, { recursive: true, force: true })
  })

  async function runPipeline(): Promise<{
    targetFiles: Map<string, string>
    diff: ReturnType<typeof computeDiff>
  }> {
    const config = loadConfig(configPath)

    // Resolve reachable files
    const reachableFiles = await resolveRefs(config.entrypoint, sourceRoot)

    // Read source files
    const sourceFiles = new Map<string, string>()
    for (const filePath of reachableFiles) {
      const absPath = path.resolve(sourceRoot, filePath)
      sourceFiles.set(filePath, fs.readFileSync(absPath, 'utf-8'))
    }

    // Filter
    const filterResult = filterFiles(sourceFiles, reachableFiles, config.internal)

    // Map to target paths
    const targetFiles = new Map<string, string>()
    for (const [sourcePath, content] of filterResult.filtered) {
      const targetPath = mapSourceToTarget(config, sourcePath)
      if (targetPath) {
        targetFiles.set(targetPath, content)
      }
    }

    // Diff
    const managedDirs = getManagedTargetDirs(config)
    const diff = computeDiff(targetFiles, targetRoot, managedDirs)

    return { targetFiles, diff }
  }

  it('produces the correct set of target files', async () => {
    const { targetFiles } = await runPipeline()

    const targetPaths = [...targetFiles.keys()].sort()

    // Should include public files mapped to target paths
    expect(targetPaths).toContain('schemas/petstore-api-v2.yaml')
    expect(targetPaths).toContain('schemas/components/schemas/Pet.yaml')
    expect(targetPaths).toContain('schemas/components/schemas/MixedModel.yaml')
    expect(targetPaths).toContain('schemas/components/schemas/breeds/Breed.yaml')
    expect(targetPaths).toContain('schemas/components/schemas/breeds/BreedConfidence.yaml')
    expect(targetPaths).toContain('schemas/components/schemas/vaccinations/Vaccination.yaml')
    expect(targetPaths).toContain('schemas/components/schemas/health/Microchip.yaml')
    expect(targetPaths).toContain('schemas/paths/pets.yaml')
    expect(targetPaths).toContain('schemas/paths/pet.yaml')
    expect(targetPaths).toContain('schemas/paths/examples/pets/get_pet_200.json')

    // Should NOT include internal files
    expect(targetPaths).not.toContain(expect.stringContaining('InternalDiagnostics'))
    expect(targetPaths).not.toContain(expect.stringContaining('internal-metrics'))
    expect(targetPaths).not.toContain(expect.stringContaining('Internal.yaml'))
    expect(targetPaths).not.toContain(expect.stringContaining('EncryptedRecord'))
  })

  it('excludes internal files (x-internal: true at top level)', async () => {
    const { targetFiles } = await runPipeline()

    // These files have x-internal: true at top level
    for (const [targetPath] of targetFiles) {
      expect(targetPath).not.toContain('InternalDiagnostics')
      expect(targetPath).not.toContain('internal-metrics')
    }
  })

  it('strips internal operations from path files', async () => {
    const { targetFiles } = await runPipeline()

    const petsContent = targetFiles.get('schemas/paths/pets.yaml')
    expect(petsContent).toBeDefined()
    // POST was x-internal: true, should be removed
    expect(petsContent).not.toContain('createPet')
    expect(petsContent).not.toContain('post:')
    // GET should remain
    expect(petsContent).toContain('listPets')
  })

  it('strips internal parameters', async () => {
    const { targetFiles } = await runPipeline()

    const petsContent = targetFiles.get('schemas/paths/pets.yaml')
    expect(petsContent).toBeDefined()
    // debug_token had x-internal: true
    expect(petsContent).not.toContain('debug_token')
    // limit should remain
    expect(petsContent).toContain('limit')
  })

  it('strips internal properties from schemas', async () => {
    const { targetFiles } = await runPipeline()

    const mixedContent = targetFiles.get('schemas/components/schemas/MixedModel.yaml')
    expect(mixedContent).toBeDefined()
    // internal_debug had x-internal: true
    expect(mixedContent).not.toContain('internal_debug')
    expect(mixedContent).not.toContain('trace_id')
    // internalRef had x-internal: true
    expect(mixedContent).not.toContain('internalRef')
    // Public fields should remain
    expect(mixedContent).toContain('id')
    expect(mixedContent).toContain('name')
  })

  it('removes dangling $refs to excluded files', async () => {
    const { targetFiles } = await runPipeline()

    const mixedContent = targetFiles.get('schemas/components/schemas/MixedModel.yaml')
    expect(mixedContent).toBeDefined()
    // encryptedData referenced EncryptedRecord.yaml which is x-internal -> dangling ref removed
    expect(mixedContent).not.toContain('encryptedData')
    expect(mixedContent).not.toContain('EncryptedRecord')
  })

  it('removes x-internal fields from output', async () => {
    const { targetFiles } = await runPipeline()

    // No file should contain x-internal in the output
    for (const [, content] of targetFiles) {
      expect(content).not.toContain('x-internal')
    }
  })

  it('removes dangling $refs from entrypoint', async () => {
    const { targetFiles } = await runPipeline()

    const entrypoint = targetFiles.get('schemas/petstore-api-v2.yaml')
    expect(entrypoint).toBeDefined()
    // InternalDiagnostics was excluded -> its $ref in components.schemas should be removed
    expect(entrypoint).not.toContain('InternalDiagnostics')
    // /internal-metrics was excluded -> its path should be removed
    expect(entrypoint).not.toContain('internal-metrics')
    // Public refs should remain
    expect(entrypoint).toContain('Pet')
    expect(entrypoint).toContain('MixedModel')
  })

  it('detects all files as added on first sync to empty target', async () => {
    const { diff } = await runPipeline()

    expect(diff.hasDiff).toBe(true)
    expect(diff.added.length).toBeGreaterThan(0)
    expect(diff.modified).toEqual([])
    expect(diff.deleted).toEqual([])
  })

  it('writes files and reports no diff on second run', async () => {
    // First run: write files
    const { targetFiles, diff: firstDiff } = await runPipeline()
    expect(firstDiff.hasDiff).toBe(true)
    writeFiles(targetFiles, targetRoot)

    // Second run: should detect no diff
    const { diff: secondDiff } = await runPipeline()
    expect(secondDiff.hasDiff).toBe(false)
    expect(secondDiff.summary).toBe('No changes')
  })

  it('detects deletions when previously-synced files become unreachable', async () => {
    // First run: write files
    const { targetFiles } = await runPipeline()
    writeFiles(targetFiles, targetRoot)

    // Add an extra file that doesn't come from the source
    const extraFilePath = path.join(targetRoot, 'schemas/components/schemas/OldSchema.yaml')
    fs.mkdirSync(path.dirname(extraFilePath), { recursive: true })
    fs.writeFileSync(extraFilePath, 'type: object\n')

    // Re-compute diff against target with the extra file
    const managedDirs = getManagedTargetDirs(loadConfig(configPath))
    const diffWithExtra = computeDiff(targetFiles, targetRoot, managedDirs)

    expect(diffWithExtra.deleted).toContain('schemas/components/schemas/OldSchema.yaml')
  })

  it('applies writes and deletes correctly', async () => {
    // Write an extra file that should be deleted
    const extraFilePath = path.join(targetRoot, 'schemas/components/schemas/OldSchema.yaml')
    fs.mkdirSync(path.dirname(extraFilePath), { recursive: true })
    fs.writeFileSync(extraFilePath, 'type: object\n')

    const { targetFiles } = await runPipeline()
    const config = loadConfig(configPath)
    const managedDirs = getManagedTargetDirs(config)
    const diff = computeDiff(targetFiles, targetRoot, managedDirs)

    writeFiles(targetFiles, targetRoot)
    deleteFiles(diff.deleted, targetRoot)

    // Extra file should be gone
    expect(fs.existsSync(extraFilePath)).toBe(false)

    // All target files should exist
    for (const [targetPath] of targetFiles) {
      expect(fs.existsSync(path.join(targetRoot, targetPath))).toBe(true)
    }
  })

  it('does not touch files outside managed directories', async () => {
    // Write a file outside the managed dirs
    const outsideFile = path.join(targetRoot, 'other-schema.yaml')
    fs.writeFileSync(outsideFile, 'type: string\n')

    const { targetFiles } = await runPipeline()
    const config = loadConfig(configPath)
    const managedDirs = getManagedTargetDirs(config)
    const diff = computeDiff(targetFiles, targetRoot, managedDirs)

    writeFiles(targetFiles, targetRoot)
    deleteFiles(diff.deleted, targetRoot)

    // File outside managed dirs should still exist
    expect(fs.existsSync(outsideFile)).toBe(true)
  })

  it('preserves non-YAML files like JSON examples', async () => {
    const { targetFiles } = await runPipeline()

    const jsonContent = targetFiles.get('schemas/paths/examples/pets/get_pet_200.json')
    expect(jsonContent).toBeDefined()
    // JSON file should be passed through as-is (not parsed as YAML)
    expect(JSON.parse(jsonContent!)).toEqual({
      petId: 'pet-123',
      breeds: {
        data: {
          breedName: 'Golden Retriever',
        },
      },
    })
  })
})
