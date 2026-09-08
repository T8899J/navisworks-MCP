import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContextEngine } from '../context/contextEngine'
import { ContextEpochStore } from '../context/contextEpochStore'
import { ContextRegistry } from '../context/contextRegistry'
import { createContextRegistry } from '../context/contextRegistry'
import { CapabilityRegistry } from '../capability/capabilityRegistry'
import { NavisworksCapabilityProvider } from '../navisworks/capability'

// Capability Architecture: the engine tests exercise the PRODUCTION shape —
// the Navisworks capability contributes its policy/document/facts/reference/
// recall sources exactly as it does in the app.
const contextRegistry = createContextRegistry(new CapabilityRegistry([
  new NavisworksCapabilityProvider({ bridge: { call: async <T>(): Promise<T> => ({}) as T } }),
]))
import { canonicalFingerprint, canonicalJson, computePrefixHash } from '../context/contextHash'
import { documentSource } from '../context/sources/documentSource'
import { ContextState } from '../agent/contextState'
import { ContextManager } from '../agent/contextManager'
import type { ContextSourceEnvironment } from '../context/types'
import { CURI_CORE_PROMPT, NAVISWORKS_CAPABILITY_PROMPT } from '../agent/prompts'

async function tempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'curi-context-'))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

function makeEngine(store: ContextEpochStore | undefined = undefined): ContextEngine {
  return new ContextEngine(contextRegistry, store)
}

function docEnv(
  document: { connected: boolean; documentInstanceId?: string; documentName?: string; bridgeSessionId?: string; instanceId?: string },
  extra: Partial<ContextSourceEnvironment> = {},
): ContextSourceEnvironment {
  return {
    sessionId: 'session-1',
    document,
    ...extra,
  }
}

describe('Context baseline (P10, §57)', () => {
  it('Case A/B: two prepares produce byte-identical baseline + baselineHash', async () => {
    const { dir, cleanup } = await tempDir()
    try {
      const engine = makeEngine(new ContextEpochStore(dir))
      const first = await engine.prepare('s1', docEnv({ connected: true, documentInstanceId: 'A' }))
      const second = await engine.prepare('s2', docEnv({ connected: true, documentInstanceId: 'A' }))
      expect(first.baseline).toBe(second.baseline)
      expect(first.baselineHash).toBe(second.baselineHash)
      expect(first.baseline).toContain(CURI_CORE_PROMPT.slice(0, 12))
      expect(first.baseline).toContain(NAVISWORKS_CAPABILITY_PROMPT.slice(0, 12))
    } finally {
      await cleanup()
    }
  })

  it('Case C/D/E: volatile memory, task state and document change never move baselineHash', async () => {
    const { dir, cleanup } = await tempDir()
    try {
      const store = new ContextEpochStore(dir)
      const engine = makeEngine(store)
      const base = await engine.prepare('s1', docEnv({ connected: true, documentInstanceId: 'A' }))
      await engine.commit(base.epoch)
      const withMemory = await engine.prepare('s1', docEnv(
        { connected: true, documentInstanceId: 'A' },
        { semanticMemory: { goals: ['x'], constraints: [], decisions: [], notes: [], updatedAt: 1 } },
      ))
      const withTask = await engine.prepare('s1', docEnv(
        { connected: true, documentInstanceId: 'A' },
        { activeTask: sampleTask('running') },
      ))
      const withDocB = await engine.prepare('s1', docEnv({ connected: true, documentInstanceId: 'B' }))
      expect(withMemory.baselineHash).toBe(base.baselineHash)
      expect(withTask.baselineHash).toBe(base.baselineHash)
      // Document change appends an update but NEVER rewrites the baseline.
      expect(withDocB.baselineHash).toBe(base.baselineHash)
      expect(withDocB.updatesAdded).toBeGreaterThan(0)
    } finally {
      await cleanup()
    }
  })
})

describe('Context Epoch lifecycle (P11, §58)', () => {
  it('first prepare creates generation 1; second prepare keeps the same epochId', async () => {
    const { dir, cleanup } = await tempDir()
    try {
      const store = new ContextEpochStore(dir)
      const engine = makeEngine(store)
      const first = await engine.prepare('s1', docEnv({ connected: false }))
      expect(first.generation).toBe(1)
      expect(first.status).toBe('rolled-over')
      await engine.commit(first.epoch)
      const second = await engine.prepare('s1', docEnv({ connected: false }))
      expect(second.epochId).toBe(first.epochId)
      expect(second.generation).toBe(1)
    } finally {
      await cleanup()
    }
  })

  it('Unchanged (§59): same document two rounds → updatesAdded 0, prefixHash stable', async () => {
    const { dir, cleanup } = await tempDir()
    try {
      const store = new ContextEpochStore(dir)
      const engine = makeEngine(store)
      const first = await engine.prepare('s1', docEnv({ connected: true, documentInstanceId: 'A', documentName: 'A.nwd' }))
      await engine.commit(first.epoch)
      const second = await engine.prepare('s1', docEnv({ connected: true, documentInstanceId: 'A', documentName: 'A.nwd' }))
      expect(second.updatesAdded).toBe(0)
      expect(second.epoch.updates).toHaveLength(first.epoch.updates.length)
      expect(second.prefixHash).toBe(first.prefixHash)
    } finally {
      await cleanup()
    }
  })

  it('Document switch (§60): A→B appends exactly one update; epochId + baselineHash unchanged; old update frozen', async () => {
    const { dir, cleanup } = await tempDir()
    try {
      const store = new ContextEpochStore(dir)
      const engine = makeEngine(store)
      const first = await engine.prepare('s1', docEnv({ connected: true, documentInstanceId: 'A', documentName: 'A.nwd' }))
      await engine.commit(first.epoch)
      const firstUpdateCount = first.epoch.updates.length
      const firstUpdates = JSON.parse(JSON.stringify(first.epoch.updates))
      const second = await engine.prepare('s1', docEnv({ connected: true, documentInstanceId: 'B', documentName: 'B.nwd' }))
      expect(second.epochId).toBe(first.epochId)
      expect(second.baselineHash).toBe(first.baselineHash)
      expect(second.epoch.updates.length).toBe(firstUpdateCount + 1)
      // The appended update carries document-switch semantics.
      const added = second.epoch.updates[second.epoch.updates.length - 1]
      expect(added?.text).toContain('B.nwd')
      // The older updates were NOT rewritten.
      expect(JSON.parse(JSON.stringify(second.epoch.updates.slice(0, firstUpdateCount)))).toEqual(firstUpdates)
    } finally {
      await cleanup()
    }
  })
})

describe('Cross-document isolation (Invariant D, §61)', () => {
  it('after A→B, assembly contains neither A facts nor A reference set', async () => {
    const contextState = new ContextState()
    contextState.observe({ connected: true, documentInstanceId: 'doc-A', bridgeSessionId: 'b1' })
    contextState.ingestToolResult('navisworks_find_items', {
      items: [{ id: 'itemA1', name: '水泵A1' }, { id: 'itemA2', name: '水泵A2' }],
    }, 'call-A')
    // Document switch drives ContextState's cross-store invalidation.
    contextState.observe({ connected: true, documentInstanceId: 'doc-B', bridgeSessionId: 'b1' })
    const { dir, cleanup } = await tempDir()
    try {
      const engine = makeEngine(new ContextEpochStore(dir))
      const onB = await engine.prepare('s1', {
        sessionId: 's1',
        document: contextState.currentDocument ?? { connected: true, documentInstanceId: 'doc-B', bridgeSessionId: 'b1' },
        contextState,
      })
      const joined = onB.blocks.map((b) => b.message.content).join('\n')
      expect(joined).not.toContain('itemA1')
      expect(joined).not.toContain('水泵A1')
      expect(joined).not.toContain('call-A')
    } finally {
      await cleanup()
    }
  })
})

describe('Volatile sources stay volatile (§62/§63)', () => {
  it('semantic-memory change updates the volatile block but adds no durable update', async () => {
    const { dir, cleanup } = await tempDir()
    try {
      const store = new ContextEpochStore(dir)
      const engine = makeEngine(store)
      const doc = { connected: true, documentInstanceId: 'A', documentName: 'A.nwd' }
      const first = await engine.prepare('s1', docEnv(doc))
      await engine.commit(first.epoch)
      const withMemory = await engine.prepare('s1', docEnv(doc, {
        semanticMemory: { goals: ['目标一'], constraints: [], decisions: [], notes: [], updatedAt: 5 },
      }))
      expect(withMemory.updatesAdded).toBe(0)
      expect(withMemory.baselineHash).toBe(first.baselineHash)
      const memBlock = withMemory.blocks.find((b) => b.kind === 'semantic-memory')
      expect(memBlock?.message.content).toContain('目标一')
    } finally {
      await cleanup()
    }
  })

  it('task running→paused→running: volatile changes only, no new epoch, no durable update', async () => {
    const { dir, cleanup } = await tempDir()
    try {
      const store = new ContextEpochStore(dir)
      const engine = makeEngine(store)
      const doc = { connected: true, documentInstanceId: 'A', documentName: 'A.nwd' }
      const base = await engine.prepare('s1', docEnv(doc))
      await engine.commit(base.epoch)
      const running = await engine.prepare('s1', docEnv(doc, { activeTask: sampleTask('running') }))
      const paused = await engine.prepare('s1', docEnv(doc, { activeTask: sampleTask('paused') }))
      for (const assembly of [running, paused]) {
        expect(assembly.epochId).toBe(base.epochId)
        expect(assembly.updatesAdded).toBe(0)
        expect(assembly.baselineHash).toBe(base.baselineHash)
      }
      const taskBlock = running.blocks.find((b) => b.kind === 'task-state')
      expect(taskBlock?.message.content).toContain('状态：running')
    } finally {
      await cleanup()
    }
  })
})

describe('Baseline rollover + compaction + persistence (§64–§70)', () => {
  it('§67 baseline changed → new epoch, reason baseline-changed, generation +1', async () => {
    // A registry whose core source is v1, then a v2 core source with different text.
    const { dir, cleanup } = await tempDir()
    try {
      const store = new ContextEpochStore(dir)
      const engine = makeEngine(store)
      const v1 = await engine.prepare('s1', docEnv({ connected: false }))
      await engine.commit(v1.epoch)
      // Simulate a prompt release: a NEW engine with a bumped baseline source.
      const bumpedRegistry = new ContextRegistry(registryWithCoreVersion(2))
      const engine2 = new ContextEngine(bumpedRegistry, store)
      const after = await engine2.prepare('s1', docEnv({ connected: false }))
      expect(after.status).toBe('rolled-over')
      expect(after.generation).toBe(v1.generation + 1)
      expect(after.epochId).not.toBe(v1.epochId)
    } finally {
      await cleanup()
    }
  })

  it('§64 compaction rollover: generation +1, new epochId, seed = summary, baselineHash unchanged', async () => {
    const { dir, cleanup } = await tempDir()
    try {
      const store = new ContextEpochStore(dir)
      const engine = makeEngine(store)
      const before = await engine.prepare('s1', docEnv({ connected: true, documentInstanceId: 'A', documentName: 'A.nwd' }))
      await engine.commit(before.epoch)
      const after = await engine.rollOverForCompaction('s1', '早期工作摘要内容', before.epoch)
      expect(after.generation).toBe(before.generation + 1)
      expect(after.epochId).not.toBe(before.epochId)
      expect(after.seed).toEqual({ kind: 'compact-summary', text: '早期工作摘要内容' })
      expect(after.baselineHash).toBe(before.baselineHash)
    } finally {
      await cleanup()
    }
  })

  it('§68 restart recovery: a fresh store over the same dir reloads epoch; same document → no new update', async () => {
    const { dir, cleanup } = await tempDir()
    try {
      const storeA = new ContextEpochStore(dir)
      const engineA = makeEngine(storeA)
      const first = await engineA.prepare('s1', docEnv({ connected: true, documentInstanceId: 'A', documentName: 'A.nwd' }))
      await engineA.commit(first.epoch)
      // Process 2: brand-new store instance over the same directory.
      const storeB = new ContextEpochStore(dir)
      const engineB = makeEngine(storeB)
      const second = await engineB.prepare('s1', docEnv({ connected: true, documentInstanceId: 'A', documentName: 'A.nwd' }))
      expect(second.epochId).toBe(first.epochId)
      expect(second.baselineHash).toBe(first.baselineHash)
      expect(second.updatesAdded).toBe(0)
      expect(second.prefixHash).toBe(first.prefixHash)
    } finally {
      await cleanup()
    }
  })

  it('§69 corrupt epoch file → fail-open, no throw, session still usable', async () => {
    const { dir, cleanup } = await tempDir()
    try {
      const store = new ContextEpochStore(dir)
      // Write garbage to the exact file the store will read.
      const probe = new ContextEngine(contextRegistry, store)
      const fresh = await probe.prepare('s9', docEnv({ connected: false }))
      await probe.commit(fresh.epoch)
      const path = store.filePath('s9')
      await writeFile(path, '{ this is not valid json', 'utf8')
      const recovered = await probe.prepare('s9', docEnv({ connected: false }))
      // A brand-new epoch, not a crash.
      expect(recovered.status).toBe('rolled-over')
      expect(recovered.epoch.updates).toBeInstanceOf(Array)
      expect(recovered.generation).toBe(1)
    } finally {
      await cleanup()
    }
  })

  it('§70 session delete removes the epoch file', async () => {
    const { dir, cleanup } = await tempDir()
    try {
      const store = new ContextEpochStore(dir)
      const engine = makeEngine(store)
      const prepared = await engine.prepare('s1', docEnv({ connected: false }))
      await engine.commit(prepared.epoch)
      await engine.forgetSession('s1')
      const loaded = await store.load('s1')
      expect(loaded.epoch).toBeNull()
      expect(loaded.corrupt).toBe(false)
    } finally {
      await cleanup()
    }
  })
})

describe('Assembly order + prefix stability (Invariant I, §71/§72)', () => {
  it('§71 fixed order: seed, durable updates, volatile — never Map/Object order', async () => {
    const { dir, cleanup } = await tempDir()
    try {
      const store = new ContextEpochStore(dir)
      const engine = makeEngine(store)
      const prepared = await engine.prepare('s1', docEnv(
        { connected: true, documentInstanceId: 'A', documentName: 'A.nwd' },
        { semanticMemory: { goals: ['g'], constraints: [], decisions: [], notes: [], updatedAt: 1 }, compactSummary: 'S' },
      ))
      const kinds = prepared.blocks.map((b) => b.kind)
      const seedAt = kinds.indexOf('epoch-seed')
      const updateAt = kinds.indexOf('context-update')
      const memAt = kinds.indexOf('semantic-memory')
      expect(seedAt).toBeGreaterThanOrEqual(0)
      expect(updateAt).toBeGreaterThan(seedAt)
      expect(memAt).toBeGreaterThan(updateAt)
    } finally {
      await cleanup()
    }
  })

  it('§72 prefixHash stable when only message/memory/task change; changes on document switch', async () => {
    const { dir, cleanup } = await tempDir()
    try {
      const store = new ContextEpochStore(dir)
      const engine = makeEngine(store)
      const doc = { connected: true, documentInstanceId: 'A', documentName: 'A.nwd' }
      const turn1 = await engine.prepare('s1', docEnv(doc))
      await engine.commit(turn1.epoch)
      const turn2 = await engine.prepare('s1', docEnv(doc, {
        semanticMemory: { goals: ['新目标'], constraints: [], decisions: [], notes: [], updatedAt: 9 },
        activeTask: sampleTask('running'),
      }))
      expect(turn2.prefixHash).toBe(turn1.prefixHash)
      expect(turn2.baselineHash).toBe(turn1.baselineHash)
      const switched = await engine.prepare('s1', docEnv({ connected: true, documentInstanceId: 'B', documentName: 'B.nwd' }))
      expect(switched.prefixHash).not.toBe(turn1.prefixHash)
      expect(switched.baselineHash).toBe(turn1.baselineHash)
    } finally {
      await cleanup()
    }
  })
})

describe('contextHash helpers (§48)', () => {
  it('canonical fingerprint ignores object key order', () => {
    expect(canonicalFingerprint({ a: 1, b: 2 })).toBe(canonicalFingerprint({ b: 2, a: 1 }))
    expect(canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] })).toBe('{"a":[2,{"c":3,"d":4}],"b":1}')
  })

  it('prefix hash depends only on baseline+seed+updates', () => {
    const base = { baseline: 'B', seedText: null as string | null, updateTexts: ['u1'] }
    expect(computePrefixHash(base)).toBe(computePrefixHash({ ...base }))
    expect(computePrefixHash(base)).not.toBe(computePrefixHash({ ...base, updateTexts: ['u1', 'u2'] }))
  })

  it('document fingerprint is semantic: revision/name/changedAt changes do NOT alter it', () => {
    const a = documentSource.fingerprint({ connected: true, documentInstanceId: 'A', bridgeSessionId: 'b1' })
    const aRenamed = documentSource.fingerprint({ connected: true, documentInstanceId: 'A', bridgeSessionId: 'b1', documentName: '别的名字' })
    const b = documentSource.fingerprint({ connected: true, documentInstanceId: 'B', bridgeSessionId: 'b1' })
    expect(a).toBe(aRenamed)
    expect(a).not.toBe(b)
  })
})

describe('Legacy compactSummary adoption (§16/§36)', () => {
  it('a session that already has a compactSummary seeds the fresh epoch and is not duplicated as volatile', async () => {
    const { dir, cleanup } = await tempDir()
    try {
      const store = new ContextEpochStore(dir)
      const engine = makeEngine(store)
      const prepared = await engine.prepare('s1', docEnv(
        { connected: false },
        { compactSummary: '旧会话摘要' },
      ))
      await engine.commit(prepared.epoch)
      expect(prepared.seed?.text).toBe('旧会话摘要')
      const seedBlocks = prepared.blocks.filter((b) => b.kind === 'epoch-seed')
      expect(seedBlocks).toHaveLength(1)
      // No duplicate compact-summary volatile block for the same text.
      expect(prepared.blocks.filter((b) => b.kind === 'compact-summary')).toHaveLength(0)
    } finally {
      await cleanup()
    }
  })
})

function registryWithCoreVersion(version: number): ReturnType<typeof contextRegistry.list> {
  const sources = contextRegistry.list().map((source) => (
    source.key === 'core/identity' ? { ...source, version } : source
  ))
  return sources
}

import type { CuriTask } from '../agent/taskTypes'
function sampleTask(status: 'running' | 'paused'): CuriTask {
  return {
    id: 'task-1',
    sessionId: 'session-1',
    objective: '检查模型',
    status,
    steps: [],
    completionCriteria: ['完成检查'],
    evidence: [],
    planVersion: 1,
    replanCount: 0,
    currentStepId: undefined,
    createdAt: 0,
    updatedAt: 0,
  } as unknown as CuriTask
}

describe('ContextManager still owns HOW MUCH under the engine (§29/§73)', () => {
  it('counts epoch-seed + context-update blocks in the report buckets and still trims to budget', async () => {
    const { dir, cleanup } = await tempDir()
    try {
      const store = new ContextEpochStore(dir)
      const engine = makeEngine(store)
      const assembly = await engine.prepare('s1', docEnv(
        { connected: true, documentInstanceId: 'A', documentName: 'A.nwd' },
        { compactSummary: '既有摘要' },
      ))
      const manager = new ContextManager({
        systemPrompt: assembly.baseline,
        history: [],
        contextBlocks: [...assembly.blocks, {
          kind: 'recall',
          message: { role: 'system', content: 'x'.repeat(4_000) },
        }],
      })
      manager.addUserTurn({ role: 'user', content: '你好' })
      const built = manager.assembleBudgetedFrames({
        tools: [],
        temperature: 0.1,
        maxTokens: 2_048,
        effectiveWindow: 4_000,
        sendContextWindow: false,
      })
      // Engine durable blocks land in the existing token buckets…
      expect(built.report.workingStateTokens).toBeGreaterThan(0)
      expect(built.report.semanticMemoryTokens).toBeGreaterThan(0)
      // The only frame is the protected current user turn — ContextManager
      // never trims it, even when the oversized system blocks blow the budget.
      expect(built.report.framesIncluded).toBe(1)
      expect(built.report.framesDropped).toBe(0)
      expect(built.messages.at(-1)?.role).toBe('user')
    } finally {
      await cleanup()
    }
  })
})

describe('P15.5 reconciliation regressions', () => {
  it('every registered source appears AT MOST ONCE in report.sources', async () => {
    const { dir, cleanup } = await tempDir()
    try {
      const store = new ContextEpochStore(dir)
      const engine = makeEngine(store)
      const assembly = await engine.prepare('s1', docEnv(
        { connected: true, documentInstanceId: 'A', documentName: 'A.nwd' },
      ))
      const seen = new Map<string, number>()
      for (const entry of assembly.report.sources) {
        seen.set(entry.key, (seen.get(entry.key) ?? 0) + 1)
      }
      for (const [key, count] of seen) {
        expect(count, `source ${key} reconciled ${count}x`).toBe(1)
      }
      // Registry coverage: every durable + volatile source reported exactly once.
      const registered = contextRegistry.list()
        .filter((source) => source.mode !== 'baseline')
        .map((source) => source.key)
        .sort()
      expect([...seen.keys()].sort()).toEqual(registered)
    } finally {
      await cleanup()
    }
  })

  it('A→B switch: status=updated, updatesAdded=1, epochId unchanged', async () => {
    const { dir, cleanup } = await tempDir()
    try {
      const store = new ContextEpochStore(dir)
      const engine = makeEngine(store)
      const first = await engine.prepare('s1', docEnv(
        { connected: true, documentInstanceId: 'A', documentName: 'A.nwd' },
      ))
      await engine.commit(first.epoch)
      const second = await engine.prepare('s1', docEnv(
        { connected: true, documentInstanceId: 'B', documentName: 'B.nwd' },
      ))
      expect(second.status).toBe('updated')
      expect(second.updatesAdded).toBe(1)
      expect(second.epochId).toBe(first.epochId)
      expect(second.generation).toBe(first.generation)
    } finally {
      await cleanup()
    }
  })

  it('rendered durable update carries EXACTLY ONE 【Context Update heading', async () => {
    const { dir, cleanup } = await tempDir()
    try {
      const store = new ContextEpochStore(dir)
      const engine = makeEngine(store)
      const first = await engine.prepare('s1', docEnv(
        { connected: true, documentInstanceId: 'A', documentName: 'A.nwd' },
      ))
      await engine.commit(first.epoch)
      const second = await engine.prepare('s1', docEnv(
        { connected: true, documentInstanceId: 'B', documentName: 'B.nwd' },
      ))
      const added = second.epoch.updates[second.epoch.updates.length - 1]
      expect(added).toBeDefined()
      const headings = (added!.rendered.match(/Context Update/g) ?? [])
      expect(headings).toHaveLength(1)
      expect(added!.rendered.startsWith('【Context Update · navisworks/document】')).toBe(true)
    } finally {
      await cleanup()
    }
  })
})
