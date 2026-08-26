import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  decodeBridgeFrame,
  encodeBridgeFrame,
  MAX_BRIDGE_FRAME_BYTES,
  NavisworksBridgeClient,
  type BridgeTransport,
} from '../bridgeClient'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })))
})

describe('Navisworks bridge framing and client', () => {
  it('encodes the repository protocol vector with a four-byte LE header', () => {
    const json = '{"Ok":true,"Result":{"answer":42}}'
    const frame = encodeBridgeFrame(json)
    expect(frame.subarray(0, 4)).toEqual(Buffer.from([0x22, 0x00, 0x00, 0x00]))
    expect(decodeBridgeFrame(frame).toString('utf8')).toBe(json)
  })

  it('rejects the existing 1,048,577-byte invalid header vector', () => {
    const frame = Buffer.from([1, 0, 16, 0])
    expect(() => decodeBridgeFrame(frame)).toThrowError(
      expect.objectContaining({ code: 'INVALID_FRAME_LENGTH' }),
    )
  })

  it('rejects payloads above one MiB by UTF-8 byte length', () => {
    expect(() => encodeBridgeFrame('a'.repeat(MAX_BRIDGE_FRAME_BYTES + 1))).toThrowError(
      expect.objectContaining({ code: 'FRAME_TOO_LARGE' }),
    )
  })

  it('reads endpoint and validates the response request id', async () => {
    const endpointFile = await createEndpoint()
    const transport: BridgeTransport = {
      async exchange(_pipeName, requestFrame) {
        const request = JSON.parse(decodeBridgeFrame(requestFrame).toString('utf8')) as { Id: string }
        return Buffer.from(JSON.stringify({ Id: request.Id, Ok: true, Result: { connected: true } }))
      },
    }
    const client = new NavisworksBridgeClient({ endpointFile, transport })
    await expect(client.getStatus()).resolves.toEqual({ connected: true })
  })

  it('surfaces remote bridge error codes without retrying', async () => {
    const endpointFile = await createEndpoint()
    let calls = 0
    const transport: BridgeTransport = {
      async exchange(_pipeName, requestFrame) {
        calls += 1
        const request = JSON.parse(decodeBridgeFrame(requestFrame).toString('utf8')) as { Id: string }
        return Buffer.from(JSON.stringify({
          Id: request.Id,
          Ok: false,
          Error: { Code: 'NO_DOCUMENT', Message: 'No Navisworks document is open.' },
        }))
      },
    }
    const client = new NavisworksBridgeClient({ endpointFile, transport })

    await expect(client.executeTool('navisworks_get_document')).rejects.toEqual(
      expect.objectContaining({ code: 'NO_DOCUMENT' }),
    )
    expect(calls).toBe(1)
  })
})

async function createEndpoint(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'navisworks-endpoint-test-'))
  temporaryDirectories.push(directory)
  const endpointFile = path.join(directory, 'endpoint.json')
  await writeFile(endpointFile, JSON.stringify({
    ProtocolVersion: 1,
    PipeName: 'navisworks-test-pipe',
    ProcessId: 123,
    PluginVersion: '1.0.0',
    HostVersion: '20.0',
    StartedAtUtc: '2026-08-23T00:00:00.0000000Z',
  }), 'utf8')
  return endpointFile
}
