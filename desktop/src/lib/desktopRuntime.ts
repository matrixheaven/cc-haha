import { getDefaultBaseUrl, setBaseUrl } from '../api/client'

export function isTauriRuntime() {
  if (typeof window === 'undefined') return false
  return '__TAURI_INTERNALS__' in window || '__TAURI__' in window
}

/** Synchronously initialize the server URL. Returns immediately. */
export function initializeDesktopServerUrl() {
  if (isTauriRuntime()) {
    // Tauri runtime: URL set by invoke() — defer to the existing async flow
    return
  }

  if (typeof window === 'undefined') return

  const queryUrl = new URLSearchParams(window.location.search).get('serverUrl')?.trim()
  const host = window.location.hostname

  // Remote access mode: API is on the same origin as the page
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]') {
    setBaseUrl(window.location.origin)
    return
  }

  // Local dev: use the query param or the default
  setBaseUrl(queryUrl || getDefaultBaseUrl())
}

// Separate async bootstrap for Tauri (needs invoke)
export async function initializeDesktopServerUrlAsync() {
  const fallbackUrl = getDefaultBaseUrl()

  if (!isTauriRuntime()) {
    initializeDesktopServerUrl()
    return
  }

  try {
    const { invoke } = await import(/* @vite-ignore */ '@tauri-apps/api/core')
    const serverUrl = await invoke<string>('get_server_url')
    setBaseUrl(serverUrl)
  } catch (error) {
    const message =
      error instanceof Error ? error.message : `desktop server startup failed: ${String(error)}`
    console.error('[desktop] Failed to initialize desktop server URL', error)
    throw new Error(message || `desktop server startup failed (fallback would be ${fallbackUrl})`)
  }
}
