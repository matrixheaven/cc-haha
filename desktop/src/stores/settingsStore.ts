import { create } from 'zustand'
import { settingsApi } from '../api/settings'
import { modelsApi } from '../api/models'
import type { PermissionMode, EffortLevel, ModelInfo, ThemeMode } from '../types/settings'
import type { Locale } from '../i18n'
import { useUIStore } from './uiStore'

const LOCALE_STORAGE_KEY = 'cc-haha-locale'

function getStoredLocale(): Locale {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY)
    if (stored === 'en' || stored === 'zh') return stored
  } catch { /* localStorage unavailable */ }
  return 'zh'
}

type SettingsStore = {
  permissionMode: PermissionMode
  currentModel: ModelInfo | null
  effortLevel: EffortLevel
  availableModels: ModelInfo[]
  activeProviderName: string | null
  locale: Locale
  theme: ThemeMode
  skipWebFetchPreflight: boolean
  remoteAccessEnabled: boolean
  remoteAccessHost: string
  remoteAccessPort: number
  remoteAccessHasPassword: boolean
  isLoading: boolean
  error: string | null

  fetchAll: () => Promise<void>
  setPermissionMode: (mode: PermissionMode) => Promise<void>
  setModel: (modelId: string) => Promise<void>
  setEffort: (level: EffortLevel) => Promise<void>
  setLocale: (locale: Locale) => void
  setTheme: (theme: ThemeMode) => Promise<void>
  setSkipWebFetchPreflight: (enabled: boolean) => Promise<void>
  setRemoteAccessEnabled: (enabled: boolean) => Promise<void>
  setRemoteAccessHost: (host: string) => Promise<void>
  setRemoteAccessPort: (port: number) => Promise<void>
  setRemoteAccessPassword: (password: string) => Promise<void>
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  permissionMode: 'default',
  currentModel: null,
  effortLevel: 'medium',
  availableModels: [],
  activeProviderName: null,
  locale: getStoredLocale(),
  theme: useUIStore.getState().theme,
  skipWebFetchPreflight: true,
  remoteAccessEnabled: false,
  remoteAccessHost: '0.0.0.0',
  remoteAccessPort: 8080,
  remoteAccessHasPassword: false,
  isLoading: false,
  error: null,

  fetchAll: async () => {
    set({ isLoading: true, error: null })
    try {
      const [{ mode }, modelsRes, { model }, { level }, userSettings, remoteAccess] = await Promise.all([
        settingsApi.getPermissionMode(),
        modelsApi.list(),
        modelsApi.getCurrent(),
        modelsApi.getEffort(),
        settingsApi.getUser(),
        settingsApi.getRemoteAccess(),
      ])
      const theme = userSettings.theme === 'dark' ? 'dark' : 'light'
      useUIStore.getState().setTheme(theme)
      set({
        permissionMode: mode,
        availableModels: modelsRes.models,
        activeProviderName: modelsRes.provider?.name ?? null,
        currentModel: model,
        effortLevel: level,
        theme,
        skipWebFetchPreflight: userSettings.skipWebFetchPreflight !== false,
        remoteAccessEnabled: remoteAccess.enabled,
        remoteAccessHost: remoteAccess.host || '0.0.0.0',
        remoteAccessPort: remoteAccess.port,
        remoteAccessHasPassword: remoteAccess.hasPassword,
        isLoading: false,
        error: null,
      })
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to load desktop settings'
      set({ isLoading: false, error: message })
      throw error
    }
  },

  setPermissionMode: async (mode) => {
    const prev = get().permissionMode
    set({ permissionMode: mode })
    try {
      await settingsApi.setPermissionMode(mode)
    } catch {
      set({ permissionMode: prev })
    }
  },

  setModel: async (modelId) => {
    await modelsApi.setCurrent(modelId)
    const { model } = await modelsApi.getCurrent()
    set({ currentModel: model })
  },

  setEffort: async (level) => {
    const prev = get().effortLevel
    set({ effortLevel: level })
    try {
      await modelsApi.setEffort(level)
    } catch {
      set({ effortLevel: prev })
    }
  },

  setLocale: (locale) => {
    set({ locale })
    try { localStorage.setItem(LOCALE_STORAGE_KEY, locale) } catch { /* noop */ }
  },

  setTheme: async (theme) => {
    const prev = get().theme
    set({ theme })
    useUIStore.getState().setTheme(theme)
    try {
      await settingsApi.updateUser({ theme })
    } catch {
      set({ theme: prev })
      useUIStore.getState().setTheme(prev)
    }
  },

  setSkipWebFetchPreflight: async (enabled) => {
    const prev = get().skipWebFetchPreflight
    set({ skipWebFetchPreflight: enabled })
    try {
      await settingsApi.updateUser({ skipWebFetchPreflight: enabled })
    } catch {
      set({ skipWebFetchPreflight: prev })
    }
  },

  setRemoteAccessEnabled: async (enabled) => {
    const prev = get().remoteAccessEnabled
    set({ remoteAccessEnabled: enabled })
    try {
      await settingsApi.updateRemoteAccess({ enabled })
    } catch {
      set({ remoteAccessEnabled: prev })
    }
  },

  setRemoteAccessHost: async (host) => {
    const prev = get().remoteAccessHost
    set({ remoteAccessHost: host })
    try {
      await settingsApi.updateRemoteAccess({ host })
    } catch {
      set({ remoteAccessHost: prev })
    }
  },

  setRemoteAccessPort: async (port) => {
    const prev = get().remoteAccessPort
    set({ remoteAccessPort: port })
    try {
      await settingsApi.updateRemoteAccess({ port })
    } catch {
      set({ remoteAccessPort: prev })
    }
  },

  setRemoteAccessPassword: async (password) => {
    try {
      await settingsApi.updateRemoteAccess({ password })
    } catch { /* noop */ }
  },
}))
