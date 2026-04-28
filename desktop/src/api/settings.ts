import { api } from './client'
import type { PermissionMode, UserSettings } from '../types/settings'

export type CliLauncherStatus = {
  supported: boolean
  command: string
  installed: boolean
  launcherPath: string
  binDir: string
  pathConfigured: boolean
  pathInCurrentShell: boolean
  availableInNewTerminals: boolean
  needsTerminalRestart: boolean
  configTarget: string | null
  lastError: string | null
}

export type RemoteAccessStatus = {
  enabled: boolean
  host: string
  port: number
  hasPassword: boolean
}

export const settingsApi = {
  getUser() {
    return api.get<UserSettings>('/api/settings/user')
  },

  updateUser(settings: Partial<UserSettings>) {
    return api.put<{ ok: true }>('/api/settings/user', settings)
  },

  getPermissionMode() {
    return api.get<{ mode: PermissionMode }>('/api/permissions/mode')
  },

  setPermissionMode(mode: PermissionMode) {
    return api.put<{ ok: true; mode: PermissionMode }>('/api/permissions/mode', { mode })
  },

  getCliLauncherStatus() {
    return api.get<CliLauncherStatus>('/api/settings/cli-launcher')
  },

  getRemoteAccess() {
    return api.get<RemoteAccessStatus>('/api/settings/remote-access')
  },

  updateRemoteAccess(body: Partial<{ enabled: boolean; host: string; port: number; password: string }>) {
    return api.put<{ ok: true }>('/api/settings/remote-access', body)
  },
}
