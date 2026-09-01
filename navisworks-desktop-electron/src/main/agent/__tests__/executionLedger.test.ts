import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DocumentOperationCoordinator,
  ExecutionLedgerRepository,
  ToolExecutionLedger,
  hashArguments,
} from '../executionLedger'

describe('ToolExecutionLedger — lifecycle + crash recovery', () => {
  it('tracks a modifying call from requested to success', async () => {
    const ledger = new ToolExecutionLedger()
    await ledger.begin({
      runId: 'r1', toolCallId: 'c1', toolName: 'navisworks_set_visibility',
      argumentsHash: hashArguments({ action: 'hide' }), documentInstanceId: 'doc-A',
    })
    expect(ledger.get('r1', 'c1')?.status).toBe('requested')
    await ledger.mark('r1', 'c1', 'awaiting-approval')
    await ledger.mark('r1', 'c1', 'approved')
    await ledger.mark('r1', 'c1', 'executing')
    await ledger.mark('r1', 'c1', 'success')
    expect(ledger.get('r1', 'c1')?.status).toBe('success')
    expect(ledger.get('r1', 'c1')?.finishedAt).toBeTypeOf('number')
  })

  it('recovers an interrupted executing record as ambiguous (never auto-retried)', () => {
    const ledger = new ToolExecutionLedger()
    const recovered = ledger.recoverFrom([
      {
        runId: 'r1', toolCallId: 'stuck', toolName: 'navisworks_select_items',
        argumentsHash: 'h', documentInstanceId: 'doc-A', status: 'executing',
      },
    ])
    expect(recovered[0]?.status).toBe('ambiguous')
    expect(ledger.ambiguous().map((record) => record.toolCallId)).toEqual(['stuck'])
  })

  it('records and finds an ambiguous bridge outcome by document/tool/arguments', async () => {
    const ledger = new ToolExecutionLedger()
    await ledger.begin({
      runId: 'r1', toolCallId: 'c2', toolName: 'navisworks_set_visibility',
      argumentsHash: 'h', documentInstanceId: 'doc-A',
    })
    await ledger.mark('r1', 'c2', 'awaiting-approval')
    await ledger.mark('r1', 'c2', 'approved')
    await ledger.mark('r1', 'c2', 'executing')
    await ledger.mark('r1', 'c2', 'ambiguous')
    expect(ledger.ambiguous().length).toBe(1)
    expect(ledger.findAmbiguous({
      documentInstanceId: 'doc-A', toolName: 'navisworks_set_visibility', argumentsHash: 'h',
    })?.toolCallId).toBe('c2')
  })

  it('persists transitions and restores an interrupted execution as ambiguous', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'navisworks-ledger-'))
    try {
      const file = join(directory, 'ledger.json')
      const repository = new ExecutionLedgerRepository(file)
      const ledger = new ToolExecutionLedger(repository)
      await ledger.initialize()
      await ledger.begin({
        runId: 'persisted-run', toolCallId: 'persisted-call', toolName: 'navisworks_set_visibility',
        argumentsHash: 'hash', documentInstanceId: 'doc-A',
      })
      await ledger.mark('persisted-run', 'persisted-call', 'awaiting-approval')
      await ledger.mark('persisted-run', 'persisted-call', 'approved')
      await ledger.mark('persisted-run', 'persisted-call', 'executing')

      const restored = new ToolExecutionLedger(repository)
      await restored.initialize()
      expect(restored.get('persisted-run', 'persisted-call')).toMatchObject({
        status: 'ambiguous', errorCode: 'PROCESS_INTERRUPTED',
      })
      expect(JSON.parse(await readFile(file, 'utf8'))[0].status).toBe('ambiguous')

      // A corrupt primary falls back to the last valid backup.
      await writeFile(file, '{broken', 'utf8')
      expect(await repository.load()).toHaveLength(1)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('DocumentOperationCoordinator — serial per document, concurrent across', () => {
  it('runs same-document tasks one at a time', async () => {
    const coordinator = new DocumentOperationCoordinator()
    const log: string[] = []
    const hold = (label: string) => coordinator.runExclusive('doc-A', async () => {
      log.push(`${label}:start`)
      await new Promise((resolve) => setTimeout(resolve, 20))
      log.push(`${label}:end`)
    })
    await Promise.all([hold('a'), hold('b')])
    // Strictly nested: a finishes before b starts.
    expect(log).toEqual(['a:start', 'a:end', 'b:start', 'b:end'])
  })

  it('releases the document key once all tasks finish (no tail leak)', async () => {
    const coordinator = new DocumentOperationCoordinator()
    expect(coordinator.hasPending('doc-A')).toBe(false)
    await coordinator.runExclusive('doc-A', async () => {})
    expect(coordinator.hasPending('doc-A')).toBe(false)
    await Promise.all([
      coordinator.runExclusive('doc-A', async () => new Promise((r) => setTimeout(r, 10))),
      coordinator.runExclusive('doc-A', async () => {}),
    ])
    // After the queue drains, the key must be gone (the old bug kept it forever).
    expect(coordinator.hasPending('doc-A')).toBe(false)
  })

  it('does not serialize different document instances', async () => {
    const coordinator = new DocumentOperationCoordinator()
    const started: string[] = []
    const task = (doc: string, id: string) => coordinator.runExclusive(doc, async () => {
      started.push(id)
      await new Promise((resolve) => setTimeout(resolve, 15))
    })
    await Promise.all([task('doc-A', 'A1'), task('doc-B', 'B1')])
    // Both start before either ends → not serialized against each other.
    expect(started).toEqual(['A1', 'B1'])
  })
})

describe('hashArguments — order-insensitive, value-sensitive', () => {
  it('is stable across key order', () => {
    expect(hashArguments({ a: 1, b: 2 })).toBe(hashArguments({ b: 2, a: 1 }))
  })
  it('differs when a value differs', () => {
    expect(hashArguments({ action: 'hide' })).not.toBe(hashArguments({ action: 'show' }))
  })
})
