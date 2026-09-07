import { describe, expect, it } from 'vitest'
import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  ToolOutputStore,
  TOOL_OUTPUT_MAX_INLINE_BYTES,
} from '../toolOutputStore'

async function makeStore(): Promise<{ store: ToolOutputStore; dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'curi-tool-output-'))
  return {
    store: new ToolOutputStore(dir),
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

function bigResult(itemCount: number): unknown {
  // The RAW bridge-result shape the runtime hands to bound(): items at top level.
  return {
    items: Array.from({ length: itemCount }, (_, index) => ({
      id: `item-${index}`,
      name: `构件-${index}（中文内容，UTF-8 字节按 3 计）`,
    })),
    total: itemCount,
    truncated: false,
  }
}

describe('ToolOutputStore — bounding (Cases 1–2, 8)', () => {
  it('Case 1: small results stay inline — no ref, no file', async () => {
    const { store, dir, cleanup } = await makeStore()
    try {
      const bounded = await store.bound({
        sessionId: 's1', toolCallId: 'c1', toolName: 'navisworks_status',
        data: { connected: true, document: 'model.nwd' },
      })
      expect(bounded.truncated).toBe(false)
      expect(bounded.resultRef).toBeUndefined()
      expect(bounded.content).toEqual({ connected: true, document: 'model.nwd' })
      const files = await readdir(dir)
      expect(files).toEqual([])
    } finally {
      await cleanup()
    }
  })

  it('Case 2: large arrays are stored in full; the model gets a preview + resultRef', async () => {
    const { store, dir, cleanup } = await makeStore()
    try {
      const data = bigResult(2_000)
      const bounded = await store.bound({
        sessionId: 's1', toolCallId: 'c1', toolName: 'navisworks_find_items', data,
      })
      expect(bounded.truncated).toBe(true)
      expect(typeof bounded.resultRef).toBe('string')
      expect(bounded.resultRef?.startsWith('tor_')).toBe(true)
      const preview = bounded.content as { items: unknown[]; returned: number; total: number; truncated: boolean; resultRef: string }
      expect(preview.items).toHaveLength(50)
      expect(preview.returned).toBe(50)
      expect(preview.total).toBe(2_000)
      expect(preview.truncated).toBe(true)
      expect(preview.resultRef).toBe(bounded.resultRef)
      // The full data is on disk; the preview is tiny by comparison.
      const files = await readdir(dir)
      expect(files).toHaveLength(1)
      const previewBytes = Buffer.byteLength(JSON.stringify(bounded.content), 'utf8')
      expect(previewBytes).toBeLessThan(TOOL_OUTPUT_MAX_INLINE_BYTES)
    } finally {
      await cleanup()
    }
  })

  it('Case 8: unicode content is bounded by UTF-8 bytes without breaking characters', async () => {
    const { store, cleanup } = await makeStore()
    try {
      // A single large string field: ~30k CJK chars ≈ 90k UTF-8 bytes.
      const data = { note: '汉'.repeat(30_000) }
      const bounded = await store.bound({
        sessionId: 's1', toolCallId: 'c1', toolName: 'navisworks_test', data,
      })
      expect(bounded.truncated).toBe(true)
      const preview = bounded.content as { preview: string; resultRef: string }
      expect(preview.resultRef).toBeDefined()
      // The clip runs on the JS string (code points), so CJK characters must
      // survive intact — no mojibake from byte-level slicing.
      expect(preview.preview).toContain('汉')
    } finally {
      await cleanup()
    }
  })
})

describe('ToolOutputStore — read_tool_result paging (Cases 3–5)', () => {
  async function makeWithLarge(): Promise<{ store: ToolOutputStore; ref: string; cleanup: () => Promise<void> }> {
    const made = await makeStore()
    const bounded = await made.store.bound({
      sessionId: 's1', toolCallId: 'c1', toolName: 'navisworks_find_items',
      data: { items: Array.from({ length: 120 }, (_, index) => `条目-${index}-` + 'x'.repeat(600)), truncated: false },
    })
    return { ...made, ref: bounded.resultRef! }
  }

  it('Case 3: the first page is correct', async () => {
    const made = await makeWithLarge()
    try {
      const page = await made.store.read(made.ref, 0, 100)
      expect(page.error).toBeUndefined()
      expect(page.returned).toBe(100)
      expect(page.total).toBe(120)
      expect(page.hasMore).toBe(true)
      expect(page.items?.[0]).toContain('条目-0-')
      expect(page.items?.[99]).toContain('条目-99-')
    } finally {
      await made.cleanup()
    }
  })

  it('Case 4: offset returns the second page', async () => {
    const made = await makeWithLarge()
    try {
      const page = await made.store.read(made.ref, 100, 100)
      expect(page.returned).toBe(20)
      expect(page.items?.[0]).toContain('条目-100-')
      expect(page.hasMore).toBe(false)
    } finally {
      await made.cleanup()
    }
  })

  it('Case 5: an out-of-range offset returns an empty page, not an error', async () => {
    const made = await makeWithLarge()
    try {
      const page = await made.store.read(made.ref, 5_000, 100)
      expect(page.error).toBeUndefined()
      expect(page.returned).toBe(0)
      expect(page.hasMore).toBe(false)
    } finally {
      await made.cleanup()
    }
  })
})

describe('ToolOutputStore — safety (Cases 6–7)', () => {
  it('Case 6: a crafted ref cannot escape the store directory', async () => {
    const { store, cleanup } = await makeStore()
    try {
      for (const malicious of ['../../settings', 'tor_../../settings.json', '', 'settings.json']) {
        const page = await store.read(malicious)
        expect(page.error).toBe('invalid resultRef')
      }
    } finally {
      await cleanup()
    }
  })

  it('Case 7: an expired/unknown ref returns "unavailable" without crashing', async () => {
    const { store, cleanup } = await makeStore()
    try {
      const page = await store.read(`tor_${'0'.repeat(8)}-0000-0000-0000-000000000000`)
      expect(page.error).toBe('tool result expired or unavailable')
    } finally {
      await cleanup()
    }
  })

  it('cleanup removes entries older than the retention window and never throws', async () => {
    const { store, dir, cleanup } = await makeStore()
    try {
      await store.bound({
        sessionId: 's1', toolCallId: 'c1', toolName: 'navisworks_test',
        data: { items: Array.from({ length: 2_000 }, (_, index) => `条目-${index}-` + 'x'.repeat(100)) },
      })
      // Nothing expired yet.
      expect(await store.cleanup(7 * 24 * 60 * 60 * 1000)).toBe(0)
      // Force the age past the window deterministically: a same-millisecond
      // mtime would make `now - mtime > 0` flaky on fast filesystems.
      const entries = await readdir(dir)
      const epoch = new Date(1)
      for (const entry of entries) {
        await utimes(join(dir, entry), epoch, epoch)
      }
      expect(await store.cleanup(1_000)).toBe(entries.length)
      // A missing directory must not throw either.
      await rm(dir, { recursive: true, force: true })
      expect(await store.cleanup(0)).toBe(0)
    } finally {
      await cleanup()
    }
  })
})

describe('ToolOutputStore — BARE ARRAY paging regression (P3.5)', () => {
  async function storeRawArray(length: number): Promise<{ store: ToolOutputStore; ref: string; dir: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'curi-tool-output-raw-'))
    const store = new ToolOutputStore(dir)
    const resultRef = `tor_${randomUUID()}`
    const data = Array.from({ length }, (_, index) => index)
    await writeFile(
      join(dir, `${resultRef}.json`),
      JSON.stringify({
        resultRef, sessionId: 's1', toolCallId: 'c1', toolName: 'navisworks_test',
        createdAt: Date.now(), data,
      }),
      'utf8',
    )
    return { store, ref: resultRef, dir }
  }

  it('offset=50 limit=50 returns items 50…99 (slice end is offset+limit, not limit)', async () => {
    const { store, ref, dir } = await storeRawArray(200)
    try {
      const page = await store.read(ref, 50, 50)
      expect(page.error).toBeUndefined()
      expect(page.items).toEqual(Array.from({ length: 50 }, (_, i) => 50 + i))
      expect(page.returned).toBe(50)
      expect(page.total).toBe(200)
      expect(page.hasMore).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('offset=180 limit=50 clamps to 180…199 with hasMore=false', async () => {
    const { store, ref, dir } = await storeRawArray(200)
    try {
      const page = await store.read(ref, 180, 50)
      expect(page.items).toEqual(Array.from({ length: 20 }, (_, i) => 180 + i))
      expect(page.returned).toBe(20)
      expect(page.total).toBe(200)
      expect(page.hasMore).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('the {items:[…]} object path keeps its correct paging', async () => {
    const { store, dir, cleanup } = await makeStore()
    try {
      const bounded = await store.bound({
        sessionId: 's1', toolCallId: 'c1', toolName: 'navisworks_find_items',
        data: { items: Array.from({ length: 120 }, (_, index) => `条目-${index}-` + 'x'.repeat(600)) },
      })
      const page = await store.read(bounded.resultRef!, 50, 50)
      expect(page.items).toHaveLength(50)
      expect(page.items?.[0]).toContain('条目-50-')
      expect(page.items?.[49]).toContain('条目-99-')
      expect(page.hasMore).toBe(true)
    } finally {
      await cleanup()
    }
  })
})
