import type { DesktopApi } from './ipc'

declare global {
  interface Window {
    desktop: DesktopApi
  }
}

export {}
