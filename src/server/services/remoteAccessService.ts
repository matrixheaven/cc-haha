import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { randomBytes, pbkdf2Sync, createHmac } from 'node:crypto'

const CONFIG_DIR = path.join(os.homedir(), '.claude', 'cc-haha')
const AUTH_FILE = path.join(CONFIG_DIR, 'remote-auth.json')

export interface RemoteAccessConfig {
  enabled: boolean
  host: string
  port: number
  passwordHash: string | null
  jwtSecret: string
}

class RemoteAccessService {
  private configCache: RemoteAccessConfig | null = null

  private getDefaultConfig(): RemoteAccessConfig {
    return {
      enabled: false,
      host: '0.0.0.0',
      port: 8080,
      passwordHash: null,
      jwtSecret: randomBytes(32).toString('base64'),
    }
  }

  async getConfig(): Promise<RemoteAccessConfig> {
    if (this.configCache) return this.configCache
    try {
      const raw = await fs.readFile(AUTH_FILE, 'utf-8')
      const parsed = JSON.parse(raw)
      this.configCache = { ...this.getDefaultConfig(), ...parsed }
      return this.configCache
    } catch {
      this.configCache = this.getDefaultConfig()
      return this.configCache
    }
  }

  /** Synchronous config access — call after getConfig() has initialized the cache */
  getConfigSync(): RemoteAccessConfig | null {
    return this.configCache
  }

  async saveConfig(partial: Partial<RemoteAccessConfig>): Promise<void> {
    const current = await this.getConfig()
    const merged = { ...current, ...partial }
    await fs.mkdir(CONFIG_DIR, { recursive: true })
    await fs.writeFile(AUTH_FILE, JSON.stringify(merged, null, 2) + '\n')
    this.configCache = merged
  }

  hashPassword(password: string): string {
    const salt = randomBytes(16).toString('hex')
    const key = pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('hex')
    return `${salt}:${key}`
  }

  verifyPassword(password: string, hash: string): boolean {
    const [salt, key] = hash.split(':')
    if (!salt || !key) return false
    const derived = pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('hex')
    return derived === key
  }

  generateJwt(payload: { sub: string; exp: number }, secret: string): string {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const signature = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url')
    return `${header}.${body}.${signature}`
  }

  verifyJwt(token: string, secret: string): { sub: string; exp: number } | null {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const [header, body, signature] = parts
    const expected = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url')
    if (signature !== expected) return null
    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString())
      if (payload.exp < Date.now() / 1000) return null
      return payload
    } catch {
      return null
    }
  }
}

export const remoteAccessService = new RemoteAccessService()
