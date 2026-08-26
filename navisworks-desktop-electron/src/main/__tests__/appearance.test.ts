import { describe, expect, it, vi } from 'vitest'

import { NativeAppearanceService, type NativeThemePort } from '../appearance'

class FakeNativeTheme implements NativeThemePort {
  #themeSource: 'system' | 'light' | 'dark' = 'system'
  #systemDark = false
  readonly listeners = new Set<() => void>()

  get themeSource(): 'system' | 'light' | 'dark' {
    return this.#themeSource
  }

  set themeSource(value: 'system' | 'light' | 'dark') {
    this.#themeSource = value
  }

  get shouldUseDarkColors(): boolean {
    if (this.#themeSource === 'dark') return true
    if (this.#themeSource === 'light') return false
    return this.#systemDark
  }

  on(_event: 'updated', listener: () => void): void {
    this.listeners.add(listener)
  }

  removeListener(_event: 'updated', listener: () => void): void {
    this.listeners.delete(listener)
  }

  setSystemDark(value: boolean): void {
    this.#systemDark = value
    for (const listener of this.listeners) listener()
  }
}

describe('NativeAppearanceService', () => {
  it('applies an explicit theme and reports the resolved appearance', () => {
    const nativeTheme = new FakeNativeTheme()
    const onChanged = vi.fn()
    const service = new NativeAppearanceService(nativeTheme, 'system', onChanged)

    expect(service.start()).toEqual({ themeMode: 'system', effectiveTheme: 'light' })
    expect(nativeTheme.themeSource).toBe('system')

    expect(service.setThemeMode('dark')).toEqual({ themeMode: 'dark', effectiveTheme: 'dark' })
    expect(nativeTheme.themeSource).toBe('dark')
    expect(onChanged).toHaveBeenLastCalledWith({ themeMode: 'dark', effectiveTheme: 'dark' })
  })

  it('broadcasts live Windows appearance changes only while following system', () => {
    const nativeTheme = new FakeNativeTheme()
    const onChanged = vi.fn()
    const service = new NativeAppearanceService(nativeTheme, 'system', onChanged)
    service.start()

    nativeTheme.setSystemDark(true)
    expect(onChanged).toHaveBeenLastCalledWith({ themeMode: 'system', effectiveTheme: 'dark' })

    service.setThemeMode('light')
    nativeTheme.setSystemDark(false)
    expect(onChanged).toHaveBeenLastCalledWith({ themeMode: 'light', effectiveTheme: 'light' })

    service.dispose()
    expect(nativeTheme.listeners.size).toBe(0)
  })
})
