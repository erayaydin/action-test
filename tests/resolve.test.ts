import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import { describe, it, expect, vi } from 'vitest'
import { resolveRefs } from '../src/resolve'

const sourceRoot = path.resolve(__dirname, 'fixtures/source')

describe('resolveRefs', () => {
  it('resolves the full ref graph from entrypoint', async () => {
    const files = await resolveRefs('api/v2/petstore-api.yaml', sourceRoot)

    // Entrypoint itself
    expect(files.has('api/v2/petstore-api.yaml')).toBe(true)

    // Direct refs from entrypoint
    expect(files.has('api/v2/paths/pets.yaml')).toBe(true)
    expect(files.has('api/v2/paths/pet.yaml')).toBe(true)
    expect(files.has('api/v2/paths/internal-metrics.yaml')).toBe(true)
    expect(files.has('api/v2/components/schemas/Pet.yaml')).toBe(true)
    expect(files.has('api/v2/components/schemas/InternalDiagnostics.yaml')).toBe(true)
    expect(files.has('api/v2/components/schemas/MixedModel.yaml')).toBe(true)
  })

  it('resolves deeply nested refs (branching)', async () => {
    const files = await resolveRefs('api/v2/petstore-api.yaml', sourceRoot)

    // Pet.yaml refs
    expect(files.has('api/v2/components/schemas/breeds/Breed.yaml')).toBe(true)
    expect(files.has('api/v2/components/schemas/vaccinations/Vaccination.yaml')).toBe(true)
    expect(files.has('api/v2/components/schemas/health/Microchip.yaml')).toBe(true)

    // Breed -> BreedConfidence
    expect(files.has('api/v2/components/schemas/breeds/BreedConfidence.yaml')).toBe(true)

    // MixedModel refs
    expect(files.has('api/v2/components/schemas/health/Internal.yaml')).toBe(true)
    expect(files.has('api/v2/components/schemas/health/EncryptedRecord.yaml')).toBe(true)
  })

  it('includes non-YAML files referenced via $ref', async () => {
    const files = await resolveRefs('api/v2/petstore-api.yaml', sourceRoot)

    // pets.yaml references a JSON example file
    expect(files.has('api/v2/paths/examples/pets/get_pet_200.json')).toBe(true)
  })

  it('handles circular references without infinite loop', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'resolve-circular-'))

    await fs.writeFile(path.join(tmpDir, 'a.yaml'), 'type: object\nproperties:\n  b:\n    $ref: "./b.yaml"\n')
    await fs.writeFile(path.join(tmpDir, 'b.yaml'), 'type: object\nproperties:\n  a:\n    $ref: "./a.yaml"\n')

    const files = await resolveRefs('a.yaml', tmpDir)
    expect(files.has('a.yaml')).toBe(true)
    expect(files.has('b.yaml')).toBe(true)
    expect(files.size).toBe(2)

    await fs.rm(tmpDir, { recursive: true })
  })

  it('extracts file part from fragment refs', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'resolve-fragment-'))

    await fs.writeFile(
      path.join(tmpDir, 'entry.yaml'),
      'components:\n  schemas:\n    Foo:\n      $ref: "./models.yaml#/schemas/Foo"\n'
    )
    await fs.writeFile(path.join(tmpDir, 'models.yaml'), 'schemas:\n  Foo:\n    type: string\n')

    const files = await resolveRefs('entry.yaml', tmpDir)
    expect(files.has('entry.yaml')).toBe(true)
    expect(files.has('models.yaml')).toBe(true)

    await fs.rm(tmpDir, { recursive: true })
  })

  it('skips internal-only refs (starting with #)', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'resolve-internal-'))

    await fs.writeFile(
      path.join(tmpDir, 'entry.yaml'),
      'components:\n  schemas:\n    Foo:\n      $ref: "#/components/schemas/Bar"\n    Bar:\n      type: string\n'
    )

    const files = await resolveRefs('entry.yaml', tmpDir)
    expect(files.size).toBe(1)
    expect(files.has('entry.yaml')).toBe(true)

    await fs.rm(tmpDir, { recursive: true })
  })

  it('warns on missing referenced file and continues', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'resolve-missing-'))

    await fs.writeFile(
      path.join(tmpDir, 'entry.yaml'),
      'refs:\n  a:\n    $ref: "./exists.yaml"\n  b:\n    $ref: "./missing.yaml"\n'
    )
    await fs.writeFile(path.join(tmpDir, 'exists.yaml'), 'type: string\n')

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const files = await resolveRefs('entry.yaml', tmpDir)
    expect(files.has('entry.yaml')).toBe(true)
    expect(files.has('exists.yaml')).toBe(true)
    expect(files.has('missing.yaml')).toBe(true) // Added to visited even though missing
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('missing.yaml'))

    warnSpy.mockRestore()
    await fs.rm(tmpDir, { recursive: true })
  })

  it('does not include unreachable files on disk', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'resolve-unreachable-'))

    await fs.writeFile(path.join(tmpDir, 'entry.yaml'), 'type: string\n')
    await fs.writeFile(path.join(tmpDir, 'unreachable.yaml'), 'type: number\n')

    const files = await resolveRefs('entry.yaml', tmpDir)
    expect(files.has('entry.yaml')).toBe(true)
    expect(files.has('unreachable.yaml')).toBe(false)

    await fs.rm(tmpDir, { recursive: true })
  })

  it('entrypoint is always included in the set', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'resolve-entry-'))
    await fs.writeFile(path.join(tmpDir, 'entry.yaml'), 'type: string\n')

    const files = await resolveRefs('entry.yaml', tmpDir)
    expect(files.has('entry.yaml')).toBe(true)

    await fs.rm(tmpDir, { recursive: true })
  })

  it('counts total reachable files correctly', async () => {
    const files = await resolveRefs('api/v2/petstore-api.yaml', sourceRoot)

    // petstore-api + 3 paths + 1 json example + 3 top-level schemas +
    // 2 breeds + 1 vaccination + 1 microchip + 1 internal + 1 encryptedrecord = 14
    expect(files.size).toBe(14)
  })

  it('warns and continues on invalid YAML', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'resolve-invalid-yaml-'))

    await fs.writeFile(path.join(tmpDir, 'entry.yaml'), 'refs:\n  a:\n    $ref: "./bad.yaml"\n')
    await fs.writeFile(path.join(tmpDir, 'bad.yaml'), 'invalid: yaml: [unclosed')

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const files = await resolveRefs('entry.yaml', tmpDir)
    expect(files.has('entry.yaml')).toBe(true)
    expect(files.has('bad.yaml')).toBe(true)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('bad.yaml'))

    warnSpy.mockRestore()
    await fs.rm(tmpDir, { recursive: true })
  })

  it('does not parse non-YAML/JSON files for refs', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'resolve-noparse-'))

    await fs.writeFile(path.join(tmpDir, 'entry.yaml'), 'example:\n  $ref: "./data.txt"\n')
    await fs.writeFile(path.join(tmpDir, 'data.txt'), '$ref: "./should-not-follow.yaml"')
    await fs.writeFile(path.join(tmpDir, 'should-not-follow.yaml'), 'type: string\n')

    const files = await resolveRefs('entry.yaml', tmpDir)
    expect(files.has('entry.yaml')).toBe(true)
    expect(files.has('data.txt')).toBe(true)
    // data.txt is not YAML/JSON, so its $ref should not be followed
    expect(files.has('should-not-follow.yaml')).toBe(false)

    await fs.rm(tmpDir, { recursive: true })
  })

  it('handles $ref with empty file part after split', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'resolve-empty-ref-'))

    // A $ref like "#/components/Foo" has empty file part — already tested via internal ref skip
    // But "#" alone also has empty file part
    await fs.writeFile(path.join(tmpDir, 'entry.yaml'), 'schemas:\n  Foo:\n    $ref: "#"\n')

    const files = await resolveRefs('entry.yaml', tmpDir)
    expect(files.size).toBe(1)
    expect(files.has('entry.yaml')).toBe(true)

    await fs.rm(tmpDir, { recursive: true })
  })

  it('skips $ref with empty string value', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'resolve-empty-string-'))

    await fs.writeFile(path.join(tmpDir, 'entry.yaml'), 'schemas:\n  Foo:\n    $ref: ""\n')

    const files = await resolveRefs('entry.yaml', tmpDir)
    expect(files.size).toBe(1)
    expect(files.has('entry.yaml')).toBe(true)

    await fs.rm(tmpDir, { recursive: true })
  })
})
