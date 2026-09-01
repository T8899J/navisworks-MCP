import { describe, expect, it } from 'vitest'
import { DocumentScopeRegistry, type DocumentIdentity } from '../documentScope'

const id = (documentInstanceId: string, bridgeSessionId = 'bridge-1'): DocumentIdentity =>
  ({ documentInstanceId, bridgeSessionId })

describe('DocumentScopeRegistry — identity + invalidation (Invariants A/B)', () => {
  it('fires listeners with the PREVIOUS identity when the document instance changes', () => {
    const registry = new DocumentScopeRegistry()
    const invalidated: DocumentIdentity[] = []
    registry.onInvalidate((previous) => invalidated.push(previous))

    registry.observe(id('doc-A'))
    expect(registry.documentInstanceId).toBe('doc-A')
    registry.observe(id('doc-B'))
    expect(invalidated).toHaveLength(1)
    expect(invalidated[0]?.documentInstanceId).toBe('doc-A')
    expect(registry.documentInstanceId).toBe('doc-B')
  })

  it('is a no-op when the same identity is observed again', () => {
    const registry = new DocumentScopeRegistry()
    let fired = 0
    registry.onInvalidate(() => { fired += 1 })
    registry.observe(id('doc-A'))
    registry.observe(id('doc-A'))
    // A repeated identical observation must not invalidate the still-current document.
    expect(fired).toBe(0)
    expect(registry.documentInstanceId).toBe('doc-A')
  })

  it('invalidates when the document closes (identity → null)', () => {
    const registry = new DocumentScopeRegistry()
    let firedWith: DocumentIdentity | undefined
    registry.onInvalidate((previous) => { firedWith = previous })
    registry.observe(id('doc-A'))
    registry.observe(null)
    expect(firedWith?.documentInstanceId).toBe('doc-A')
    expect(registry.documentInstanceId).toBeNull()
  })

  it('treats a bridge-session change as a new document even with the same instance id', () => {
    const registry = new DocumentScopeRegistry()
    let fired = false
    registry.onInvalidate(() => { fired = true })
    registry.observe(id('doc-A', 'bridge-1'))
    registry.observe(id('doc-A', 'bridge-2'))
    expect(fired).toBe(true)
  })

  it('rejects a stale document reference but accepts the current one (Invariant B)', () => {
    const registry = new DocumentScopeRegistry()
    registry.observe(id('doc-A'))
    expect(registry.canUseDocumentReference('doc-A')).toBe(true)
    expect(registry.canUseDocumentReference('doc-OLD')).toBe(false)
    expect(registry.canUseDocumentReference(undefined)).toBe(false)
    // After switching to doc-B, A's references are no longer usable for modifying calls.
    registry.observe(id('doc-B'))
    expect(registry.canUseDocumentReference('doc-A')).toBe(false)
    expect(registry.canUseDocumentReference('doc-B')).toBe(true)
  })
})
