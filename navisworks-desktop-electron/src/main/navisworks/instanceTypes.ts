import type { BridgeEndpoint } from '../bridgeClient'

export interface NavisworksInstance {
  instanceId: string
  processId: number
  pipeName: string
  bridgeSessionId?: string
  documentInstanceId?: string
  documentName?: string
  pluginVersion: string
  hostVersion: string
  startedAtUtc: string
  connected: boolean
  lastSeenAt: number
}

export interface DiscoveredNavisworksInstance extends NavisworksInstance {
  endpoint: BridgeEndpoint
}

export interface NavisworksRunBinding {
  readonly instanceId: string
  readonly processId: number
  readonly pipeName: string
  readonly bridgeSessionId: string
  readonly documentInstanceId?: string
  readonly documentName?: string
  readonly boundAt: number
  readonly endpoint: Readonly<BridgeEndpoint>
}

export function temporaryInstanceId(endpoint: BridgeEndpoint): string {
  return `${endpoint.ProcessId}:${endpoint.StartedAtUtc}`
}
