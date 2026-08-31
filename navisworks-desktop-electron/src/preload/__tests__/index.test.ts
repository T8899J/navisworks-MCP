import { beforeAll, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn(async () => ({ ok: true, data: { summary: '已压缩' } }))
const exposeInMainWorld = vi.fn()

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: {
    invoke,
    on: vi.fn(),
    removeListener: vi.fn()
  }
}))

describe('preload desktop API', () => {
  beforeAll(async () => {
    Object.defineProperty(process, 'contextIsolated', {
      configurable: true,
      value: true
    })
    await import('../index')
  })

  it('allows the renderer to invoke chat.compact', async () => {
    const desktop = exposeInMainWorld.mock.calls[0]?.[1] as {
      request(route: string, input: unknown): Promise<unknown>
    }

    await expect(desktop.request('chat.compact', { sessionId: 'session-1' }))
      .resolves.toEqual({ summary: '已压缩' })
    expect(invoke).toHaveBeenCalledWith(
      'navisworks:request',
      'chat.compact',
      { sessionId: 'session-1' }
    )
  })
})
