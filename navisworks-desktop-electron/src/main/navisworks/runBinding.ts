import type {
  BridgeCallOptions,
  BridgeEndpoint,
  NavisworksBridgeClient,
} from '../bridgeClient'
import type { DiscoveredNavisworksInstance, NavisworksRunBinding } from './instanceTypes'

type EndpointBridgeClient = Pick<NavisworksBridgeClient, 'callToEndpoint'>

interface StatusIdentity {
  connected?: unknown
  bridgeSessionId?: unknown
  documentInstanceId?: unknown
  documentTitle?: unknown
  documentName?: unknown
}

export type NavisworksTargetErrorCode =
  | 'TARGET_INSTANCE_DISCONNECTED'
  | 'DOCUMENT_CHANGED'
  | 'INSTANCE_CHANGED'
  | 'TARGET_CHANGED'

export class NavisworksTargetError extends Error {
  constructor(
    readonly code: NavisworksTargetErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'NavisworksTargetError'
  }
}

export async function createNavisworksRunBinding(
  instance: DiscoveredNavisworksInstance,
  bridge: EndpointBridgeClient,
  options: BridgeCallOptions = {},
): Promise<NavisworksRunBinding> {
  if (!instance.connected) {
    throw new NavisworksTargetError(
      'TARGET_INSTANCE_DISCONNECTED',
      '目标 Navisworks 已关闭或无法连接。',
    )
  }
  const status = await readBoundStatus(instance.endpoint, bridge, options)
  const bridgeSessionId = stringValue(status.bridgeSessionId)
  if (bridgeSessionId === undefined || bridgeSessionId !== instance.bridgeSessionId) {
    throw new NavisworksTargetError(
      'INSTANCE_CHANGED',
      '目标 Navisworks 实例已经重启，请重新选择后再试。',
    )
  }
  const endpoint = Object.freeze({ ...instance.endpoint })
  return Object.freeze({
    instanceId: instance.instanceId,
    processId: instance.processId,
    pipeName: instance.pipeName,
    bridgeSessionId,
    ...(stringValue(status.documentInstanceId) === undefined
      ? {}
      : { documentInstanceId: stringValue(status.documentInstanceId) }),
    ...(statusDocumentName(status) === undefined
      ? {}
      : { documentName: statusDocumentName(status) }),
    boundAt: Date.now(),
    endpoint,
  })
}

export async function callWithNavisworksRunBinding<T>(
  bridge: EndpointBridgeClient,
  binding: NavisworksRunBinding,
  method: string,
  parameters: Record<string, unknown> = {},
  options: BridgeCallOptions = {},
): Promise<T> {
  const status = await readBoundStatus(binding.endpoint, bridge, options)
  assertBindingIdentity(binding, status)
  return bridge.callToEndpoint<T>(binding.endpoint, method, parameters, options)
}

export async function validateNavisworksRunBinding(
  bridge: EndpointBridgeClient,
  binding: NavisworksRunBinding,
  options: BridgeCallOptions = {},
): Promise<void> {
  const status = await readBoundStatus(binding.endpoint, bridge, options)
  assertBindingIdentity(binding, status)
}

function assertBindingIdentity(binding: NavisworksRunBinding, status: StatusIdentity): void {
  if (status.connected !== true) {
    throw new NavisworksTargetError(
      'TARGET_INSTANCE_DISCONNECTED',
      '目标 Navisworks 已关闭。',
    )
  }
  if (stringValue(status.bridgeSessionId) !== binding.bridgeSessionId) {
    throw new NavisworksTargetError(
      'INSTANCE_CHANGED',
      '目标 Navisworks 实例已经重启，本轮操作已终止。',
    )
  }
  if ((stringValue(status.documentInstanceId) ?? null)
    !== (binding.documentInstanceId ?? null)) {
    throw new NavisworksTargetError(
      'DOCUMENT_CHANGED',
      '目标 Navisworks 中的文档已经变化，本轮操作已终止。',
    )
  }
}

async function readBoundStatus(
  endpoint: Readonly<BridgeEndpoint>,
  bridge: EndpointBridgeClient,
  options: BridgeCallOptions,
): Promise<StatusIdentity> {
  try {
    return await bridge.callToEndpoint<StatusIdentity>(endpoint, 'navisworks_status', {}, options)
  } catch (error) {
    if (error instanceof NavisworksTargetError) throw error
    throw new NavisworksTargetError(
      'TARGET_INSTANCE_DISCONNECTED',
      '目标 Navisworks 已关闭或无法连接。',
      error instanceof Error ? { cause: error } : undefined,
    )
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function statusDocumentName(status: StatusIdentity): string | undefined {
  return stringValue(status.documentTitle) ?? stringValue(status.documentName)
}
