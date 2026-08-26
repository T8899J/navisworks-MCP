import type { AppearanceState, DesktopApi, ThemeMode } from '../shared/ipc'

function api(): DesktopApi | undefined {
  return (window as unknown as { desktop?: DesktopApi }).desktop
}

/** Applies both the user's preference and Electron's resolved native theme. */
export function applyAppearance(state: AppearanceState): void {
  const root = document.documentElement
  root.dataset.themeMode = state.themeMode
  root.dataset.theme = state.effectiveTheme
  root.style.colorScheme = state.effectiveTheme
}

/**
 * Global font scale driven by the appearance setting. Only `--font-scale`
 * changes, so text grows while the layout frame (paddings, widths, heights)
 * stays fixed — the window must not resize with the font.
 */
export function applyFontScale(scale: number): void {
  const clamped = Number.isFinite(scale) ? Math.min(1.3, Math.max(0.85, scale)) : 1
  document.documentElement.style.setProperty('--font-scale', String(clamped))
}

export const appearanceGateway = {
  async get(): Promise<AppearanceState> {
    const desktop = api()
    if (!desktop) {
      const effectiveTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
      return { themeMode: 'system', effectiveTheme }
    }
    return desktop.request('appearance.get')
  },

  async update(themeMode: ThemeMode): Promise<AppearanceState> {
    const desktop = api()
    if (!desktop) {
      const effectiveTheme = themeMode === 'system'
        ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
        : themeMode
      return { themeMode, effectiveTheme }
    }
    return desktop.request('appearance.update', { themeMode })
  },

  subscribe(listener: (state: AppearanceState) => void): () => void {
    return api()?.subscribe('nativeTheme.updated', listener) ?? (() => undefined)
  }
}
