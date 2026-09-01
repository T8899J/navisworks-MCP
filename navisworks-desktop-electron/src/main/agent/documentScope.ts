/**
 * Document Scope identity + invalidation (docs/context-runtime.md §一 Document Scope,
 * Invariants A–B). The plugin mints a fresh `documentInstanceId` on every activation /
 * switch / close-and-reopen, and a stable `bridgeSessionId` per plugin load; the client
 * keys ALL document-bound state (verified facts, reference sets, pending approvals) on it
 * and discards that state the instant the identity changes.
 *
 * This registry is deliberately transport-agnostic: `observe()` is fed from the polled
 * `navisworks_status`, and the invalidation callbacks clear the fact / reference stores.
 */

export interface DocumentIdentity {
  instanceId?: string
  bridgeSessionId?: string
  documentInstanceId?: string
}

export type IdentityChangeListener = (previous: DocumentIdentity) => void

function sameIdentity(a: DocumentIdentity | null, b: DocumentIdentity | null): boolean {
  if (a === null || b === null) return a === b
  return (
    (a.instanceId ?? null) === (b.instanceId ?? null)
    && (a.documentInstanceId ?? null) === (b.documentInstanceId ?? null)
    && (a.bridgeSessionId ?? null) === (b.bridgeSessionId ?? null)
  )
}

export function documentScopeKey(identity: DocumentIdentity | null): string | undefined {
  if (identity?.documentInstanceId === undefined) return undefined
  return identity.instanceId === undefined
    ? identity.documentInstanceId
    : `${identity.instanceId}\u0000${identity.documentInstanceId}`
}

export class DocumentScopeRegistry {
  #current: DocumentIdentity | null = null
  readonly #listeners: Set<IdentityChangeListener> = new Set()

  get current(): DocumentIdentity | null {
    return this.#current
  }

  get documentInstanceId(): string | null {
    return this.#current?.documentInstanceId ?? null
  }

  /** Subscribe to identity changes; the listener receives the PREVIOUS identity. */
  onInvalidate(listener: IdentityChangeListener): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  /**
   * Record the latest observed identity. When it differs from the current one, every
   * listener is notified with the stale identity so it can drop document-bound state,
   * then the new identity takes over. A null identity (no document) also invalidates.
   */
  observe(next: DocumentIdentity | null): void {
    if (sameIdentity(this.#current, next)) return
    const previous = this.#current
    this.#current = next
    if (previous !== null
      && (previous.instanceId ?? previous.documentInstanceId ?? previous.bridgeSessionId)) {
      for (const listener of this.#listeners) {
        try {
          listener(previous)
        } catch {
          // A failing cleanup listener must not block the others or corrupt state.
        }
      }
    }
  }

  /**
   * Invariant B: a document-bound reference may only drive a modifying tool call while it
   * still names the current document instance. A missing id (never observed) is rejected.
   */
  canUseDocumentReference(
    referenceDocumentInstanceId: string | undefined | null,
    referenceInstanceId?: string,
  ): boolean {
    const currentId = this.#current?.documentInstanceId
    if (currentId === undefined || referenceDocumentInstanceId === undefined
      || referenceDocumentInstanceId === null) {
      return false
    }
    return referenceDocumentInstanceId === currentId
      && (referenceInstanceId === undefined || referenceInstanceId === this.#current?.instanceId)
  }
}
