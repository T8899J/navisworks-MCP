import { isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BrowserWindow, type IpcMainInvokeEvent } from 'electron'

export interface SenderTrustOptions {
  isPackaged: boolean
  rendererRoot: string
  devServerUrl?: string
}

function normalizeForComparison(value: string): string {
  const normalized = resolve(value)
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized
}

function isPathInside(childPath: string, parentPath: string): boolean {
  const child = normalizeForComparison(childPath)
  const parent = normalizeForComparison(parentPath)
  const result = relative(parent, child)
  return result === '' || (!result.startsWith('..') && !isAbsolute(result))
}

export function isTrustedRendererUrl(url: string, options: SenderTrustOptions): boolean {
  if (!url) return false

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }

  if (!options.isPackaged) {
    if (!options.devServerUrl) return false
    try {
      return parsed.origin === new URL(options.devServerUrl).origin
    } catch {
      return false
    }
  }

  if (parsed.protocol !== 'file:') return false
  try {
    return isPathInside(fileURLToPath(parsed), options.rendererRoot)
  } catch {
    return false
  }
}

export function validateSender(event: IpcMainInvokeEvent, options: SenderTrustOptions): boolean {
  if (event.sender.isDestroyed()) return false
  if (event.sender.getType() === 'webview') return false
  if (BrowserWindow.fromWebContents(event.sender) === null) return false

  const frame = event.senderFrame
  if (!frame || frame.parent !== null) return false
  return isTrustedRendererUrl(frame.url, options)
}
