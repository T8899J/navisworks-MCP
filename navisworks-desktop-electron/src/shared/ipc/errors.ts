export const ipcErrorCodes = [
  'FORBIDDEN_SENDER',
  'ROUTE_NOT_FOUND',
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'CONFLICT',
  'CANCELLED',
  'SERVICE_UNAVAILABLE',
  'INTERNAL'
] as const

export type IpcErrorCode = (typeof ipcErrorCodes)[number]

export interface IpcErrorPayload {
  code: IpcErrorCode
  message: string
  details?: unknown
}

export type IpcEnvelope<T> = { ok: true; data: T } | { ok: false; error: IpcErrorPayload }

export class DesktopIpcError extends Error {
  readonly code: IpcErrorCode
  readonly details?: unknown

  constructor(code: IpcErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = 'DesktopIpcError'
    this.code = code
    this.details = details
  }

  toPayload(): IpcErrorPayload {
    return {
      code: this.code,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details })
    }
  }

  static from(error: unknown): DesktopIpcError {
    if (error instanceof DesktopIpcError) return error
    if (error instanceof Error) return new DesktopIpcError('INTERNAL', error.message)
    return new DesktopIpcError('INTERNAL', 'Unknown desktop service error')
  }
}
