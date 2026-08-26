import { type BrowserWindow, type Session } from 'electron'

import { isTrustedRendererUrl, type SenderTrustOptions } from './validateSender'

export function denyAllPermissions(electronSession: Session): () => void {
  const onWillDownload = (event: Electron.Event): void => event.preventDefault()
  electronSession.setPermissionCheckHandler(() => false)
  electronSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  electronSession.on('will-download', onWillDownload)

  return () => {
    electronSession.setPermissionCheckHandler(null)
    electronSession.setPermissionRequestHandler(null)
    electronSession.removeListener('will-download', onWillDownload)
  }
}

export function secureWindowNavigation(window: BrowserWindow, trust: SenderTrustOptions): () => void {
  const onWillNavigate = (event: Electron.Event, url: string): void => {
    if (!isTrustedRendererUrl(url, trust)) event.preventDefault()
  }
  const onWillAttachWebview = (event: Electron.Event): void => event.preventDefault()

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', onWillNavigate)
  window.webContents.on('will-attach-webview', onWillAttachWebview)

  return () => {
    if (window.isDestroyed()) return
    window.webContents.removeListener('will-navigate', onWillNavigate)
    window.webContents.removeListener('will-attach-webview', onWillAttachWebview)
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  }
}

export function installProductionContentSecurityPolicy(window: BrowserWindow): () => void {
  const webRequest = window.webContents.session.webRequest
  const filter = { urls: ['file://*/*'] }
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
    "form-action 'none'"
  ].join('; ')

  webRequest.onHeadersReceived(filter, (details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy]
      }
    })
  })

  return () => webRequest.onHeadersReceived(null)
}
