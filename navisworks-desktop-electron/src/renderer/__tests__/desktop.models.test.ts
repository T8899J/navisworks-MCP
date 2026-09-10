import { afterEach, describe, expect, it, vi } from 'vitest'
import { desktopGateway } from '../desktop'

afterEach(() => vi.unstubAllGlobals())

describe('desktop API model configuration transport', () => {
  it('sends enabled and models and preserves them in normalized settings', async () => {
    const input = { id: 'a', name: 'API', baseUrl: 'https://example.com/v1', model: 'm1', models: ['m1', 'm2'], enabled: false }
    const request = vi.fn(async () => ({ apiProfiles: [{ ...input, hasApiKey: true }] }))
    vi.stubGlobal('window', { desktop: { request } })
    const saved = await desktopGateway.saveApiProfile(input)
    expect(request).toHaveBeenCalledWith('api.profile.save', input)
    expect(saved.apiProfiles[0]).toMatchObject({ models: ['m1', 'm2'], enabled: false })
  })

  it('fetches from the requested profile without rewriting its draft settings', async () => {
    const request = vi.fn(async () => ['m1', 'm2'])
    vi.stubGlobal('window', { desktop: { request } })
    expect(await desktopGateway.listApiProfileModels('b')).toEqual(['m1', 'm2'])
    expect(request).toHaveBeenCalledExactlyOnceWith('api.profile.models.list', { profileId: 'b' })
  })

  it('propagates model-fetch errors so the dialog can display them', async () => {
    vi.stubGlobal('window', { desktop: { request: vi.fn(async () => { throw new Error('401 Unauthorized') }) } })
    await expect(desktopGateway.listApiProfileModels('a')).rejects.toThrow('401 Unauthorized')
  })
})
