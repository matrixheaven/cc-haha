import { create } from 'zustand'
import { getBaseUrl } from '../api/client'

const AUTH_STORAGE_KEY = 'cc-haha-remote-auth'

function getStoredToken(): string | null {
  try { return localStorage.getItem(AUTH_STORAGE_KEY) } catch { return null }
}

function setStoredToken(token: string | null) {
  try {
    if (token) localStorage.setItem(AUTH_STORAGE_KEY, token)
    else localStorage.removeItem(AUTH_STORAGE_KEY)
  } catch { /* noop */ }
}

export function isRemoteAccess(): boolean {
  if (typeof window === 'undefined') return false
  const host = window.location.hostname
  return host !== 'localhost' && host !== '127.0.0.1'
}

type AuthStore = {
  token: string | null
  isLoggedIn: boolean
  isLoading: boolean
  error: string | null
  login: (password: string) => Promise<void>
  logout: () => void
  checkAuth: () => void
}

export const useAuthStore = create<AuthStore>((set) => ({
  token: getStoredToken(),
  isLoggedIn: !!getStoredToken(),
  isLoading: false,
  error: null,

  login: async (password) => {
    set({ isLoading: true, error: null })
    try {
      const res = await fetch(`${getBaseUrl()}/api/auth/remote-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.error || 'Login failed')
      }
      setStoredToken(data.token)
      set({ token: data.token, isLoggedIn: true, isLoading: false })
    } catch (error) {
      set({ isLoading: false, error: error instanceof Error ? error.message : 'Login failed' })
    }
  },

  logout: () => {
    setStoredToken(null)
    set({ token: null, isLoggedIn: false, error: null })
    window.location.reload()
  },

  checkAuth: () => {
    const token = getStoredToken()
    set({ token, isLoggedIn: !!token })
  },
}))
