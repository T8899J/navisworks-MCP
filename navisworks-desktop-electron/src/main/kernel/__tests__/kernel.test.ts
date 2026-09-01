import { describe, expect, it, vi } from 'vitest'
import { createRootScope, token } from '../kernel'
import { installAgentServices } from '../agentServices'
import { ContextStateToken } from '../agentServices'
import { ContextState } from '../../agent/contextState'
import { AgentScopeManager, ConversationScopeToken, DocumentScopeToken } from '../agentScopes'

const NumberToken = token<number>('test.number')

describe('kernel — scoped service registry + lifecycle', () => {
  it('resolves from the scope chain (child → parent)', async () => {
    const root = await createRootScope()
    root.register(NumberToken, 42)
    const child = await root.createChild('conversation', 'c1')
    expect(child.resolve(NumberToken)).toBe(42)
    expect(child.require(NumberToken)).toBe(42)
    child.register(NumberToken, 7)
    expect(child.resolve(NumberToken)).toBe(7)
    expect(root.resolve(NumberToken)).toBe(42)
  })

  it('require throws for a missing service', async () => {
    const root = await createRootScope()
    expect(() => root.require(NumberToken)).toThrow(/required service not found/)
  })

  it('disposes children before parent effects, effects in LIFO order', async () => {
    const order: string[] = []
    const root = await createRootScope()
    root.onDispose(() => { order.push('root-1') })
    root.onDispose(() => { order.push('root-2') })
    const child = await root.createChild('document', 'd1')
    child.onDispose(() => { order.push('child') })
    await root.dispose()
    expect(order).toEqual(['child', 'root-2', 'root-1'])
    expect(child.disposed).toBe(true)
    expect(root.disposed).toBe(true)
  })

  it('is idempotent on dispose and rejects registration after dispose', async () => {
    const root = await createRootScope()
    await root.dispose()
    await root.dispose()
    expect(() => root.register(NumberToken, 1)).toThrow(/already disposed/)
  })
})

describe('installAgentServices — App scope services + Document child lifecycle', () => {
  it('registers the three agent services on the App scope', async () => {
    const root = await createRootScope()
    const services = await installAgentServices(root)
    expect(root.require(ContextStateToken)).toBe(services.contextState)
    expect(services.contextState).toBeInstanceOf(ContextState)
  })

  it('a document child scope registers services and cascades disposal from the App scope', async () => {
    const root = await createRootScope()
    await installAgentServices(root)
    const docScope = await root.createChild('document', 'doc-A')
    const cleanup = vi.fn()
    const DocThing = token<string>('test.docThing')
    docScope.register(DocThing, 'pump-id').onDispose(cleanup)
    // Document scope sees App services; App does not see document services.
    expect(docScope.require(ContextStateToken)).toBeInstanceOf(ContextState)
    expect(root.resolve(DocThing)).toBeUndefined()
    await root.dispose()
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(docScope.disposed).toBe(true)
  })

  it('a failing dispose effect does not strand siblings', async () => {
    const root = await createRootScope()
    const survivor = vi.fn()
    root.onDispose(() => { throw new Error('boom') })
    root.onDispose(survivor)
    await root.dispose()
    expect(survivor).toHaveBeenCalled()
  })
})

describe('AgentScopeManager — Conversation and Document are orthogonal', () => {
  it('reuses either scope independently and only binds them in each Run', async () => {
    const root = await createRootScope()
    const manager = new AgentScopeManager(root)
    const first = await manager.createRun('r1', 'conversation-A', 'doc-A')
    const crossDocument = await manager.createRun('r2', 'conversation-A', 'doc-B')
    const sharedDocument = await manager.createRun('r3', 'conversation-B', 'doc-A')

    expect(crossDocument.require(ConversationScopeToken)).toBe(first.require(ConversationScopeToken))
    expect(crossDocument.require(DocumentScopeToken)).not.toBe(first.require(DocumentScopeToken))
    expect(sharedDocument.require(DocumentScopeToken)).toBe(first.require(DocumentScopeToken))
    expect(sharedDocument.require(ConversationScopeToken)).not.toBe(first.require(ConversationScopeToken))
    await root.dispose()
  })
})
