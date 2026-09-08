import { describe, expect, it, vi } from 'vitest'
import { AgentRuntime } from '../agentRuntime'
import { CapabilityRegistry } from '../capability/capabilityRegistry'
import { createContextRegistry } from '../context/contextRegistry'
import { ContextEngine } from '../context/contextEngine'
import { createToolRegistry } from '../tool/registry'
import type {
  CapabilityManifest,
  CapabilityPreparedRun,
  CapabilityProvider,
  CapabilityToolExecutionInput,
} from '../capability/types'
import type { AgentToolDefinition } from '../tool/registry'
import type { ContextSource } from '../context/types'

function ndjson(lines: unknown[]): Response {
  const text = lines.map((line) => `${JSON.stringify(line)}\n`).join('')
  return new Response(text, { status: 200, headers: { 'content-type': 'application/x-ndjson' } })
}

/** TEST-ONLY fake capability (§72): proves the routing is registration-based. */
function fakeCapability(calls: string[]): CapabilityProvider {
  const definition: AgentToolDefinition = {
    name: 'fake_echo',
    label: '回声',
    description: '原样返回输入的文本。',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    category: 'internal',
    origin: { kind: 'capability', capabilityId: 'fake' },
    impact: 'read-only',
    defaultPermission: 'allow',
    contract: {
      type: 'function',
      function: {
        name: 'fake_echo',
        description: '原样返回输入的文本。',
        parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      },
      impact: 'read-only',
    },
  }
  const fakeTextSource: ContextSource<unknown> = {
    key: 'fake/policy',
    version: 1,
    mode: 'baseline',
    load: () => '【Fake Capability】fake capability active',
    fingerprint: (value) => String(value),
    render: (value) => String(value),
  }
  return {
    manifest: {
      id: 'fake', name: 'Fake', description: 'test capability', version: 1, firstParty: false,
    } satisfies CapabilityManifest,
    tools: () => [definition],
    contextSources: () => [fakeTextSource],
    ownsTool: (name) => name === 'fake_echo',
    normalizeArguments: (_name, args) => args,
    prepareRun: async (): Promise<CapabilityPreparedRun> => ({ capabilityId: 'fake', state: { ready: true } }),
    async executeTool(input: CapabilityToolExecutionInput) {
      calls.push(input.toolName)
      return { result: { echo: String((input.arguments as { text?: string }).text ?? '') } }
    },
  }
}

describe('core-only runtime: Curi works with NO capabilities (§36/§74/§105)', () => {
  it('a plain conversation completes without bridgeClient, contextState or capabilities', async () => {
    const bodies: string[] = []
    const fetchSpy = vi.fn(async (_url: string | URL | Request, init?: { body?: string }) => {
      bodies.push(String(init?.body ?? ''))
      return ndjson([
        { message: { role: 'assistant', content: '机会成本是为了得到 X 而放弃的 Y 的最大价值。' }, prompt_eval_count: 7, eval_count: 12 },
      ])
    })
    const fetchImpl = fetchSpy as unknown as typeof fetch
    const runtime = new AgentRuntime({ fetchImpl })

    const result = await runtime.run({ sessionId: 's1', text: '机会成本是什么意思？' })
    expect(result.isSuccess).toBe(true)
    expect(result.message).toContain('机会成本')
    // The model is offered ONLY the internal tools — no navisworks anywhere.
    const firstBody = JSON.parse(bodies[0] ?? '{}') as { tools?: Array<{ function: { name: string } }> }
    const offered = (firstBody.tools ?? []).map((tool) => tool.function.name)
    expect(offered).not.toContain('navisworks_status')
    expect(offered).not.toContain('fake_echo')
  })

  it('the core-only context baseline contains no Navisworks policy/document anywhere (§37/§78)', async () => {
    const engine = new ContextEngine(createContextRegistry(), undefined)
    const { NAVISWORKS_CAPABILITY_PROMPT } = await import('../agent/prompts')
    const assembly = await engine.prepare('s1', { sessionId: 's1' })
    // The core prompt may MENTION Navisworks generally; what must be absent
    // is the capability's specialized policy text (§78).
    expect(assembly.baseline).not.toContain(NAVISWORKS_CAPABILITY_PROMPT.slice(0, 40))
    expect(assembly.blocks.filter((block) => block.kind === 'context-update')).toHaveLength(0)
  })

  it('registering a capability brings its tools, prefix text and routing — nothing hardcoded', async () => {
    const calls: string[] = []
    const capabilities = new CapabilityRegistry([fakeCapability(calls)])
    let replyIndex = 0
    const replies = [
      ndjson([
        { message: { role: 'assistant', content: '', tool_calls: [{ id: 'fc1', function: { index: 0, name: 'fake_echo', arguments: { text: 'hello' } } }] }, done: true },
      ]),
      ndjson([{ message: { role: 'assistant', content: '回声完成。' }, done: true }]),
    ]
    const bodies: string[] = []
    const fetchSpy = vi.fn(async (_url: string | URL | Request, init?: { body?: string }) => {
      bodies.push(String(init?.body ?? ''))
      return replies[Math.min(replyIndex++, replies.length - 1)]
    })
    const fetchImpl = fetchSpy as unknown as typeof fetch
    const engine = new ContextEngine(createContextRegistry(capabilities), undefined)
    const runtime = new AgentRuntime({
      capabilities,
      fetchImpl,
      contextEngine: engine,
      internalToolExecutor: undefined,
    })

    const result = await runtime.run({ sessionId: 's1', text: '说 hello' })
    expect(result.isSuccess).toBe(true)
    // §75: routed by registration to the FAKE provider — no Navisworks exists.
    expect(calls).toEqual(['fake_echo'])
    // §78/§79: capability baseline text entered the prefix, ordered after core.
    expect(result.isSuccess).toBe(true)
    expect(result.message).toContain('回声完成')
    const firstBody = JSON.parse(bodies[0] ?? '{}') as {
      messages: Array<{ role: string; content: string }>
      tools: Array<{ function: { name: string } }>
    }
    const systemText = firstBody.messages.filter((message) => message.role === 'system').map((m) => m.content).join('\n')
    expect(systemText).toContain('Fake Capability')
    expect(systemText.indexOf('Fake Capability')).toBeGreaterThan(0)
    const offered = firstBody.tools.map((tool) => tool.function.name)
    expect(offered).toContain('fake_echo')
    expect(offered).not.toContain('navisworks_status')
    // The fake tool result reached the model as the uniform observation.
    const secondBody = JSON.parse(bodies[1] ?? '{}') as { messages: Array<{ role: string; content: string }> }
    const toolMessage = secondBody.messages.find((message) => message.role === 'tool')
    expect(toolMessage?.content).toContain('echo')
    expect(toolMessage?.content).toContain('hello')
  })
})

describe('ToolRegistry composition keeps capabilities visible to the model', () => {
  it('fake_echo is materialized and shown to the UI list with capability identity (§29)', () => {
    const capabilities = new CapabilityRegistry([fakeCapability([])])
    const registry = createToolRegistry({ capabilities })
    const names = registry.materialize().map((contract) => contract.function.name)
    expect(names).toContain('fake_echo')
    const ui = registry.listUiTools()
    const fakeEntry = ui.find((summary) => summary.name === 'fake_echo')
    expect(fakeEntry?.capabilityId).toBe('fake')
    expect(fakeEntry?.capabilityName).toBe('Fake')
  })
})
