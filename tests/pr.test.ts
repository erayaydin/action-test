import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { handlePrLifecycle } from '../src/pr'
import type { PrOptions } from '../src/pr'

function mockFetch(responses: Array<{ status: number; body?: unknown }>): void {
  let callIndex = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      const resp = responses[callIndex] ?? { status: 200, body: [] }
      callIndex++
      return {
        ok: resp.status >= 200 && resp.status < 300,
        status: resp.status,
        json: async () => resp.body ?? [],
      }
    })
  )
}

function defaultOptions(overrides?: Partial<PrOptions>): PrOptions {
  return {
    githubToken: 'test-token',
    sourceRepo: 'owner/source',
    sourcePrNumber: 42,
    sourcePrMerged: true,
    targetRepo: 'owner/target',
    targetPrNumber: 99,
    ...overrides,
  }
}

function getFetchCallBody(callIndex: number): Record<string, unknown> {
  const fetchMock = vi.mocked(fetch)
  return JSON.parse(String(fetchMock.mock.calls[callIndex][1]?.body))
}

function getFetchCallHeaders(callIndex: number): Record<string, string> {
  const fetchMock = vi.mocked(fetch)
  const headers = fetchMock.mock.calls[callIndex][1]?.headers
  return headers ? Object.fromEntries(Object.entries(headers)) : {}
}

describe('handlePrLifecycle', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('creates link comment on source PR when no existing comment', async () => {
    mockFetch([
      // GET comments on source PR (find link comment) → none
      { status: 200, body: [] },
      // POST comment on source PR
      { status: 201 },
      // DELETE label on target PR (source merged → remove warning label)
      { status: 404 },
      // GET comments on target PR (find merged comment) → none
      { status: 200, body: [] },
      // POST merged comment on target PR
      { status: 201 },
    ])

    await handlePrLifecycle(defaultOptions())

    const fetchMock = vi.mocked(fetch)
    // First call: list comments on source PR
    expect(fetchMock.mock.calls[0][0]).toContain('/repos/owner/source/issues/42/comments')
    // Second call: create comment on source PR
    expect(fetchMock.mock.calls[1][0]).toContain('/repos/owner/source/issues/42/comments')
    expect(fetchMock.mock.calls[1][1]?.method).toBe('POST')
    const body = getFetchCallBody(1)
    expect(body.body).toContain('<!-- openapi-sync-link -->')
    expect(body.body).toContain('owner/target#99')
  })

  it('updates existing link comment on source PR', async () => {
    mockFetch([
      // GET comments on source PR → existing link comment
      {
        status: 200,
        body: [{ id: 777, body: '<!-- openapi-sync-link -->\nOld link' }],
      },
      // PATCH existing comment
      { status: 200 },
      // DELETE label (source merged)
      { status: 404 },
      // GET comments on target PR
      { status: 200, body: [] },
      // POST merged comment
      { status: 201 },
    ])

    await handlePrLifecycle(defaultOptions())

    const fetchMock = vi.mocked(fetch)
    // Second call: update existing comment
    expect(fetchMock.mock.calls[1][0]).toContain('/issues/comments/777')
    expect(fetchMock.mock.calls[1][1]?.method).toBe('PATCH')
  })

  it('adds warning label and comment when source not merged', async () => {
    mockFetch([
      // GET comments on source PR → none
      { status: 200, body: [] },
      // POST link comment on source PR
      { status: 201 },
      // POST label on target PR
      { status: 200 },
      // GET comments on target PR → none
      { status: 200, body: [] },
      // POST warning comment on target PR
      { status: 201 },
    ])

    await handlePrLifecycle(defaultOptions({ sourcePrMerged: false }))

    const fetchMock = vi.mocked(fetch)
    // Third call: add label
    expect(fetchMock.mock.calls[2][0]).toContain('/repos/owner/target/issues/99/labels')
    expect(fetchMock.mock.calls[2][1]?.method).toBe('POST')
    const labelBody = getFetchCallBody(2)
    expect(labelBody.labels).toEqual(['Source PR Not Merged'])

    // Fifth call: post warning comment
    const commentBody = getFetchCallBody(4)
    expect(commentBody.body).toContain('<!-- openapi-sync-warning -->')
    expect(commentBody.body).toContain('not finalized yet')
  })

  it('removes warning label and adds merged comment when source is merged', async () => {
    mockFetch([
      // GET comments on source PR
      { status: 200, body: [] },
      // POST link comment
      { status: 201 },
      // DELETE warning label from target PR
      { status: 200 },
      // GET comments on target PR
      { status: 200, body: [] },
      // POST merged comment
      { status: 201 },
    ])

    await handlePrLifecycle(defaultOptions({ sourcePrMerged: true }))

    const fetchMock = vi.mocked(fetch)
    // Third call: remove label
    expect(fetchMock.mock.calls[2][0]).toContain('/repos/owner/target/issues/99/labels/Source%20PR%20Not%20Merged')
    expect(fetchMock.mock.calls[2][1]?.method).toBe('DELETE')

    // Fifth call: merged comment
    const commentBody = getFetchCallBody(4)
    expect(commentBody.body).toContain('<!-- openapi-sync-merged -->')
    expect(commentBody.body).toContain('have been finalized')
    expect(commentBody.body).toContain('ready for review')
  })

  it('warns on failed comment listing', async () => {
    mockFetch([
      // GET comments fails
      { status: 403 },
      // POST comment (falls through since findComment returned null)
      { status: 201 },
      // DELETE label
      { status: 404 },
      // GET comments on target PR
      { status: 200, body: [] },
      // POST merged comment
      { status: 201 },
    ])

    await handlePrLifecycle(defaultOptions())

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to list comments'))
  })

  it('warns on failed comment creation', async () => {
    mockFetch([
      // GET comments
      { status: 200, body: [] },
      // POST comment fails
      { status: 500 },
      // DELETE label
      { status: 404 },
      // GET comments on target PR
      { status: 200, body: [] },
      // POST merged comment fails too
      { status: 500 },
    ])

    await handlePrLifecycle(defaultOptions())

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to create comment'))
  })

  it('warns on failed comment update', async () => {
    mockFetch([
      // GET comments → existing
      { status: 200, body: [{ id: 1, body: '<!-- openapi-sync-link -->\nold' }] },
      // PATCH fails
      { status: 500 },
      // DELETE label
      { status: 404 },
      // GET comments on target PR
      { status: 200, body: [] },
      // POST merged comment
      { status: 201 },
    ])

    await handlePrLifecycle(defaultOptions())

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to update comment'))
  })

  it('warns on failed label add', async () => {
    mockFetch([
      // GET source comments
      { status: 200, body: [] },
      // POST link comment
      { status: 201 },
      // POST label fails
      { status: 403 },
      // GET target comments
      { status: 200, body: [] },
      // POST warning comment
      { status: 201 },
    ])

    await handlePrLifecycle(defaultOptions({ sourcePrMerged: false }))

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to add label'))
  })

  it('warns on failed label removal (non-404)', async () => {
    mockFetch([
      // GET source comments
      { status: 200, body: [] },
      // POST link comment
      { status: 201 },
      // DELETE label fails with 500
      { status: 500 },
      // GET target comments
      { status: 200, body: [] },
      // POST merged comment
      { status: 201 },
    ])

    await handlePrLifecycle(defaultOptions({ sourcePrMerged: true }))

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to remove label'))
  })

  it('does not warn when label removal returns 404 (label was not there)', async () => {
    mockFetch([
      // GET source comments
      { status: 200, body: [] },
      // POST link comment
      { status: 201 },
      // DELETE label → 404 (not there)
      { status: 404 },
      // GET target comments
      { status: 200, body: [] },
      // POST merged comment
      { status: 201 },
    ])

    await handlePrLifecycle(defaultOptions({ sourcePrMerged: true }))

    // No warning about label removal
    const labelWarnings = warnSpy.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('Failed to remove label')
    )
    expect(labelWarnings).toHaveLength(0)
  })

  it('updates existing warning comment instead of creating duplicate', async () => {
    mockFetch([
      // GET source comments
      { status: 200, body: [] },
      // POST link comment
      { status: 201 },
      // POST label
      { status: 200 },
      // GET target comments → existing warning
      {
        status: 200,
        body: [{ id: 888, body: '<!-- openapi-sync-warning -->\nOld warning' }],
      },
      // PATCH warning comment
      { status: 200 },
    ])

    await handlePrLifecycle(defaultOptions({ sourcePrMerged: false }))

    const fetchMock = vi.mocked(fetch)
    expect(fetchMock.mock.calls[4][0]).toContain('/issues/comments/888')
    expect(fetchMock.mock.calls[4][1]?.method).toBe('PATCH')
  })

  it('handles non-array response from comments endpoint', async () => {
    mockFetch([
      // GET comments returns a non-array (unexpected API response)
      { status: 200, body: { message: 'unexpected' } },
      // POST comment (falls through since findComment returned null)
      { status: 201 },
      // DELETE label
      { status: 404 },
      // GET target comments also non-array
      { status: 200, body: 'not-an-array' },
      // POST merged comment
      { status: 201 },
    ])

    await handlePrLifecycle(defaultOptions())

    const fetchMock = vi.mocked(fetch)
    // Should create new comments since findComment returned null
    expect(fetchMock.mock.calls[1][1]?.method).toBe('POST')
    expect(fetchMock.mock.calls[4][1]?.method).toBe('POST')
  })

  it('sends correct Authorization header', async () => {
    mockFetch([{ status: 200, body: [] }, { status: 201 }, { status: 404 }, { status: 200, body: [] }, { status: 201 }])

    await handlePrLifecycle(defaultOptions({ githubToken: 'my-secret-token' }))

    const fetchMock = vi.mocked(fetch)
    for (let i = 0; i < fetchMock.mock.calls.length; i++) {
      const headers = getFetchCallHeaders(i)
      expect(headers.Authorization).toBe('token my-secret-token')
    }
  })
})
