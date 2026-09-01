import { mkdtemp, readdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  DEFAULT_EXTERNALIZE_THRESHOLD_BYTES,
  EXTERNALIZED_TOOL_RESULT_MARKER,
  collectLiveRefIds,
  externalizeResult,
  isExternalizedResult,
  pruneExternalizedResults,
  resolveResult,
  toolResultsDirectory,
} from '../toolResultStore'

let dir: string
beforeAll(async () => { dir = await mkdtemp(path.join(tmpdir(), 'navis-mcp-tr-')) })
afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

const bigPayload = { items: Array.from({ length: 40_000 }, (_, i) => ({ id: `i${i}`, name: `泵-${i}` })) }

describe('toolResultStore — externalize only above threshold', () => {
  it('keeps small results inline (returns null)', async () => {
    expect(await externalizeResult(dir, 's:m:small', { items: [{ id: 'a' }] })).toBeNull()
    expect(isExternalizedResult({ items: [] })).toBe(false)
  })

  it('writes a big result to disk and returns a ref carrying a preview', async () => {
    const ref = (await externalizeResult(dir, 's:m:big', bigPayload))!
    expect(ref).not.toBeNull()
    expect(ref[EXTERNALIZED_TOOL_RESULT_MARKER]).toBe(true)
    expect(ref.byteLength).toBeGreaterThan(DEFAULT_EXTERNALIZE_THRESHOLD_BYTES)
    expect(ref.preview).toContain('泵-')
    // File actually exists on disk.
    const files = await readdir(dir)
    expect(files.some((f) => f.includes('big'))).toBe(true)
  })

  it('resolves a ref back to the full payload, and passes plain values through', async () => {
    const ref = (await externalizeResult(dir, 's:m:big2', bigPayload))!
    expect(await resolveResult(dir, ref)).toEqual(bigPayload)
    expect(await resolveResult(dir, { inline: true })).toEqual({ inline: true })
  })

  it('collects live refIds and prunes everything else', async () => {
    const d = await mkdtemp(path.join(tmpdir(), 'navis-mcp-prune-'))
    const keep = (await externalizeResult(d, 'sess:msg:keep', bigPayload))!
    const drop = (await externalizeResult(d, 'sess:msg:drop', bigPayload))!
    const removed = await pruneExternalizedResults(d, new Set([keep.refId]))
    expect(removed).toBe(1)
    const remaining = await readdir(d)
    expect(remaining.some((f) => f.includes('keep'))).toBe(true)
    expect(remaining.some((f) => f.includes('drop'))).toBe(false)
    // collectLiveRefIds finds the ref still referenced by a session message; `drop` is not
    // referenced, so only `keep` is collected.
    expect(collectLiveRefIds([
      { messages: [{ tools: [{ result: keep }, { result: { plain: 1 } }] }] },
    ])).toEqual(new Set([keep.refId]))
    await rm(d, { recursive: true, force: true })
  })

  it('is robust to a missing directory on resolve and prune', async () => {
    const fakeRef = { [EXTERNALIZED_TOOL_RESULT_MARKER]: true as const, refId: 'nope', preview: 'p', byteLength: 1 }
    // Missing file → returns the preview rather than throwing.
    expect(await resolveResult(path.join(dir, 'does-not-exist'), fakeRef)).toBe('p')
    expect(await pruneExternalizedResults(path.join(dir, 'does-not-exist'), new Set())).toBe(0)
  })
})

describe('toolResultsDirectory helper', () => {
  it('nests under the data root', () => {
    expect(toolResultsDirectory('/data/root')).toBe(path.join('/data/root', 'tool-results'))
  })
})
