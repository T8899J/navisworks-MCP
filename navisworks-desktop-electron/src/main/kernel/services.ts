import { createRootScope, type Scope } from './kernel'

/** Production root scope backed by the installed Cordis package. */
export async function makeRootScope(): Promise<Scope> {
  return createRootScope()
}

export { token, type ServiceToken, type Scope, type ScopeKind } from './kernel'
