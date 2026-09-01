import type { NavisworksInstance } from './instanceTypes'

/** User intent only. Discovery updates status but never silently changes an existing target. */
export class NavisworksInstanceSelection {
  #selectedInstanceId: string | undefined
  #selectedSnapshot: NavisworksInstance | undefined

  get selectedInstanceId(): string | undefined {
    return this.#selectedInstanceId
  }

  observe(instances: readonly NavisworksInstance[]): void {
    if (this.#selectedInstanceId === undefined) {
      const connected = instances.filter((instance) => instance.connected)
      if (connected.length === 1) this.#select(connected[0]!)
      return
    }
    const selected = instances.find((instance) => instance.instanceId === this.#selectedInstanceId)
    if (selected !== undefined) {
      this.#selectedSnapshot = { ...selected }
    } else if (this.#selectedSnapshot !== undefined) {
      this.#selectedSnapshot = { ...this.#selectedSnapshot, connected: false }
    }
  }

  select(instanceId: string, instances: readonly NavisworksInstance[]): void {
    const instance = instances.find((candidate) => candidate.instanceId === instanceId)
    if (instance === undefined) throw new Error(`Navisworks instance not found: ${instanceId}`)
    this.#select(instance)
  }

  selected(instances: readonly NavisworksInstance[]): NavisworksInstance | undefined {
    if (this.#selectedInstanceId === undefined) return undefined
    const live = instances.find((instance) => instance.instanceId === this.#selectedInstanceId)
    return live === undefined
      ? (this.#selectedSnapshot === undefined ? undefined : { ...this.#selectedSnapshot, connected: false })
      : { ...live }
  }

  instancesForUi(instances: readonly NavisworksInstance[]): NavisworksInstance[] {
    const summaries = instances.map((instance) => ({ ...instance }))
    const selected = this.selected(instances)
    if (selected !== undefined && !summaries.some((item) => item.instanceId === selected.instanceId)) {
      summaries.push(selected)
    }
    return summaries
  }

  #select(instance: NavisworksInstance): void {
    this.#selectedInstanceId = instance.instanceId
    this.#selectedSnapshot = { ...instance }
  }
}
