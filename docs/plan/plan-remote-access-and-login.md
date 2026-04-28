# Handoff Plan：桌面端远程访问 + 前端登录认证

## 任务摘要

为 Claude Code Haha 桌面端（Tauri + Bun sidecar）增加**局域网远程访问**能力，并配套**前端登录页面**防止未授权访问。实现后，用户可在 Settings 中开启远程访问，手机/其他电脑通过浏览器访问桌面端主机 IP 即可编写代码。

---

## 背景

当前桌面端前端直接内嵌在 Tauri WebView 中，无登录流程。Sidecar 服务器仅绑定 `127.0.0.1:<随机端口>`，仅供本地 WebView 使用。当用户希望编译为 DMG/EXE 后让局域网内其他设备访问时，需要：
1. 一个暴露在 `0.0.0.0` 的远程入口端口
2. 该入口 serve 前端静态文件并代理 API/WebSocket
3. 强制登录认证，防止未授权访问

---

## 架构设计

### 三轨端口制

| 模式 | 绑定地址 | 用途 | 认证 |
|------|----------|------|------|
| **本地 API** | `127.0.0.1:<随机端口>` | Tauri WebView ↔ Sidecar | 无 |
| **开发前端** | `localhost:1420` | Vite dev server | 无 |
| **远程访问** | `0.0.0.0:<用户配置端口>` | 局域网浏览器访问 | **强制 JWT** |

### 远程服务器职责

由 Sidecar（Bun/TypeScript 层）在独立端口额外启动一个 `Bun.serve` 实例：
1. **Serve 静态文件**：`dist/` 目录下的前端产物
2. **反向代理 API**：`/api/*`, `/proxy/*`, `/health` → 本地 API 服务器
3. **WebSocket 透传**：`/ws/*`, `/sdk/*` → 本地 API 服务器
4. **SPA Fallback**：所有未匹配路径返回 `index.html`

### 认证流程

```
首次开启远程访问
    → Sidecar 生成随机 8 位密码
    → 用户可在 Settings 查看/重置
    → 密码经 PBKDF2 加盐哈希后存于 ~/.claude/cc-haha/remote-auth.json

远程设备访问
    → 浏览器打开 http://<ip>:<port>
    → 前端检测到 hostname ≠ 127.0.0.1/localhost，渲染 LoginPage
    → 输入密码 → POST /api/auth/remote-login
    → 后端验证密码 → 签发 7 天有效期 JWT → 返回前端
    → 前端存入 localStorage → 后续请求自动携带 Bearer Token
```

---

## 关键文件表

### Phase 1：远程访问基础设施

| 文件路径 | 角色 | 操作 |
|----------|------|------|
| `src/server/remoteServer.ts` | **新增** | 远程 Bun.serve 实现（静态文件 + API 代理 + WS 透传） |
| `src/server/services/remoteAccessService.ts` | **新增** | 远程访问配置管理（读/写端口、密码哈希、启用状态） |
| `src/server/api/remote-auth.ts` | **新增** | `/api/auth/remote-login` 和 `/api/auth/remote-status` handler |
| `src/server/middleware/remoteAuth.ts` | **新增** | JWT 验证中间件，用于远程服务器代理层 |
| `src/server/index.ts` | **修改** | 启动完成后，如配置启用则启动远程服务器 |
| `src/server/router.ts` | **修改** | 添加 `auth` resource 路由 |
| `src/server/api/settings.ts` | **修改** | 添加远程访问设置读写（端口、启用状态） |
| `sidecars/claude-sidecar.ts` | **修改** | 解析 `--remote-access-port` 参数并透传 |
| `desktop/src-tauri/tauri.conf.json` | **修改** | `bundle.resources` 加入 `../dist` 使静态文件可访问 |
| `desktop/src/api/settings.ts` | **修改** | 添加远程访问 API 封装 |
| `desktop/src/stores/settingsStore.ts` | **修改** | 添加远程访问状态字段 |
| `desktop/src/pages/Settings.tsx` | **修改** | 新增「远程访问」SettingsTab 面板 |
| `desktop/src/i18n/locales/zh.ts` | **修改** | 添加远程访问相关中文翻译 |
| `desktop/src/i18n/locales/en.ts` | **修改** | 添加远程访问相关英文翻译 |

### Phase 2：前端登录认证

| 文件路径 | 角色 | 操作 |
|----------|------|------|
| `desktop/src/pages/LoginPage.tsx` | **新增** | 远程访问登录页面 |
| `desktop/src/stores/authStore.ts` | **新增** | 认证状态管理（JWT、登录/登出） |
| `desktop/src/api/client.ts` | **修改** | 请求时自动携带 localStorage 中的 JWT |
| `desktop/src/components/layout/AppShell.tsx` | **修改** | 远程未登录时渲染 LoginPage |
| `desktop/src/components/layout/ContentRouter.tsx` | **修改** | 无需修改（AppShell 层拦截） |
| `desktop/vite.config.ts` | **修改** | 添加 `dev:remote` 脚本所需的 proxy 配置 |
| `desktop/package.json` | **修改** | 添加 `dev:remote` 脚本 |

---

## Phase 1：远程访问端口 — 代码上下文与实现步骤

### 1.1 远程配置服务（新增）

**文件**：`src/server/services/remoteAccessService.ts`

```typescript
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { createHash, randomBytes, pbkdf2Sync } from 'node:crypto'

const CONFIG_DIR = path.join(os.homedir(), '.claude', 'cc-haha')
const AUTH_FILE = path.join(CONFIG_DIR, 'remote-auth.json')

export interface RemoteAccessConfig {
  enabled: boolean
  port: number
  passwordHash: string | null  // pbkdf2 hash: "salt:derivedKey"
  jwtSecret: string
}

export class RemoteAccessService {
  private configCache: RemoteAccessConfig | null = null

  private getDefaultConfig(): RemoteAccessConfig {
    return {
      enabled: false,
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

import { createHmac } from 'node:crypto'
export const remoteAccessService = new RemoteAccessService()
```

### 1.2 远程认证 API（新增）

**文件**：`src/server/api/remote-auth.ts`

```typescript
import { remoteAccessService } from '../services/remoteAccessService.js'

export async function handleRemoteAuthApi(req: Request, url: URL, segments: string[]): Promise<Response> {
  const resource = segments[2] // 'remote-login' | 'remote-status'

  if (resource === 'remote-status') {
    const config = await remoteAccessService.getConfig()
    return Response.json({
      enabled: config.enabled,
      port: config.port,
      hasPassword: !!config.passwordHash,
    })
  }

  if (resource === 'remote-login') {
    if (req.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 })
    }
    const { password } = await req.json().catch(() => ({}))
    if (typeof password !== 'string') {
      return Response.json({ error: 'Password required' }, { status: 400 })
    }
    const config = await remoteAccessService.getConfig()
    if (!config.passwordHash) {
      return Response.json({ error: 'Remote access not configured' }, { status: 403 })
    }
    if (!remoteAccessService.verifyPassword(password, config.passwordHash)) {
      return Response.json({ error: 'Invalid password' }, { status: 401 })
    }
    const token = remoteAccessService.generateJwt(
      { sub: 'remote-user', exp: Math.floor(Date.now() / 1000) + 7 * 24 * 3600 },
      config.jwtSecret,
    )
    return Response.json({ token, expiresIn: 7 * 24 * 3600 })
  }

  return Response.json({ error: 'Not found' }, { status: 404 })
}
```

### 1.3 远程服务器（新增）

**文件**：`src/server/remoteServer.ts`

```typescript
import { remoteAccessService } from './services/remoteAccessService.js'

export async function startRemoteServer(localApiUrl: string): Promise<{ stop: () => void } | null> {
  const config = await remoteAccessService.getConfig()
  if (!config.enabled) return null

  const port = config.port
  const distPath = resolveDistPath()

  const server = Bun.serve({
    port,
    hostname: '0.0.0.0',

    async fetch(req) {
      const url = new URL(req.url)

      // 1. Auth endpoints — handled by local API router
      if (url.pathname.startsWith('/api/auth/')) {
        return proxyToLocal(req, localApiUrl)
      }

      // 2. API / Proxy / Health / Callback — require JWT
      if (
        url.pathname.startsWith('/api/') ||
        url.pathname.startsWith('/proxy/') ||
        url.pathname === '/health' ||
        url.pathname === '/callback'
      ) {
        const authError = checkRemoteJwt(req)
        if (authError) return authError
        return proxyToLocal(req, localApiUrl)
      }

      // 3. WebSocket upgrade — require JWT via query param
      if (url.pathname.startsWith('/ws/') || url.pathname.startsWith('/sdk/')) {
        const token = url.searchParams.get('token')
        if (!token || !verifyRemoteJwt(token)) {
          return new Response('Unauthorized', { status: 401 })
        }
        return proxyToLocal(req, localApiUrl)
      }

      // 4. Static files from dist/
      let filePath = path.join(distPath, url.pathname)
      if (url.pathname === '/') {
        filePath = path.join(distPath, 'index.html')
      }
      const file = Bun.file(filePath)
      if (await file.exists()) {
        return new Response(file)
      }

      // 5. SPA fallback
      return new Response(Bun.file(path.join(distPath, 'index.html')))
    },

    websocket: {
      // Bun.serve websocket proxy — upgrade requests are proxied above
      message() {},
      open(ws) { ws.close() },
    },
  })

  console.log(`[Remote] Remote access server running at http://0.0.0.0:${port}`)
  return { stop: () => server.stop() }
}

function resolveDistPath(): string {
  // Dev: relative to project root
  const devPath = path.join(process.cwd(), 'desktop', 'dist')
  if (Bun.file(path.join(devPath, 'index.html')).size > 0) return devPath

  // Prod: bundled alongside sidecar binary
  const exeDir = path.dirname(process.argv[1] || process.cwd())
  const prodPath = path.join(exeDir, '..', 'Resources', 'dist')
  if (Bun.file(path.join(prodPath, 'index.html')).size > 0) return prodPath

  // Fallback
  return devPath
}

async function proxyToLocal(req: Request, localApiUrl: string): Promise<Response> {
  const target = new URL(req.url)
  target.host = new URL(localApiUrl).host
  target.protocol = new URL(localApiUrl).protocol

  const headers = new Headers(req.headers)
  headers.set('Host', target.host)

  return fetch(target.toString(), {
    method: req.method,
    headers,
    body: req.body,
    // @ts-ignore Bun supports duplex
    duplex: 'half',
  })
}

function checkRemoteJwt(req: Request): Response | null {
  const auth = req.headers.get('Authorization') || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
  if (!token || !verifyRemoteJwt(token)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return null
}

function verifyRemoteJwt(token: string): boolean {
  const config = remoteAccessService.getConfigSync?.() // ⚠️ 需要添加同步读取方法，或在启动时缓存
  // 实际实现：在模块顶层缓存 config，启动 remote server 时传入
  return true // placeholder — 实际用 remoteAccessService.verifyJwt
}
```

> ⚠️ **注意**：`remoteServer.ts` 中的 `verifyRemoteJwt` 需要访问 `jwtSecret`。由于 `getConfig()` 是 async，建议在模块顶部维护一个 `let cachedConfig: RemoteAccessConfig | null = null`，在 `startRemoteServer` 时初始化，然后同步读取。

### 1.4 修改本地服务器启动逻辑

**文件**：`src/server/index.ts`（行 48–231）

在 `startServer` 函数末尾（行 229 `return server` 之前）添加远程服务器启动：

```typescript
  // 启动远程访问服务器（如果配置启用）
  const localUrl = `http://${localConnectHost}:${port}`
  import('./remoteServer.js').then(({ startRemoteServer }) => {
    startRemoteServer(localUrl).catch((err) => {
      console.error('[Remote] Failed to start remote server:', err)
    })
  })
```

### 1.5 修改路由表

**文件**：`src/server/router.ts`（行 28–31）

在 `switch (resource)` 之前添加：

```typescript
  switch (resource) {
    case 'auth':
      return handleRemoteAuthApi(req, url, segments)
```

并在文件顶部 import：

```typescript
import { handleRemoteAuthApi } from './api/remote-auth.js'
```

### 1.6 Sidecar 参数透传

**文件**：`sidecars/claude-sidecar.ts`（行 42–44）

当前 `server` 模式直接调用 `startServer()`，无需额外参数（远程配置从文件读取）。但如果需要通过 CLI 强制指定远程端口用于测试，可在 `parseLauncherArgs` 中保留 `--remote-access-port`。

当前无需修改 sidecar，因为远程配置通过 `remoteAccessService` 从文件读取。

### 1.7 Tauri 资源配置

**文件**：`desktop/src-tauri/tauri.conf.json`（行 41–53）

在 `bundle` 对象中添加 `resources`：

```json
  "bundle": {
    "resources": [
      "../dist"
    ],
```

这样生产打包时 `desktop/dist/` 会被复制到 `.app/Contents/Resources/dist/`。

### 1.8 后端 Settings API 扩展

**文件**：`src/server/api/settings.ts`

在 `handleSettingsApi` 的 `switch (sub)` 中添加：

```typescript
      case 'remote-access':
        return await handleRemoteAccessSettings(req)
```

并添加 handler：

```typescript
async function handleRemoteAccessSettings(req: Request): Promise<Response> {
  if (req.method === 'GET') {
    const config = await remoteAccessService.getConfig()
    return Response.json({
      enabled: config.enabled,
      port: config.port,
      hasPassword: !!config.passwordHash,
    })
  }
  if (req.method === 'PUT') {
    const body = await parseJsonBody(req)
    if (typeof body.enabled === 'boolean') {
      await remoteAccessService.saveConfig({ enabled: body.enabled })
    }
    if (typeof body.port === 'number') {
      await remoteAccessService.saveConfig({ port: body.port })
    }
    if (typeof body.password === 'string') {
      const hash = remoteAccessService.hashPassword(body.password)
      await remoteAccessService.saveConfig({ passwordHash: hash })
    }
    // ⚠️ 配置变更后需要重启远程服务器。当前实现：用户重启应用生效。
    return Response.json({ ok: true })
  }
  throw methodNotAllowed(req.method)
}
```

### 1.9 前端 Settings Store 扩展

**文件**：`desktop/src/stores/settingsStore.ts`（行 18–37）

在 `SettingsStore` type 中添加：

```typescript
  remoteAccessEnabled: boolean
  remoteAccessPort: number
  remoteAccessHasPassword: boolean
  setRemoteAccessEnabled: (enabled: boolean) => Promise<void>
  setRemoteAccessPort: (port: number) => Promise<void>
  setRemoteAccessPassword: (password: string) => Promise<void>
```

在 `create` 的默认值中添加：

```typescript
  remoteAccessEnabled: false,
  remoteAccessPort: 8080,
  remoteAccessHasPassword: false,
```

在 `fetchAll` 中并行获取远程访问状态：

```typescript
      const [..., remoteAccessRes] = await Promise.all([
        ...,
        settingsApi.getRemoteAccess(),
      ])
      // ... 在 set() 中添加：
      remoteAccessEnabled: remoteAccessRes.enabled,
      remoteAccessPort: remoteAccessRes.port,
      remoteAccessHasPassword: remoteAccessRes.hasPassword,
```

并添加 action 方法（参考 `setSkipWebFetchPreflight` 的实现模式）。

### 1.10 前端 API 封装

**文件**：`desktop/src/api/settings.ts`（行 18–38）

添加：

```typescript
export type RemoteAccessStatus = {
  enabled: boolean
  port: number
  hasPassword: boolean
}

export const settingsApi = {
  // ... existing methods

  getRemoteAccess() {
    return api.get<RemoteAccessStatus>('/api/settings/remote-access')
  },

  updateRemoteAccess(body: Partial<{ enabled: boolean; port: number; password: string }>) {
    return api.put<{ ok: true }>('/api/settings/remote-access', body)
  },
}
```

### 1.11 Settings UI 新增「远程访问」面板

**文件**：`desktop/src/pages/Settings.tsx`

1. 在 `SettingsTab` type 的扩展（位于 `desktop/src/stores/uiStore.ts` 行 31–42）中添加 `'remoteAccess'`：

```typescript
export type SettingsTab =
  | 'providers'
  // ...
  | 'remoteAccess'
```

2. 在 Settings 左侧 tab 按钮列表（行 48–62）中添加：

```tsx
<TabButton icon="wifi" label={t('settings.tab.remoteAccess')} active={activeTab === 'remoteAccess'} onClick={() => setActiveTab('remoteAccess')} />
```

3. 在右侧内容区（行 66–78）中添加：

```tsx
{activeTab === 'remoteAccess' && <RemoteAccessSettings />}
```

4. 在文件底部（或单独文件）实现 `RemoteAccessSettings` 组件：

```tsx
function RemoteAccessSettings() {
  const { remoteAccessEnabled, remoteAccessPort, remoteAccessHasPassword, fetchAll } = useSettingsStore()
  const t = useTranslation()
  const [password, setPassword] = useState('')
  const [saving, setSaving] = useState(false)

  const handleToggle = async (enabled: boolean) => {
    setSaving(true)
    try {
      await settingsApi.updateRemoteAccess({ enabled })
      await fetchAll()
    } finally {
      setSaving(false)
    }
  }

  const handleSavePassword = async () => {
    if (!password.trim()) return
    setSaving(true)
    try {
      await settingsApi.updateRemoteAccess({ password: password.trim() })
      await fetchAll()
      setPassword('')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-xl">
      <h2 className="text-base font-semibold text-[var(--color-text-primary)] mb-1">{t('settings.remoteAccess.title')}</h2>
      <p className="text-sm text-[var(--color-text-tertiary)] mb-4">{t('settings.remoteAccess.description')}</p>

      {/* Enable toggle */}
      <label className="flex items-start gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-4 py-3 cursor-pointer hover:border-[var(--color-border-focus)] transition-colors mb-4">
        <input
          type="checkbox"
          checked={remoteAccessEnabled}
          onChange={(e) => void handleToggle(e.target.checked)}
          disabled={saving}
          className="mt-0.5 h-4 w-4 rounded border-[var(--color-border)] text-[var(--color-brand)] focus:ring-[var(--color-brand)]"
        />
        <div className="min-w-0">
          <div className="text-sm font-medium text-[var(--color-text-primary)]">{t('settings.remoteAccess.enable')}</div>
          <div className="text-xs text-[var(--color-text-tertiary)] mt-1">{t('settings.remoteAccess.enableHint')}</div>
        </div>
      </label>

      {/* Port setting */}
      {remoteAccessEnabled && (
        <div className="mb-4">
          <label className="text-sm font-medium text-[var(--color-text-primary)] mb-1 block">{t('settings.remoteAccess.port')}</label>
          <input
            type="number"
            value={remoteAccessPort}
            onChange={(e) => void settingsApi.updateRemoteAccess({ port: parseInt(e.target.value) || 8080 }).then(() => fetchAll())}
            className="w-32 text-sm px-3 py-2 rounded-[var(--radius-md)] bg-[var(--color-surface-container-low)] border border-[var(--color-border)] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-border-focus)]"
          />
          <p className="text-xs text-[var(--color-text-tertiary)] mt-1">{t('settings.remoteAccess.portHint')}</p>
        </div>
      )}

      {/* Password setting */}
      {remoteAccessEnabled && (
        <div className="mb-4">
          <label className="text-sm font-medium text-[var(--color-text-primary)] mb-1 block">
            {remoteAccessHasPassword ? t('settings.remoteAccess.resetPassword') : t('settings.remoteAccess.setPassword')}
          </label>
          <div className="flex gap-2">
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t('settings.remoteAccess.passwordPlaceholder')}
              className="flex-1 text-sm px-3 py-2 rounded-[var(--radius-md)] bg-[var(--color-surface-container-low)] border border-[var(--color-border)] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-border-focus)]"
            />
            <Button onClick={handleSavePassword} disabled={!password.trim() || saving} loading={saving}>
              {t('common.save')}
            </Button>
          </div>
          <p className="text-xs text-[var(--color-text-tertiary)] mt-1">{t('settings.remoteAccess.passwordHint')}</p>
        </div>
      )}

      {/* Status / URLs */}
      {remoteAccessEnabled && remoteAccessHasPassword && (
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-4 py-3">
          <div className="text-sm font-medium text-[var(--color-text-primary)] mb-1">{t('settings.remoteAccess.status')}</div>
          <div className="text-xs text-[var(--color-text-tertiary)]">
            {/* TODO: 显示局域网 IP 列表和 QR 码 */}
            {t('settings.remoteAccess.restartHint')}
          </div>
        </div>
      )}
    </div>
  )
}
```

### 1.12 翻译词条

**文件**：`desktop/src/i18n/locales/zh.ts`

在 Settings > General 之后添加：

```typescript
  // Settings > Remote Access
  'settings.tab.remoteAccess': '远程访问',
  'settings.remoteAccess.title': '远程访问',
  'settings.remoteAccess.description': '允许局域网内的其他设备通过浏览器访问此桌面端。',
  'settings.remoteAccess.enable': '启用远程访问',
  'settings.remoteAccess.enableHint': '开启后，同一网络下的手机或其他电脑可以访问此应用。',
  'settings.remoteAccess.port': '监听端口',
  'settings.remoteAccess.portHint': '默认 8080，修改后需要重启应用生效。',
  'settings.remoteAccess.setPassword': '设置访问密码',
  'settings.remoteAccess.resetPassword': '重置访问密码',
  'settings.remoteAccess.passwordPlaceholder': '输入至少 6 位密码',
  'settings.remoteAccess.passwordHint': '远程设备访问时需要输入此密码。',
  'settings.remoteAccess.status': '远程访问已启用',
  'settings.remoteAccess.restartHint': '配置变更后请重启应用以生效。',
```

**文件**：`desktop/src/i18n/locales/en.ts`

添加对应英文翻译。

---

## Phase 2：前端登录认证 — 代码上下文与实现步骤

### 2.1 认证状态管理（新增）

**文件**：`desktop/src/stores/authStore.ts`

```typescript
import { create } from 'zustand'

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

export const useAuthStore = create<AuthStore>((set, get) => ({
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

import { getBaseUrl } from '../api/client'
```

### 2.2 登录页面（新增）

**文件**：`desktop/src/pages/LoginPage.tsx`

```tsx
import { useState } from 'react'
import { useAuthStore } from '../stores/authStore'
import { useTranslation } from '../i18n'

export function LoginPage() {
  const [password, setPassword] = useState('')
  const { login, isLoading, error } = useAuthStore()
  const t = useTranslation()

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!password.trim()) return
    void login(password.trim())
  }

  return (
    <div className="h-screen flex items-center justify-center bg-[var(--color-surface)]">
      <div className="w-full max-w-sm px-6">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-semibold text-[var(--color-text-primary)] mb-2">
            Claude Code Haha
          </h1>
          <p className="text-sm text-[var(--color-text-secondary)]">
            {t('login.subtitle')}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-[var(--color-text-primary)] mb-1">
              {t('login.password')}
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t('login.passwordPlaceholder')}
              autoFocus
              className="w-full text-sm px-3 py-2.5 rounded-[var(--radius-md)] bg-[var(--color-surface-container-low)] border border-[var(--color-border)] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-brand)] transition-colors"
            />
          </div>

          {error && (
            <div className="text-xs text-[var(--color-error)] bg-[var(--color-error)]/10 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={isLoading || !password.trim()}
            className="w-full py-2.5 text-sm font-semibold rounded-lg bg-[var(--color-brand)] text-white hover:bg-[var(--color-brand-hover)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isLoading ? t('common.loading') : t('login.submit')}
          </button>
        </form>
      </div>
    </div>
  )
}
```

### 2.3 API Client 自动携带 JWT

**文件**：`desktop/src/api/client.ts`（行 46–77）

在 `request` 函数的 headers 构建部分（行 48–50）修改为：

```typescript
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  // Auto-inject remote access JWT
  if (typeof window !== 'undefined') {
    const token = localStorage.getItem('cc-haha-remote-auth')
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }
  }
```

### 2.4 AppShell 登录拦截

**文件**：`desktop/src/components/layout/AppShell.tsx`（行 1–109）

1. 在 import 区域添加：

```typescript
import { useAuthStore, isRemoteAccess } from '../../stores/authStore'
import { LoginPage } from '../../pages/LoginPage'
```

2. 在组件内部（行 16）添加：

```typescript
  const { isLoggedIn, checkAuth } = useAuthStore()
```

3. 在 `useEffect` bootstrap 之前（或作为单独的 useEffect）添加认证检查：

```typescript
  useEffect(() => {
    checkAuth()
  }, [checkAuth])
```

4. 在 `if (!ready)` 返回之前（行 80），插入登录拦截：

```typescript
  if (isRemoteAccess() && !isLoggedIn) {
    return <LoginPage />
  }
```

### 2.5 WebSocket 携带 Token

**文件**：`desktop/src/api/websocket.ts`（行 42–43）

将 WebSocket URL 构建修改为携带 token：

```typescript
    const wsUrl = getBaseUrl().replace(/^http/, 'ws')
    const token = typeof window !== 'undefined' ? localStorage.getItem('cc-haha-remote-auth') : null
    const tokenQuery = token ? `?token=${encodeURIComponent(token)}` : ''
    const ws = new WebSocket(`${wsUrl}/ws/${sessionId}${tokenQuery}`)
```

### 2.6 开发阶段远程测试脚本

**文件**：`desktop/package.json`（行 6–17）

在 `scripts` 中添加：

```json
    "dev:remote": "vite --host 0.0.0.0 --port 1420",
```

**文件**：`desktop/vite.config.ts`（行 8–26）

在 `server` 配置中添加 proxy（仅开发时有效）：

```typescript
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3456',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://127.0.0.1:3456',
        ws: true,
        changeOrigin: true,
      },
      '/proxy': {
        target: 'http://127.0.0.1:3456',
        changeOrigin: true,
      },
      '/health': {
        target: 'http://127.0.0.1:3456',
        changeOrigin: true,
      },
    },
  },
```

> 开发时运行 `bun run dev:remote`，Vite 监听 `0.0.0.0:1420`，API 通过 proxy 到本地 sidecar。局域网设备访问 `http://<ip>:1420` 即可测试前端。注意：开发模式下认证中间件在 Vite proxy 之后，实际远程服务器的认证逻辑需要在生产 bundle 中验证。

---

## 副作用与风险

### 行为变更

1. **本地访问不受影响**：`isRemoteAccess()` 仅在 `hostname !== localhost/127.0.0.1` 时返回 true，本地 Tauri WebView 仍然直接进入应用。
2. **API Client 始终尝试读 JWT**：即使本地模式也会检查 `localStorage`，无性能影响，无功能影响。
3. **WebSocket URL 增加 token query**：本地模式下 token 为 null，不附加 query param，不影响现有逻辑。
4. **远程服务器启动失败不阻断本地服务**：`startRemoteServer` 是异步 fire-and-forget，本地 API 即使远程端口冲突也能正常启动。

### 需要同步更新的类比代码路径

1. **桌面端 adapter sidecar**：adapter 通过 `ADAPTER_SERVER_URL` env 连接本地 WebSocket。远程访问端口不服务于 adapter，无需修改。
2. **CSP 策略**：远程访问模式下前端运行在普通浏览器，Tauri 的 CSP 不生效。前端代码中的 `connect-src` 限制由浏览器自行管理，同源请求无问题。
3. **`getBaseUrl()` 在远程模式下的值**：远程服务器 serve 的前端与 API 是同源的（都走 `http://<ip>:8080`），`getBaseUrl()` 返回当前 origin 即可。当前 `client.ts` 的 `baseUrl` 在初始化时由 `initializeDesktopServerUrl()` 设置，远程模式下应被设为当前页面的 origin。

   ⚠️ **需要在 `desktopRuntime.ts` 中处理**：当检测到非 Tauri 且 hostname 非本地时，`setBaseUrl(window.location.origin)`。

### 安全注意事项

1. **密码存储**：使用 PBKDF2（100k 轮）+ 随机 salt，不存明文。
2. **JWT Secret**：自动生成 256-bit random，存于本地文件。不要 hardcode。
3. **HTTP 明文传输**：远程访问走 HTTP，密码和 JWT 在局域网内明文传输。计划在 UI 中提示用户：公网访问建议使用反向代理 + HTTPS。
4. **登录限速**：当前未实现 IP 级限速，后续可在 `remote-auth.ts` 中添加内存级 rate limiter。

---

## 测试策略

### 单元测试

1. **RemoteAccessService**：
   - `hashPassword` / `verifyPassword` 正向/负向验证
   - `generateJwt` / `verifyJwt` 过期/篡改检测
   - `getConfig` 读取默认值和已有配置

2. **前端 authStore**：
   - `isRemoteAccess()` 对不同 hostname 的判定
   - `login` 成功/失败状态流转
   - `checkAuth` 从 localStorage 恢复

### 集成测试

1. **本地模式不受影响**：
   ```bash
   cd desktop && bun run dev
   ```
   打开 `http://localhost:1420`，验证直接进入应用，无登录页。

2. **开发远程模式（前端测试）**：
   ```bash
   cd desktop && bun run dev:remote
   ```
   从另一台设备/虚拟机访问 `http://<host-ip>:1420`，验证显示登录页，输入正确密码后进入应用。

3. **生产远程模式（完整链路）**：
   ```bash
   cd desktop && bun run build && bun run build:sidecars
   cd ../ && SERVER_PORT=3456 bun run src/server/index.ts
   # 在另一个终端，手动触发远程服务器启动（或等后续完整 Tauri 测试）
   ```
   ⚠️ 完整 Tauri 打包后的远程测试需要实际 build DMG/EXE，建议在 CI 或本地打包后手动验证。

### 手动验证清单

- [ ] Settings 页面显示「远程访问」tab
- [ ] 开启远程访问、设置密码、保存成功
- [ ] 重启应用后远程端口可访问
- [ ] 未登录时访问远程地址显示登录页
- [ ] 错误密码显示错误提示
- [ ] 正确密码登录后进入应用
- [ ] 登录后 API 请求正常（可创建会话、发送消息）
- [ ] WebSocket 连接正常（实时消息推送）
- [ ] 本地 Tauri 模式仍然无需登录
- [ ] 登出后清除状态并返回登录页

---

## 验收标准

### Phase 1 完成标准

1. Settings 中新增「远程访问」面板，可启用/禁用、配置端口、设置密码。
2. 启用并设置密码后，Sidecar 在 `0.0.0.0:<port>` 启动远程服务器。
3. 远程服务器能正确 serve `dist/` 静态文件。
4. 远程服务器能将 API/WebSocket/Proxy 请求转发到本地 API。
5. 未认证的 API 请求返回 401。

### Phase 2 完成标准

1. 通过远程地址访问时，前端显示登录页面（非 127.0.0.1/localhost）。
2. 登录成功后，前端所有 API 请求自动携带 JWT。
3. WebSocket 连接自动携带 token query param。
4. JWT 过期后（7 天），用户需要重新登录。
5. 本地 Tauri WebView 访问完全不受影响，无需登录。
6. 开发阶段可通过 `bun run dev:remote` 模拟远程访问环境。

---

## 实现顺序建议

按以下顺序实现，每一步都可独立测试：

1. **Backend**：`remoteAccessService.ts` + `remote-auth.ts` + `remoteServer.ts`（骨架）
2. **Backend**：`index.ts` 集成远程服务器启动
3. **Backend**：Settings API 扩展 + 路由表扩展
4. **Frontend**：Settings UI + Store + API 封装 + 翻译
5. **Test**：验证远程服务器可启动、静态文件可访问、API 代理正常
6. **Frontend**：`authStore.ts` + `LoginPage.tsx`
7. **Frontend**：`AppShell.tsx` 集成登录拦截 + `client.ts` JWT 注入
8. **Frontend**：`websocket.ts` token 注入
9. **Frontend**：`dev:remote` 脚本 + Vite proxy 配置
10. **End-to-end**：完整手动验证

---

## 附：文件绝对路径速查

| 相对路径 | 绝对路径 |
|----------|----------|
| `src/server/remoteServer.ts` | `/Users/chenyuanhao/Workspace/cc-haha/src/server/remoteServer.ts` |
| `src/server/services/remoteAccessService.ts` | `/Users/chenyuanhao/Workspace/cc-haha/src/server/services/remoteAccessService.ts` |
| `src/server/api/remote-auth.ts` | `/Users/chenyuanhao/Workspace/cc-haha/src/server/api/remote-auth.ts` |
| `src/server/middleware/remoteAuth.ts` | `/Users/chenyuanhao/Workspace/cc-haha/src/server/middleware/remoteAuth.ts` |
| `src/server/index.ts` | `/Users/chenyuanhao/Workspace/cc-haha/src/server/index.ts` |
| `src/server/router.ts` | `/Users/chenyuanhao/Workspace/cc-haha/src/server/router.ts` |
| `src/server/api/settings.ts` | `/Users/chenyuanhao/Workspace/cc-haha/src/server/api/settings.ts` |
| `sidecars/claude-sidecar.ts` | `/Users/chenyuanhao/Workspace/cc-haha/desktop/sidecars/claude-sidecar.ts` |
| `desktop/src-tauri/tauri.conf.json` | `/Users/chenyuanhao/Workspace/cc-haha/desktop/src-tauri/tauri.conf.json` |
| `desktop/src/api/client.ts` | `/Users/chenyuanhao/Workspace/cc-haha/desktop/src/api/client.ts` |
| `desktop/src/api/settings.ts` | `/Users/chenyuanhao/Workspace/cc-haha/desktop/src/api/settings.ts` |
| `desktop/src/api/websocket.ts` | `/Users/chenyuanhao/Workspace/cc-haha/desktop/src/api/websocket.ts` |
| `desktop/src/stores/settingsStore.ts` | `/Users/chenyuanhao/Workspace/cc-haha/desktop/src/stores/settingsStore.ts` |
| `desktop/src/stores/authStore.ts` | `/Users/chenyuanhao/Workspace/cc-haha/desktop/src/stores/authStore.ts` |
| `desktop/src/components/layout/AppShell.tsx` | `/Users/chenyuanhao/Workspace/cc-haha/desktop/src/components/layout/AppShell.tsx` |
| `desktop/src/pages/LoginPage.tsx` | `/Users/chenyuanhao/Workspace/cc-haha/desktop/src/pages/LoginPage.tsx` |
| `desktop/src/pages/Settings.tsx` | `/Users/chenyuanhao/Workspace/cc-haha/desktop/src/pages/Settings.tsx` |
| `desktop/src/i18n/locales/zh.ts` | `/Users/chenyuanhao/Workspace/cc-haha/desktop/src/i18n/locales/zh.ts` |
| `desktop/src/i18n/locales/en.ts` | `/Users/chenyuanhao/Workspace/cc-haha/desktop/src/i18n/locales/en.ts` |
| `desktop/vite.config.ts` | `/Users/chenyuanhao/Workspace/cc-haha/desktop/vite.config.ts` |
| `desktop/package.json` | `/Users/chenyuanhao/Workspace/cc-haha/desktop/package.json` |
