import type { DesktopEventName, EventPayload, InputFor, IpcRoute, OutputFor } from './schemas'

export const IPC_REQUEST_CHANNEL = 'navisworks:request' as const
export const IPC_EVENT_CHANNEL = 'navisworks:event' as const

export interface DesktopEventEnvelope<E extends DesktopEventName = DesktopEventName> {
  event: E
  payload: EventPayload<E>
}

export interface DesktopApi {
  request<R extends IpcRoute>(
    route: R,
    ...args: InputFor<R> extends undefined ? [] | [input: undefined] : [input: InputFor<R>]
  ): Promise<OutputFor<R>>

  subscribe<E extends DesktopEventName>(
    event: E,
    listener: (payload: EventPayload<E>) => void
  ): () => void
}
