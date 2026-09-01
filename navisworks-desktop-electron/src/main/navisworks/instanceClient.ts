import {
  NavisworksBridgeClient,
  type BridgeCallOptions,
  type BridgeEndpoint,
} from '../bridgeClient'

/** A short-lived client pinned to one endpoint file snapshot. */
export class NavisworksInstanceClient {
  constructor(
    readonly endpoint: BridgeEndpoint,
    private readonly bridge: NavisworksBridgeClient,
  ) {}

  call<T = unknown>(
    method: string,
    parameters: Record<string, unknown> = {},
    options: BridgeCallOptions = {},
  ): Promise<T> {
    return this.bridge.callToEndpoint<T>(this.endpoint, method, parameters, options)
  }
}
