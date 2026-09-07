import { estimateTokens } from '../agent/tokenBudget'
import type { ContextBlock, ContextBlockKind } from '../agent/contextManager'
import type { ContextEpochStore } from './contextEpochStore'
import type { ContextRegistry } from './contextRegistry'
import { computePrefixHash, sha256Hex } from './contextHash'
import type {
  ContextAssembly,
  ContextDurableUpdate,
  ContextEngineReport,
  ContextEpoch,
  ContextSource,
  ContextSourceEnvironment,
  ContextSourceReconciliation,
} from './types'

/**
 * Context Engine v1: decides WHAT enters the model context and keeps the
 * prefix stable. It never trims by tokens — ContextManager owns HOW MUCH
 * (Invariant H, §31: no while-loops over token counts live here).
 *
 * Reconciliation flow (§23): load-or-init epoch → baseline (+rollover when
 * changed) → durable sources fingerprint-compared against snapshots, changes
 * APPENDED as durable updates → volatile sources rendered fresh → assembly.
 * An epoch is only persisted after the run succeeds (§40): prepare() is
 * state-pure w.r.t. disk, commit() is the settlement gate's job.
 */
export class ContextEngine {
  constructor(
    private readonly registry: ContextRegistry,
    private readonly store: ContextEpochStore | undefined,
  ) {}

  async prepare(
    sessionId: string,
    env: ContextSourceEnvironment,
  ): Promise<ContextAssembly> {
    const baselineSources = this.registry.listByMode('baseline')
    const baseline = await this.buildBaseline(baselineSources)
    const baselineVersions: Record<string, number> = {}
    for (const source of baselineSources) baselineVersions[source.key] = source.version

    let epoch: ContextEpoch
    let status: ContextAssembly['status'] = 'unchanged'
    const persisted = this.store ? await this.store.load(sessionId) : { epoch: null, corrupt: false }
    // A legacy session's durable compactSummary becomes the fresh epoch's
    // SEED (§16/§36): never lost, fixed at the prefix head instead of a
    // volatile block drifting position every turn.
    const seedFromEnvironment = env.compactSummary
      ? ({ kind: 'compact-summary', text: env.compactSummary } as const)
      : undefined
    if (persisted.epoch === null) {
      if (persisted.corrupt) {
        console.debug(`[context] EPOCH_CORRUPT session=${sessionId} — fail-open to a fresh epoch`)
      }
      epoch = this.newEpoch(sessionId, baseline, baselineVersions, undefined, seedFromEnvironment)
      status = 'rolled-over'
    } else if (persisted.epoch.baseline !== baseline.text
      || persisted.epoch.baselineHash !== baseline.hash
      || !sameBaselineVersions(persisted.epoch.baselineVersions, baselineVersions)) {
      // A baseline source TEXT or VERSION changed (e.g. a prompt release or a
      // source-semantics bump): rollover with reason=baseline-changed — never
      // rewrite the old epoch's baseline in place (§17/§67).
      console.debug(`[context] ROLLOVER session=${sessionId} reason=baseline-changed`)
      epoch = this.newEpoch(sessionId, baseline, baselineVersions, persisted.epoch, seedFromEnvironment)
      status = 'rolled-over'
    } else {
      epoch = persisted.epoch
      // A manual /compact committed a summary onto the session between runs;
      // the first engine pass adopts it as the epoch seed (fixed head).
      if (epoch.seed === undefined && seedFromEnvironment !== undefined) {
        epoch = { ...epoch, seed: seedFromEnvironment }
      }
    }

    const reconciliations: ContextSourceReconciliation[] = []
    const updatesAdded: ContextDurableUpdate[] = []
    // The working epoch is mutated in memory only; disk commit follows a
    // successful run (§40), so a failed/aborted run cannot corrupt history.
    const next: ContextEpoch = {
      ...epoch,
      snapshot: { ...epoch.snapshot },
      updates: [...epoch.updates],
    }

    // ---- durable sources ----
    for (const source of this.registry.listByMode('durable')) {
      const key = source.key
      try {
        const value = await source.load(env)
        if (value === undefined) {
          reconciliations.push(this.record(reconciliations, key, 'durable', 'skipped-empty'))
          continue
        }
        const fingerprint = source.fingerprint(value)
        const previousSnapshot = next.snapshot[key]
        if (previousSnapshot !== undefined && previousSnapshot.fingerprint === fingerprint) {
          reconciliations.push(this.record(reconciliations, key, 'durable', 'unchanged', fingerprint))
          continue
        }
        const text = source.render(value, previousSnapshot?.value)
        if (!text) {
          reconciliations.push(this.record(reconciliations, key, 'durable', 'skipped-empty'))
          continue
        }
        if (previousSnapshot !== undefined) {
          const update = this.appendUpdate(next, source, fingerprint, text)
          updatesAdded.push(update)
          reconciliations.push(this.record(reconciliations, key, 'durable', 'updated', fingerprint))
        } else {
          const update = this.appendUpdate(next, source, fingerprint, text)
          updatesAdded.push(update)
          reconciliations.push(this.record(reconciliations, key, 'durable', 'created', fingerprint))
        }
        next.snapshot[key] = {
          key,
          sourceVersion: source.version,
          fingerprint,
          value,
        }
      } catch (error) {
        // A durable source whose identity cannot be read is an error we must
        // not paper over with stale data — skip the block, log, and let the
        // run continue (the model will re-read live state via tools).
        reconciliations.push(this.record(
          reconciliations, key, 'durable', 'error', undefined, errorMessageOf(error),
        ))
      }
    }

    // ---- volatile sources ----
    const volatileBlocks: ContextBlock[] = []
    for (const source of this.registry.listByMode('volatile')) {
      const key = source.key
      try {
        const value = await source.load(env)
        if (value === undefined) {
          reconciliations.push(this.record(reconciliations, key, 'volatile', 'skipped-empty'))
          continue
        }
        const fingerprint = source.fingerprint(value)
        const text = source.render(value)
        if (!text) {
          reconciliations.push(this.record(reconciliations, key, 'volatile', 'skipped-empty'))
          continue
        }
        // The compact summary already lives in the prefix as the epoch SEED
        // (§36): rendering it again as a volatile block would duplicate it.
        if (key === 'session/compact-summary'
          && next.seed !== undefined
          && typeof value === 'string'
          && value === next.seed.text) {
          reconciliations.push(this.record(reconciliations, key, 'volatile', 'unchanged', fingerprint))
          continue
        }
        volatileBlocks.push({ kind: blockKindFor(key), message: { role: 'system', content: text } })
        reconciliations.push(this.record(reconciliations, key, 'volatile', 'updated', fingerprint))
      } catch (error) {
        reconciliations.push(this.record(
          reconciliations, key, 'volatile', 'error', undefined, errorMessageOf(error),
        ))
      }
    }

    // ---- assembly ----
    const blocks: ContextBlock[] = []
    const seedText = next.seed?.text?.trim() ?? ''
    if (seedText) {
      blocks.push({
        kind: 'epoch-seed',
        message: {
          role: 'system',
          content: `早期对话摘要（供参考，非实时事实）：\n${seedText}`,
        },
      })
    }
    for (const update of next.updates) {
      blocks.push({
        kind: 'context-update',
        message: { role: 'system', content: update.rendered },
      })
    }
    blocks.push(...volatileBlocks)

    const prefixHash = computePrefixHash({
      baseline: next.baseline,
      seedText: next.seed?.text ?? null,
      updateTexts: next.updates.map((update) => update.rendered),
    })
    next.updatedAt = Date.now()
    const report = this.buildReport(next, prefixHash, status, updatesAdded.length, reconciliations, blocks, volatileBlocks)
    // Dev diagnostics (§46) — metadata only: no prompts, no bodies, no keys.
    console.debug(
      `[context] PREPARE session=${sessionId} epoch=${next.epochId} generation=${next.generation}`
      + ` baseline=${status === 'rolled-over' ? 'changed' : 'same'} updates=${updatesAdded.length}`,
    )
    console.debug(`[context] PREFIX hash=${prefixHash.slice(0, 12)}… epochSeed=${report.epochSeedTokens} durable=${report.durableUpdateTokens}`)
    return {
      sessionId,
      baseline: next.baseline,
      baselineHash: next.baselineHash,
      prefixHash,
      epochId: next.epochId,
      generation: next.generation,
      updatesAdded: updatesAdded.length,
      status,
      seed: next.seed,
      blocks,
      epoch: next,
      report,
    }
  }

  /**
   * Persist the working epoch. Called ONLY after a run's successful
   * settlement (§40): failures and aborts keep the old durable epoch, and
   * the next prepare() re-reconciles from it unchanged.
   */
  async commit(epoch: ContextEpoch): Promise<boolean> {
    if (this.store === undefined) return false
    return this.store.save(epoch)
  }

  /**
   * Compaction committed: rollover with reason=compaction, seed = summary.
   * The NEW epoch's prefix is baseline + seed (+ fresh durable snapshots), so
   * the compact summary is FIXED at the head of the prefix (§36), not a block
   * that drifts position every turn.
   */
  async rollOverForCompaction(
    sessionId: string,
    summary: string,
    previous?: ContextEpoch,
  ): Promise<ContextEpoch> {
    const prior = previous ?? (this.store ? (await this.store.load(sessionId)).epoch : null) ?? undefined
    const baselineSources = this.registry.listByMode('baseline')
    const baseline = await this.buildBaseline(baselineSources)
    const baselineVersions: Record<string, number> = {}
    for (const source of baselineSources) baselineVersions[source.key] = source.version
    console.debug(`[context] ROLLOVER session=${sessionId} reason=compaction`)
    const seedText = summary.trim()
    const epoch = this.newEpoch(sessionId, baseline, baselineVersions, prior, seedText
      ? { kind: 'compact-summary', text: seedText }
      : undefined)
    await this.commit(epoch)
    return epoch
  }

  async forgetSession(sessionId: string): Promise<void> {
    await this.store?.forget(sessionId)
  }

  private newEpoch(
    sessionId: string,
    baseline: { text: string; hash: string },
    baselineVersions: Record<string, number>,
    previous?: ContextEpoch,
    seed?: ContextEpoch['seed'],
  ): ContextEpoch {
    if (this.store === undefined) {
      // In-memory fallback (unit tests / store-less runtime): synthesize the
      // same shape without persistence.
      const now = Date.now()
      const effectiveSeed = seed ?? previous?.seed
      return {
        version: 1,
        sessionId,
        epochId: `memory-${randomId()}`,
        generation: (previous?.generation ?? 0) + 1,
        baseline: baseline.text,
        baselineHash: baseline.hash,
        baselineVersions,
        ...(effectiveSeed === undefined ? {} : { seed: effectiveSeed }),
        snapshot: {},
        updates: [],
        createdAt: now,
        updatedAt: now,
      }
    }
    return this.store.initialize({
      sessionId,
      baseline: baseline.text,
      baselineHash: baseline.hash,
      baselineVersions,
      ...(seed === undefined ? {} : { seed }),
      ...(previous === undefined ? {} : { previous }),
    })
  }

  private async buildBaseline(
    sources: readonly ContextSource<unknown>[],
  ): Promise<{ text: string; hash: string }> {
    const parts: string[] = []
    for (const source of sources) {
      const value = await source.load({})
      if (value === undefined) continue
      parts.push(source.render(value))
    }
    const text = parts.join('\n\n')
    return { text, hash: sha256Hex(text) }
  }

  private appendUpdate(
    epoch: ContextEpoch,
    source: ContextSource<unknown>,
    fingerprint: string,
    text: string,
  ): ContextDurableUpdate {
    const sequence = epoch.updates.reduce((max, update) => Math.max(max, update.sequence), 0) + 1
    const update: ContextDurableUpdate = {
      sequence,
      sourceKey: source.key,
      sourceVersion: source.version,
      fingerprint,
      text,
      rendered: `【Context Update · ${source.key}】\n${text}`,
      createdAt: Date.now(),
    }
    epoch.updates.push(update)
    return update
  }

  private record(
    list: ContextSourceReconciliation[],
    key: string,
    mode: ContextSourceReconciliation['mode'],
    status: ContextSourceReconciliation['status'],
    fingerprint?: string,
    error?: string,
  ): ContextSourceReconciliation {
    const entry: ContextSourceReconciliation = {
      key,
      mode,
      status,
      ...(fingerprint === undefined ? {} : { fingerprint }),
      ...(error === undefined ? {} : { error }),
    }
    list.push(entry)
    return entry
  }

  private buildReport(
    epoch: ContextEpoch,
    prefixHash: string,
    status: ContextAssembly['status'],
    updatesAdded: number,
    sources: readonly ContextSourceReconciliation[],
    blocks: readonly ContextBlock[],
    volatileBlocks: readonly ContextBlock[],
  ): ContextEngineReport {
    const tokensOf = (kindList: readonly ContextBlockKind[]) => blocks.reduce(
      (sum, block) => sum + (kindList.includes(block.kind) ? estimateTokens(block.message.content) : 0),
      0,
    )
    return {
      epochId: epoch.epochId,
      generation: epoch.generation,
      baselineHash: epoch.baselineHash,
      prefixHash,
      status,
      updatesAdded,
      sources,
      baselineTokens: estimateTokens(epoch.baseline),
      epochSeedTokens: tokensOf(['epoch-seed']),
      durableUpdateTokens: tokensOf(['context-update']),
      volatileTokens: volatileBlocks.reduce(
        (sum, block) => sum + estimateTokens(block.message.content),
        0,
      ),
    }
  }
}

/** Fixed source-key → ContextManager block-kind map. Unknown keys never silently join 'other'. */
const VOLATILE_KINDS: Record<string, ContextBlockKind> = {
  'session/compact-summary': 'compact-summary',
  'task/state': 'task-state',
  'session/semantic-memory': 'semantic-memory',
  'document/verified-facts': 'verified-facts',
  'document/reference-set': 'reference-set',
  'session/recall': 'recall',
}

function blockKindFor(key: string): ContextBlockKind {
  const kind = VOLATILE_KINDS[key]
  if (kind === undefined) {
    throw new Error(`未注册的 volatile Context Source key: ${key}`)
  }
  return kind
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10)
}

/** Every baseline key has the same recorded version (order-insensitive). */
function sameBaselineVersions(
  recorded: Record<string, number>,
  current: Record<string, number>,
): boolean {
  const recordedKeys = Object.keys(recorded).sort()
  const currentKeys = Object.keys(current).sort()
  if (recordedKeys.length !== currentKeys.length) return false
  for (let index = 0; index < recordedKeys.length; index += 1) {
    const key = recordedKeys[index]
    if (key === undefined || current[key] !== recorded[key]) return false
  }
  return true
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
