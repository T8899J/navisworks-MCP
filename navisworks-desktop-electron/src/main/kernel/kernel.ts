import { Context, Service, type Fiber } from 'cordis'

export type ScopeKind = 'app' | 'document' | 'conversation' | 'run'

export interface ServiceToken<T> {
  readonly id: string
  readonly _type?: T
}

export function token<T>(id: string): ServiceToken<T> {
  return { id }
}

export type DisposeEffect = () => void | Promise<void>

export interface Scope {
  readonly kind: ScopeKind
  readonly id: string
  register<T>(key: ServiceToken<T>, value: T): this
  resolve<T>(key: ServiceToken<T>): T | undefined
  require<T>(key: ServiceToken<T>): T
  onDispose(effect: DisposeEffect): void
  createChild(kind: ScopeKind, id: string): Promise<Scope>
  dispose(): Promise<void>
  readonly disposed: boolean
}

class ValueService<T> extends Service {
  readonly value: T

  constructor(ctx: Context, name: string, value: T) {
    super(ctx, name)
    this.value = value
  }
}

/** Thin typed adapter over real Cordis Context/Fiber/Service lifecycle primitives. */
class CordisScope implements Scope {
  readonly #services = new Map<string, string>()
  readonly #children = new Set<CordisScope>()
  readonly #context: Context
  readonly #fiber: Fiber
  readonly #parent: CordisScope | null
  #disposed = false

  private constructor(
    readonly kind: ScopeKind,
    readonly id: string,
    context: Context,
    fiber: Fiber,
    parent: CordisScope | null,
  ) {
    this.#context = context
    this.#fiber = fiber
    this.#parent = parent
  }

  static async createRoot(id: string): Promise<CordisScope> {
    const host = new Context()
    const fiber = host.plugin(() => undefined)
    await fiber
    return new CordisScope('app', id, fiber.ctx, fiber, null)
  }

  get disposed(): boolean {
    return this.#disposed
  }

  register<T>(key: ServiceToken<T>, value: T): this {
    this.#assertLive()
    if (this.#services.has(key.id)) {
      throw new Error(`[${this.kind}:${this.id}] service already registered: ${key.id}`)
    }
    const cordisName = `navisworks.${this.kind}.${this.id}.${key.id}`
    new ValueService(this.#context, cordisName, value)
    this.#services.set(key.id, cordisName)
    return this
  }

  resolve<T>(key: ServiceToken<T>): T | undefined {
    const cordisName = this.#services.get(key.id)
    if (cordisName !== undefined) {
      const service = (this.#context as unknown as Record<string, unknown>)[cordisName]
      if (service instanceof ValueService) return service.value as T
    }
    return this.#parent?.resolve(key)
  }

  require<T>(key: ServiceToken<T>): T {
    const value = this.resolve(key)
    if (value === undefined) {
      throw new Error(`[${this.kind}:${this.id}] required service not found: ${key.id}`)
    }
    return value
  }

  onDispose(effect: DisposeEffect): void {
    this.#assertLive()
    this.#context.effect(() => effect, `scope:${this.kind}:${this.id}`)
  }

  async createChild(kind: ScopeKind, id: string): Promise<Scope> {
    this.#assertLive()
    const fiber = this.#context.plugin(() => undefined)
    await fiber
    const child = new CordisScope(kind, id, fiber.ctx, fiber, this)
    this.#children.add(child)
    child.onDispose(() => { this.#children.delete(child) })
    return child
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    for (const child of [...this.#children]) await child.dispose()
    this.#children.clear()
    await this.#fiber.dispose()
    this.#services.clear()
  }

  #assertLive(): void {
    if (this.#disposed) throw new Error(`[${this.kind}:${this.id}] scope already disposed`)
  }
}

export async function createRootScope(id = 'app'): Promise<Scope> {
  return CordisScope.createRoot(id)
}
