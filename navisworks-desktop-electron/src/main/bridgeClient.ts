import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import net from 'node:net'

export const BRIDGE_PROTOCOL_VERSION = 1 as const
export const MAX_BRIDGE_FRAME_BYTES = 1024 * 1024
export const DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS = 15_000
export const ENDPOINT_FILE_ENVIRONMENT_VARIABLE = 'NAVISWORKS_MCP_ENDPOINT_FILE'

export interface BridgeEndpoint {
  ProtocolVersion: number
  PipeName: string
  ProcessId: number
  PluginVersion: string
  HostVersion: string
  StartedAtUtc: string
}

export interface BridgeRequest {
  Id: string
  ProtocolVersion: typeof BRIDGE_PROTOCOL_VERSION
  Method: string
  Params: Record<string, unknown>
}

export interface BridgeFailure {
  Code: string
  Message: string
}

export type BridgeResponse<T> =
  | { Id: string; Ok: true; Result: T; Error?: never }
  | { Id: string; Ok: false; Result?: never; Error: BridgeFailure }

export type BridgeErrorCode =
  | 'NAVISWORKS_NOT_CONNECTED'
  | 'ENDPOINT_READ_FAILED'
  | 'INVALID_ENDPOINT'
  | 'FRAME_TOO_LARGE'
  | 'INVALID_FRAME_LENGTH'
  | 'INVALID_RESPONSE'
  | 'RESPONSE_ID_MISMATCH'
  | 'NAVISWORKS_TIMEOUT'
  | 'BRIDGE_IO'
  | string

export class BridgeError extends Error {
  readonly code: BridgeErrorCode
  /** A timeout/I/O failure after connect may still have executed in Navisworks. */
  readonly ambiguousOutcome: boolean

  constructor(
    code: BridgeErrorCode,
    message: string,
    options: ErrorOptions & { ambiguousOutcome?: boolean } = {},
  ) {
    super(message, options)
    this.name = 'BridgeError'
    this.code = code
    this.ambiguousOutcome = options.ambiguousOutcome ?? false
  }
}

export interface BridgeClientOptions {
  endpointFile?: string
  requestTimeoutMs?: number
  env?: NodeJS.ProcessEnv
  localAppData?: string
  transport?: BridgeTransport
}

export interface BridgeCallOptions {
  signal?: AbortSignal
}

export interface BridgeExchangeOptions {
  timeoutMs: number
  signal?: AbortSignal
}

export interface BridgeTransport {
  exchange(pipeName: string, requestFrame: Buffer, options: BridgeExchangeOptions): Promise<Buffer>
}

export class NavisworksBridgeClient {
  readonly #endpointFile: string
  readonly #requestTimeoutMs: number
  readonly #transport: BridgeTransport

  constructor(options: BridgeClientOptions = {}) {
    this.#endpointFile = options.endpointFile ?? resolveBridgeEndpointFile(options)
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS
    if (!Number.isInteger(this.#requestTimeoutMs) || this.#requestTimeoutMs <= 0) {
      throw new RangeError('requestTimeoutMs must be a positive integer.')
    }
    this.#transport = options.transport ?? new NamedPipeBridgeTransport()
  }

  get endpointFile(): string {
    return this.#endpointFile
  }

  async call<T = unknown>(
    method: string,
    parameters: Record<string, unknown> = {},
    options: BridgeCallOptions = {},
  ): Promise<T> {
    throwIfAborted(options.signal)
    const endpoint = await readBridgeEndpoint(this.#endpointFile)
    throwIfAborted(options.signal)

    return await this.callToEndpoint<T>(endpoint, method, parameters, options)
  }

  /** Call one immutable endpoint directly; no discovery or selection is re-read. */
  async callToEndpoint<T = unknown>(
    endpoint: BridgeEndpoint,
    method: string,
    parameters: Record<string, unknown> = {},
    options: BridgeCallOptions = {},
  ): Promise<T> {
    throwIfAborted(options.signal)
    if (endpoint.ProtocolVersion !== BRIDGE_PROTOCOL_VERSION || !endpoint.PipeName.trim()) {
      throw new BridgeError('INVALID_ENDPOINT', 'Navisworks bridge endpoint is invalid.')
    }

    const request: BridgeRequest = {
      Id: randomUUID(),
      ProtocolVersion: BRIDGE_PROTOCOL_VERSION,
      Method: method,
      Params: parameters,
    }
    const requestFrame = encodeBridgeFrame(JSON.stringify(request))
    const responsePayload = await this.#transport.exchange(
      endpoint.PipeName,
      requestFrame,
      { timeoutMs: this.#requestTimeoutMs, signal: options.signal },
    )
    const response = parseBridgeResponse<T>(decodeUtf8(responsePayload))

    if (response.Id !== request.Id) {
      throw new BridgeError(
        'RESPONSE_ID_MISMATCH',
        'Navisworks bridge returned a response for another request.',
      )
    }
    if (!response.Ok) {
      throw new BridgeError(
        response.Error?.Code || 'NAVISWORKS_ERROR',
        response.Error?.Message || 'Navisworks rejected the request.',
      )
    }

    return response.Result
  }

  async getStatus(options: BridgeCallOptions = {}): Promise<unknown> {
    return await this.call('navisworks_status', {}, options)
  }

  async executeTool<T = unknown>(
    method: string,
    parameters: Record<string, unknown> = {},
    options: BridgeCallOptions = {},
  ): Promise<T> {
    return await this.call<T>(method, parameters, options)
  }

  dispose(): void {
    // Each call owns one short-lived named-pipe connection.
  }
}

export class NamedPipeBridgeTransport implements BridgeTransport {
  async exchange(
    pipeName: string,
    requestFrame: Buffer,
    options: BridgeExchangeOptions,
  ): Promise<Buffer> {
    throwIfAborted(options.signal)

    return await new Promise<Buffer>((resolve, reject) => {
      const pipePath = `\\\\.\\pipe\\${pipeName}`
      const socket = net.createConnection(pipePath)
      const chunks: Buffer[] = []
      let bufferedBytes = 0
      let expectedPayloadBytes: number | null = null
      let requestMayHaveBeenSent = false
      let settled = false

      const timeout = setTimeout(() => {
        fail(new BridgeError(
          'NAVISWORKS_TIMEOUT',
          `Navisworks did not respond within ${options.timeoutMs} ms.`,
          { ambiguousOutcome: requestMayHaveBeenSent },
        ))
      }, options.timeoutMs)

      const abort = (): void => {
        fail(createAbortError(options.signal?.reason))
      }

      const cleanup = (): void => {
        clearTimeout(timeout)
        options.signal?.removeEventListener('abort', abort)
        socket.removeAllListeners()
        if (!socket.destroyed) {
          socket.destroy()
        }
      }

      const succeed = (payload: Buffer): void => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        resolve(payload)
      }

      const fail = (error: unknown): void => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        if (error instanceof BridgeError || isAbortError(error)) {
          reject(error)
          return
        }
        reject(new BridgeError(
          'BRIDGE_IO',
          `Navisworks bridge I/O failed: ${errorMessage(error)}`,
          { cause: error, ambiguousOutcome: requestMayHaveBeenSent },
        ))
      }

      options.signal?.addEventListener('abort', abort, { once: true })

      socket.once('connect', () => {
        requestMayHaveBeenSent = true
        socket.write(requestFrame, (error) => {
          if (error) {
            fail(error)
          }
        })
      })

      socket.on('data', (chunk: Buffer) => {
        chunks.push(chunk)
        bufferedBytes += chunk.length

        if (expectedPayloadBytes === null && bufferedBytes >= 4) {
          const combined = Buffer.concat(chunks, bufferedBytes)
          expectedPayloadBytes = combined.readUInt32LE(0)
          if (expectedPayloadBytes <= 0 || expectedPayloadBytes > MAX_BRIDGE_FRAME_BYTES) {
            fail(new BridgeError(
              'INVALID_FRAME_LENGTH',
              'Bridge frame length is outside the allowed range.',
              { ambiguousOutcome: requestMayHaveBeenSent },
            ))
            return
          }
        }

        if (expectedPayloadBytes !== null && bufferedBytes >= 4 + expectedPayloadBytes) {
          const combined = Buffer.concat(chunks, bufferedBytes)
          succeed(Buffer.from(combined.subarray(4, 4 + expectedPayloadBytes)))
        }
      })

      socket.once('end', () => {
        fail(new Error('Bridge connection ended in the middle of a frame.'))
      })
      socket.once('error', fail)
    })
  }
}

export function resolveBridgeEndpointFile(
  options: Pick<BridgeClientOptions, 'env' | 'localAppData'> = {},
): string {
  const env = options.env ?? process.env
  const explicitPath = env[ENDPOINT_FILE_ENVIRONMENT_VARIABLE]
  if (explicitPath?.trim()) {
    return path.resolve(expandWindowsEnvironmentVariables(explicitPath.trim(), env))
  }

  const localAppData = options.localAppData?.trim()
    ? options.localAppData
    : env.LOCALAPPDATA?.trim()
      ? env.LOCALAPPDATA
      : path.join(homedir(), 'AppData', 'Local')
  return path.join(localAppData, 'NavisworksCodexMcp', 'endpoint.json')
}

export function resolveBridgeEndpointsDirectory(
  options: Pick<BridgeClientOptions, 'env' | 'localAppData'> = {},
): string {
  return path.join(path.dirname(resolveBridgeEndpointFile(options)), 'endpoints')
}

export async function readBridgeEndpoint(endpointFile: string): Promise<BridgeEndpoint> {
  let json: string
  try {
    json = await readFile(endpointFile, 'utf8')
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      throw new BridgeError(
        'NAVISWORKS_NOT_CONNECTED',
        'Navisworks MCP plug-in is not running. Start or restart Navisworks Manage 2023.',
        { cause: error },
      )
    }
    throw new BridgeError(
      'ENDPOINT_READ_FAILED',
      `Cannot read the Navisworks bridge endpoint file: ${errorMessage(error)}`,
      { cause: error },
    )
  }

  let value: unknown
  try {
    value = JSON.parse(json)
  } catch (error) {
    throw new BridgeError(
      'INVALID_ENDPOINT',
      'Navisworks bridge endpoint file contains invalid JSON.',
      { cause: error },
    )
  }

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BridgeError('INVALID_ENDPOINT', 'Navisworks bridge endpoint file is empty.')
  }
  const endpoint = value as Record<string, unknown>
  const protocolVersion = typeof endpoint.ProtocolVersion === 'number'
    ? endpoint.ProtocolVersion
    : 0
  const pipeName = typeof endpoint.PipeName === 'string' ? endpoint.PipeName : ''
  if (!pipeName.trim() || protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
    throw new BridgeError(
      'INVALID_ENDPOINT',
      `Expected bridge protocol ${BRIDGE_PROTOCOL_VERSION}, received ${protocolVersion}.`,
    )
  }

  return {
    ProtocolVersion: protocolVersion,
    PipeName: pipeName,
    ProcessId: typeof endpoint.ProcessId === 'number' ? endpoint.ProcessId : 0,
    PluginVersion: typeof endpoint.PluginVersion === 'string' ? endpoint.PluginVersion : '',
    HostVersion: typeof endpoint.HostVersion === 'string' ? endpoint.HostVersion : '',
    StartedAtUtc: typeof endpoint.StartedAtUtc === 'string' ? endpoint.StartedAtUtc : '',
  }
}

export function encodeBridgeFrame(json: string): Buffer {
  const payload = Buffer.from(json, 'utf8')
  if (payload.length > MAX_BRIDGE_FRAME_BYTES) {
    throw new BridgeError(
      'FRAME_TOO_LARGE',
      `Bridge payload exceeds ${MAX_BRIDGE_FRAME_BYTES} bytes.`,
    )
  }
  if (payload.length === 0) {
    throw new BridgeError(
      'INVALID_FRAME_LENGTH',
      'Bridge frame length is outside the allowed range.',
    )
  }

  const frame = Buffer.allocUnsafe(4 + payload.length)
  frame.writeUInt32LE(payload.length, 0)
  payload.copy(frame, 4)
  return frame
}

export function decodeBridgeFrame(frame: Buffer): Buffer {
  if (frame.length < 4) {
    throw new BridgeError('BRIDGE_IO', 'Bridge connection ended in the middle of a frame.')
  }
  const payloadLength = frame.readUInt32LE(0)
  if (payloadLength <= 0 || payloadLength > MAX_BRIDGE_FRAME_BYTES) {
    throw new BridgeError(
      'INVALID_FRAME_LENGTH',
      'Bridge frame length is outside the allowed range.',
    )
  }
  if (frame.length < 4 + payloadLength) {
    throw new BridgeError('BRIDGE_IO', 'Bridge connection ended in the middle of a frame.')
  }
  return Buffer.from(frame.subarray(4, 4 + payloadLength))
}

function parseBridgeResponse<T>(json: string): BridgeResponse<T> {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch (error) {
    throw new BridgeError(
      'INVALID_RESPONSE',
      'Navisworks bridge returned an invalid response.',
      { cause: error },
    )
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BridgeError('INVALID_RESPONSE', 'Navisworks bridge returned an empty response.')
  }

  const response = value as Record<string, unknown>
  if (typeof response.Id !== 'string' || typeof response.Ok !== 'boolean') {
    throw new BridgeError('INVALID_RESPONSE', 'Navisworks bridge returned an invalid response.')
  }
  if (!response.Ok) {
    const rawError = response.Error
    const error = rawError !== null && typeof rawError === 'object' && !Array.isArray(rawError)
      ? rawError as Record<string, unknown>
      : {}
    return {
      Id: response.Id,
      Ok: false,
      Error: {
        Code: typeof error.Code === 'string' ? error.Code : 'NAVISWORKS_ERROR',
        Message: typeof error.Message === 'string'
          ? error.Message
          : 'Navisworks rejected the request.',
      },
    }
  }

  return { Id: response.Id, Ok: true, Result: response.Result as T }
}

function decodeUtf8(payload: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(payload)
  } catch (error) {
    throw new BridgeError(
      'INVALID_RESPONSE',
      'Navisworks bridge returned an invalid response.',
      { cause: error },
    )
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createAbortError(signal.reason)
  }
}

function createAbortError(reason: unknown): Error {
  if (isAbortError(reason)) {
    return reason
  }
  const error = new Error(
    reason instanceof Error ? reason.message : 'The operation was aborted.',
    reason instanceof Error ? { cause: reason } : undefined,
  )
  error.name = 'AbortError'
  return error
}

function isAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === 'AbortError'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === code
}

function expandWindowsEnvironmentVariables(
  value: string,
  env: NodeJS.ProcessEnv,
): string {
  const values = new Map(
    Object.entries(env).map(([key, entry]) => [key.toUpperCase(), entry]),
  )
  return value.replace(/%([^%]+)%/g, (match, name: string) => {
    const replacement = values.get(name.toUpperCase())
    return replacement === undefined ? match : replacement
  })
}
