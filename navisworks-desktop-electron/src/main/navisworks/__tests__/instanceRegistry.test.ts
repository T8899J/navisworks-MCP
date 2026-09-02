import { access, mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  decodeBridgeFrame,
  NavisworksBridgeClient,
  type BridgeTransport,
} from '../../bridgeClient'
import { NavisworksInstanceRegistry } from '../instanceRegistry'
import { NavisworksInstanceSelection } from '../instanceSelection'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })))
})

describe('NavisworksInstanceRegistry', () => {
  it('discovers two independent endpoints without the later instance overwriting the first', async () => {
    const fixture = await createFixture({
      'pipe-a': status('bridge-a', 'doc-a', 'Model-A.nwf'),
      'pipe-b': status('bridge-b', 'doc-b', 'Model-B.nwf'),
    })
    await fixture.writeEndpoint(12340, 'pipe-a')
    await fixture.writeEndpoint(18120, 'pipe-b')

    const instances = await fixture.registry.refresh()

    expect(instances).toHaveLength(2)
    expect(instances).toEqual(expect.arrayContaining([
      expect.objectContaining({ instanceId: 'bridge-a', processId: 12340, documentName: 'Model-A.nwf' }),
      expect.objectContaining({ instanceId: 'bridge-b', processId: 18120, documentName: 'Model-B.nwf' }),
    ]))
  })

  it('still discovers A after B closes and removes only its own endpoint', async () => {
    const fixture = await createFixture({
      'pipe-a': status('bridge-a', 'doc-a', 'Model-A.nwf'),
      'pipe-b': status('bridge-b', 'doc-b', 'Model-B.nwf'),
    })
    await fixture.writeEndpoint(12340, 'pipe-a')
    const endpointB = await fixture.writeEndpoint(18120, 'pipe-b')
    await fixture.registry.refresh()
    await unlink(endpointB)

    await expect(fixture.registry.refresh()).resolves.toEqual([
      expect.objectContaining({ instanceId: 'bridge-a', connected: true }),
    ])
  })

  it('keeps a temporarily unreachable instance and its last known document details', async () => {
    const fixture = await createFixture({
      'pipe-a': status('bridge-a', 'doc-a', 'Model-A.nwf'),
      'pipe-b': status('bridge-b', 'doc-b', 'Model-B.nwf'),
    })
    const endpointA = await fixture.writeEndpoint(12340, 'pipe-a')
    await fixture.writeEndpoint(18120, 'pipe-b')
    await fixture.registry.refresh()
    fixture.statuses['pipe-a'] = new Error('timeout')

    const instances = await fixture.registry.refresh()

    expect(instances).toEqual(expect.arrayContaining([
      expect.objectContaining({
        instanceId: 'bridge-a', connected: false, documentName: 'Model-A.nwf',
        documentInstanceId: 'doc-a', bridgeSessionId: 'bridge-a',
      }),
      expect.objectContaining({ instanceId: 'bridge-b', connected: true }),
    ]))
    await expect(access(endpointA)).resolves.toBeUndefined()
  })

  it('never deletes an endpoint after repeated communication failures', async () => {
    const fixture = await createFixture({
      'pipe-a': status('bridge-a', 'doc-a', 'Model-A.nwf'),
    })
    const endpointA = await fixture.writeEndpoint(12340, 'pipe-a')
    await fixture.registry.refresh()
    fixture.statuses['pipe-a'] = new Error('timeout')

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(fixture.registry.refresh()).resolves.toEqual([
        expect.objectContaining({ instanceId: 'bridge-a', connected: false }),
      ])
    }

    await expect(access(endpointA)).resolves.toBeUndefined()
  })

  it('coalesces concurrent refresh calls into one discovery scan', async () => {
    let releaseFirstExchange: () => void = () => undefined
    let signalFirstExchange: () => void = () => undefined
    const firstExchange = new Promise<void>((resolve) => { signalFirstExchange = resolve })
    const exchangeGate = new Promise<void>((resolve) => { releaseFirstExchange = resolve })
    let blocked = false
    const fixture = await createFixture({
      'pipe-a': async () => {
        if (!blocked) {
          blocked = true
          signalFirstExchange()
          await exchangeGate
        }
        return status('bridge-a', 'doc-a', 'Model-A.nwf')
      },
      'pipe-b': status('bridge-b', 'doc-b', 'Model-B.nwf'),
    })
    await fixture.writeEndpoint(12340, 'pipe-a')
    await fixture.writeEndpoint(18120, 'pipe-b')

    const refreshes = [
      fixture.registry.refresh(),
      fixture.registry.refresh(),
      fixture.registry.refresh(),
    ]
    await firstExchange
    await new Promise<void>((resolve) => setImmediate(resolve))
    releaseFirstExchange()
    const results = await Promise.all(refreshes)

    expect(fixture.exchangeCalls()).toBe(2)
    expect(results).toHaveLength(3)
    for (const instances of results) {
      expect(instances.map((item) => item.instanceId).sort()).toEqual(['bridge-a', 'bridge-b'])
    }
  })

  it('keeps both instances and the explicit B selection while refresh is in flight', async () => {
    let releaseRefresh: () => void = () => undefined
    let signalRefresh: () => void = () => undefined
    const refreshStarted = new Promise<void>((resolve) => { signalRefresh = resolve })
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve })
    const fixture = await createFixture({
      'pipe-a': status('bridge-a', 'doc-a', 'Model-A.nwf'),
      'pipe-b': status('bridge-b', 'doc-b', 'Model-B.nwf'),
    })
    await fixture.writeEndpoint(12340, 'pipe-a')
    await fixture.writeEndpoint(18120, 'pipe-b')
    const initial = await fixture.registry.refresh()
    const selection = new NavisworksInstanceSelection()
    selection.observe(initial)
    selection.select('bridge-b', initial)
    fixture.statuses['pipe-a'] = async () => {
      signalRefresh()
      await refreshGate
      return status('bridge-a', 'doc-a', 'Model-A.nwf')
    }

    const pollingRefresh = fixture.registry.refresh()
    await refreshStarted
    const selectionRefresh = fixture.registry.refresh()
    selection.select('bridge-b', fixture.registry.instances)
    releaseRefresh()
    const [polled, selected] = await Promise.all([pollingRefresh, selectionRefresh])
    selection.observe(selected)

    expect(polled.map((item) => item.instanceId).sort()).toEqual(['bridge-a', 'bridge-b'])
    expect(selection.instancesForUi(selected).map((item) => item.instanceId).sort())
      .toEqual(['bridge-a', 'bridge-b'])
    expect(selection.selectedInstanceId).toBe('bridge-b')
  })

  it('restores the same instance after a temporary disconnect', async () => {
    const fixture = await createFixture({
      'pipe-a': status('bridge-a', 'doc-a', 'Model-A.nwf'),
    })
    await fixture.writeEndpoint(12340, 'pipe-a')
    await fixture.registry.refresh()
    fixture.statuses['pipe-a'] = new Error('timeout')
    await expect(fixture.registry.refresh()).resolves.toEqual([
      expect.objectContaining({ instanceId: 'bridge-a', connected: false }),
    ])

    fixture.statuses['pipe-a'] = status('bridge-a', 'doc-a', 'Model-A.nwf')
    const restored = await fixture.registry.refresh()

    expect(restored).toEqual([
      expect.objectContaining({ instanceId: 'bridge-a', connected: true }),
    ])
  })

  it('falls back to the legacy endpoint only when the endpoints directory is empty', async () => {
    const fixture = await createFixture({
      'legacy-pipe': status('legacy-bridge', 'legacy-doc', 'Legacy.nwf'),
    })
    await fixture.writeLegacyEndpoint(999, 'legacy-pipe')

    await expect(fixture.registry.refresh()).resolves.toEqual([
      expect.objectContaining({ instanceId: 'legacy-bridge', documentName: 'Legacy.nwf' }),
    ])
  })
})

function status(bridgeSessionId: string, documentInstanceId: string, documentTitle: string) {
  return { connected: true, bridgeSessionId, documentInstanceId, documentTitle }
}

type StatusResult = Record<string, unknown>
type StatusSource = StatusResult | Error | (() => StatusResult | Promise<StatusResult>)

async function createFixture(statuses: Record<string, StatusSource>) {
  const root = await mkdtemp(path.join(tmpdir(), 'navisworks-instance-registry-'))
  temporaryDirectories.push(root)
  const endpointsDirectory = path.join(root, 'endpoints')
  const legacyEndpointFile = path.join(root, 'endpoint.json')
  await mkdir(endpointsDirectory, { recursive: true })
  let exchangeCallCount = 0
  const transport: BridgeTransport = {
    async exchange(pipeName, requestFrame) {
      exchangeCallCount += 1
      if (!(pipeName in statuses)) throw new Error(`Pipe unavailable: ${pipeName}`)
      const source = statuses[pipeName]
      const result = typeof source === 'function' ? await source() : source
      if (result instanceof Error) throw result
      const request = JSON.parse(decodeBridgeFrame(requestFrame).toString('utf8')) as { Id: string }
      return Buffer.from(JSON.stringify({ Id: request.Id, Ok: true, Result: result }))
    },
  }
  const bridge = new NavisworksBridgeClient({ endpointFile: legacyEndpointFile, transport })
  const registry = new NavisworksInstanceRegistry({
    bridge,
    endpointsDirectory,
    legacyEndpointFile,
    now: () => 123456,
  })
  const endpoint = (processId: number, pipeName: string) => ({
    ProtocolVersion: 1,
    PipeName: pipeName,
    ProcessId: processId,
    PluginVersion: '1.0.0',
    HostVersion: '2023',
    StartedAtUtc: `2026-09-01T00:00:${processId % 60}.000Z`,
  })
  const writeEndpoint = async (processId: number, pipeName: string) => {
    const file = path.join(endpointsDirectory, `${processId}.json`)
    await writeFile(file, JSON.stringify(endpoint(processId, pipeName)), 'utf8')
    return file
  }
  const writeLegacyEndpoint = async (processId: number, pipeName: string) => {
    await writeFile(legacyEndpointFile, JSON.stringify(endpoint(processId, pipeName)), 'utf8')
  }
  return {
    registry,
    statuses,
    writeEndpoint,
    writeLegacyEndpoint,
    exchangeCalls: () => exchangeCallCount,
  }
}
