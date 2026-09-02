import { readdir } from 'node:fs/promises'
import path from 'node:path'

import {
  NavisworksBridgeClient,
  readBridgeEndpoint,
  resolveBridgeEndpointFile,
  resolveBridgeEndpointsDirectory,
  type BridgeClientOptions,
  type BridgeEndpoint,
} from '../bridgeClient'
import { NavisworksInstanceClient } from './instanceClient'
import {
  temporaryInstanceId,
  type DiscoveredNavisworksInstance,
  type NavisworksInstance,
} from './instanceTypes'

interface NavisworksStatusRecord {
  connected?: unknown
  bridgeSessionId?: unknown
  documentInstanceId?: unknown
  documentTitle?: unknown
  documentName?: unknown
}

export interface NavisworksInstanceRegistryOptions {
  bridge: NavisworksBridgeClient
  endpointsDirectory?: string
  legacyEndpointFile?: string
  now?: () => number
}

/** Discovers every endpoint independently; it owns no user selection or Run binding. */
export class NavisworksInstanceRegistry {
  readonly #bridge: NavisworksBridgeClient
  readonly #endpointsDirectory: string
  readonly #legacyEndpointFile: string
  readonly #now: () => number
  readonly #instanceIdByEndpointFile = new Map<string, string>()
  #instances = new Map<string, DiscoveredNavisworksInstance>()
  #refreshInFlight: Promise<NavisworksInstance[]> | undefined

  constructor(options: NavisworksInstanceRegistryOptions) {
    this.#bridge = options.bridge
    this.#endpointsDirectory = options.endpointsDirectory ?? resolveBridgeEndpointsDirectory()
    this.#legacyEndpointFile = options.legacyEndpointFile ?? resolveBridgeEndpointFile()
    this.#now = options.now ?? Date.now
  }

  get instances(): NavisworksInstance[] {
    return [...this.#instances.values()].map(stripEndpoint)
  }

  get(instanceId: string): DiscoveredNavisworksInstance | undefined {
    const instance = this.#instances.get(instanceId)
    return instance === undefined ? undefined : cloneDiscovered(instance)
  }

  refresh(): Promise<NavisworksInstance[]> {
    if (this.#refreshInFlight !== undefined) return this.#refreshInFlight
    const pending = this.#doRefresh().finally(() => {
      if (this.#refreshInFlight === pending) this.#refreshInFlight = undefined
    })
    this.#refreshInFlight = pending
    return pending
  }

  async #doRefresh(): Promise<NavisworksInstance[]> {
    const endpointFiles = await this.#listEndpointFiles()
    const discovered = await Promise.all(endpointFiles.map((file) => this.#inspectEndpoint(file)))
    this.#instances = new Map(
      discovered
        .filter((instance): instance is DiscoveredNavisworksInstance => instance !== undefined)
        .map((instance) => [instance.instanceId, instance]),
    )
    return this.instances
  }

  async #listEndpointFiles(): Promise<string[]> {
    let files: string[] = []
    try {
      files = (await readdir(this.#endpointsDirectory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && /^\d+\.json$/i.test(entry.name))
        .map((entry) => path.join(this.#endpointsDirectory, entry.name))
        .sort()
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) throw error
    }
    if (files.length > 0) return files
    try {
      await readBridgeEndpoint(this.#legacyEndpointFile)
      return [this.#legacyEndpointFile]
    } catch {
      return []
    }
  }

  async #inspectEndpoint(file: string): Promise<DiscoveredNavisworksInstance | undefined> {
    let endpoint: BridgeEndpoint
    try {
      endpoint = await readBridgeEndpoint(file)
    } catch {
      return undefined
    }

    const fallbackId = temporaryInstanceId(endpoint)
    try {
      const status = await new NavisworksInstanceClient(endpoint, this.#bridge)
        .call<NavisworksStatusRecord>('navisworks_status')
      const bridgeSessionId = stringValue(status.bridgeSessionId)
      const instanceId = bridgeSessionId ?? fallbackId
      this.#instanceIdByEndpointFile.set(file, instanceId)
      return {
        instanceId,
        processId: endpoint.ProcessId,
        pipeName: endpoint.PipeName,
        ...(bridgeSessionId === undefined ? {} : { bridgeSessionId }),
        ...(stringValue(status.documentInstanceId) === undefined
          ? {}
          : { documentInstanceId: stringValue(status.documentInstanceId) }),
        ...(statusDocumentName(status) === undefined
          ? {}
          : { documentName: statusDocumentName(status) }),
        pluginVersion: endpoint.PluginVersion,
        hostVersion: endpoint.HostVersion,
        startedAtUtc: endpoint.StartedAtUtc,
        connected: status.connected === true,
        lastSeenAt: this.#now(),
        endpoint: { ...endpoint },
      }
    } catch {
      const instanceId = this.#instanceIdByEndpointFile.get(file) ?? fallbackId
      const previous = this.#instances.get(instanceId)
      return {
        instanceId,
        processId: endpoint.ProcessId,
        pipeName: endpoint.PipeName,
        ...(previous?.bridgeSessionId === undefined ? {} : { bridgeSessionId: previous.bridgeSessionId }),
        ...(previous?.documentInstanceId === undefined
          ? {}
          : { documentInstanceId: previous.documentInstanceId }),
        ...(previous?.documentName === undefined ? {} : { documentName: previous.documentName }),
        pluginVersion: endpoint.PluginVersion,
        hostVersion: endpoint.HostVersion,
        startedAtUtc: endpoint.StartedAtUtc,
        connected: false,
        lastSeenAt: previous?.lastSeenAt ?? 0,
        endpoint: { ...endpoint },
      }
    }
  }
}

export function resolveInstanceRegistryPaths(
  options: Pick<BridgeClientOptions, 'env' | 'localAppData'> = {},
): { endpointsDirectory: string; legacyEndpointFile: string } {
  return {
    endpointsDirectory: resolveBridgeEndpointsDirectory(options),
    legacyEndpointFile: resolveBridgeEndpointFile(options),
  }
}

function stripEndpoint(instance: DiscoveredNavisworksInstance): NavisworksInstance {
  const { endpoint: _endpoint, ...summary } = instance
  return { ...summary }
}

function cloneDiscovered(instance: DiscoveredNavisworksInstance): DiscoveredNavisworksInstance {
  return { ...instance, endpoint: { ...instance.endpoint } }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function statusDocumentName(status: NavisworksStatusRecord): string | undefined {
  return stringValue(status.documentTitle) ?? stringValue(status.documentName)
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === code
}
