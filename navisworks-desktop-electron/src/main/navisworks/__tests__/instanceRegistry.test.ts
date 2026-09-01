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

  it('marks an unreachable endpoint disconnected and deletes it only after two failures', async () => {
    const fixture = await createFixture({})
    const staleFile = await fixture.writeEndpoint(20500, 'missing-pipe')

    const first = await fixture.registry.refresh()
    expect(first).toEqual([expect.objectContaining({ connected: false, processId: 20500 })])
    await expect(access(staleFile)).resolves.toBeUndefined()

    const second = await fixture.registry.refresh()
    expect(second).toEqual([expect.objectContaining({ connected: false, processId: 20500 })])
    await expect(access(staleFile)).rejects.toMatchObject({ code: 'ENOENT' })
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

async function createFixture(statuses: Record<string, unknown>) {
  const root = await mkdtemp(path.join(tmpdir(), 'navisworks-instance-registry-'))
  temporaryDirectories.push(root)
  const endpointsDirectory = path.join(root, 'endpoints')
  const legacyEndpointFile = path.join(root, 'endpoint.json')
  await mkdir(endpointsDirectory, { recursive: true })
  const transport: BridgeTransport = {
    async exchange(pipeName, requestFrame) {
      if (!(pipeName in statuses)) throw new Error(`Pipe unavailable: ${pipeName}`)
      const request = JSON.parse(decodeBridgeFrame(requestFrame).toString('utf8')) as { Id: string }
      return Buffer.from(JSON.stringify({ Id: request.Id, Ok: true, Result: statuses[pipeName] }))
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
  return { registry, writeEndpoint, writeLegacyEndpoint }
}
