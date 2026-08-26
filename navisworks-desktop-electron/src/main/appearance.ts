import type { AppearanceState, ThemeMode } from '../shared/ipc'

export interface NativeThemePort {
  themeSource: ThemeMode
  readonly shouldUseDarkColors: boolean
  on(event: 'updated', listener: () => void): unknown
  removeListener(event: 'updated', listener: () => void): unknown
}

/**
 * Owns Electron's process-global native theme state. Persistence remains in the
 * settings repository; this service only applies a validated preference and
 * reports the resolved light/dark appearance to renderer windows.
 */
export class NativeAppearanceService {
  readonly #handleNativeThemeUpdated = (): void => this.#notifyIfChanged()
  #started = false
  #lastNotificationKey = ''

  constructor(
    private readonly nativeTheme: NativeThemePort,
    private themeMode: ThemeMode,
    private readonly onChanged: (state: AppearanceState) => void
  ) {}

  start(): AppearanceState {
    if (!this.#started) {
      this.#started = true
      this.nativeTheme.themeSource = this.themeMode
      this.nativeTheme.on('updated', this.#handleNativeThemeUpdated)
    }
    return this.getState()
  }

  getState(): AppearanceState {
    return {
      themeMode: this.themeMode,
      effectiveTheme: this.nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
    }
  }

  setThemeMode(themeMode: ThemeMode): AppearanceState {
    this.themeMode = themeMode
    this.nativeTheme.themeSource = themeMode
    this.#notifyIfChanged()
    return this.getState()
  }

  dispose(): void {
    if (!this.#started) return
    this.#started = false
    this.nativeTheme.removeListener('updated', this.#handleNativeThemeUpdated)
  }

  #notifyIfChanged(): void {
    const state = this.getState()
    const key = `${state.themeMode}:${state.effectiveTheme}`
    if (key === this.#lastNotificationKey) return
    this.#lastNotificationKey = key
    this.onChanged(state)
  }
}
