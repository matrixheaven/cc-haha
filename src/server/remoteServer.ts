import * as path from 'path'
import { remoteAccessService, type RemoteAccessConfig } from './services/remoteAccessService.js'

let cachedConfig: RemoteAccessConfig | null = null
let activeServer: ReturnType<typeof Bun.serve> | null = null
let localApiUrl = ''

const NOT_BUILT_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Not Built</title><style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1a1a2e;color:#e0e0e0}code{background:#16213e;padding:2px 6px;border-radius:4px}</style></head><body><div><h2>Frontend not built</h2><p>Run: <code>cd desktop && bun run build</code></p><p>Then restart the remote server.</p></div></body></html>`

function verifyRemoteJwt(token: string): boolean {
  if (!cachedConfig) return false
  return remoteAccessService.verifyJwt(token, cachedConfig.jwtSecret) !== null
}

function checkRemoteJwt(req: Request): Response | null {
  const auth = req.headers.get('Authorization') || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
  if (!token || !verifyRemoteJwt(token)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return null
}

function resolveDistPath(): string | null {
  const buildPath = path.join(process.cwd(), 'desktop', 'dist')
  try {
    const buildFile = Bun.file(path.join(buildPath, 'index.html'))
    if (buildFile.size > 0) return buildPath
  } catch { /* fall through */ }

  const exeDir = path.dirname(process.argv[1] || process.cwd())
  const prodPath = path.join(exeDir, '..', 'Resources', 'dist')
  try {
    const prodFile = Bun.file(path.join(prodPath, 'index.html'))
    if (prodFile.size > 0) return prodPath
  } catch { /* fall through */ }

  return null
}

async function proxyToLocal(req: Request): Promise<Response> {
  const target = new URL(req.url)
  const localUrl = new URL(localApiUrl)
  target.host = localUrl.host
  target.protocol = localUrl.protocol

  const headers = new Headers(req.headers)
  headers.set('Host', localUrl.host)

  return fetch(target.toString(), {
    method: req.method,
    headers,
    body: req.body,
    // @ts-ignore Bun supports duplex
    duplex: 'half',
  })
}

/** Create the fetch handler for the remote Bun.serve instance. */
function createFetchHandler(distPath: string | null) {
  return async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)

    // 1. Health check — public, no JWT required
    if (url.pathname === '/health') {
      return proxyToLocal(req)
    }

    // 2. Auth endpoints — no JWT required
    if (url.pathname.startsWith('/api/auth/')) {
      return proxyToLocal(req)
    }

    // 3. OAuth callback — public
    if (url.pathname === '/callback') {
      return proxyToLocal(req)
    }

    // 4. API / Proxy — require JWT
    if (
      url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/proxy/')
    ) {
      const authError = checkRemoteJwt(req)
      if (authError) return authError
      return proxyToLocal(req)
    }

    // 5. WebSocket upgrade — require JWT via query param
    if (url.pathname.startsWith('/ws/') || url.pathname.startsWith('/sdk/')) {
      const token = url.searchParams.get('token')
      if (!token || !verifyRemoteJwt(token)) {
        return new Response('Unauthorized', { status: 401 })
      }
      return proxyToLocal(req)
    }

    // 6. If dist not built, show help page
    if (!distPath) {
      return new Response(NOT_BUILT_HTML, {
        status: 503,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    }

    // 7. Static files from dist/
    let filePath = path.join(distPath, url.pathname.slice(1))
    if (url.pathname === '/') {
      filePath = path.join(distPath, 'index.html')
    }
    try {
      const file = Bun.file(filePath)
      if (await file.exists()) {
        return new Response(file)
      }
    } catch { /* fall through */ }

    // 8. SPA fallback
    try {
      return new Response(Bun.file(path.join(distPath, 'index.html')))
    } catch {
      return new Response('Not Found', { status: 404 })
    }
  }
}

/** Start the remote server. If already running, stops the old one first. */
export async function startRemoteServer(localUrl: string, overrides?: { host?: string; port?: number }): Promise<{ stop: () => void } | null> {
  const config = await remoteAccessService.getConfig()

  if (overrides?.host) config.host = overrides.host
  if (overrides?.port) config.port = overrides.port

  if (!config.enabled) return null

  stopRemoteServer()

  cachedConfig = config
  localApiUrl = localUrl

  const host = config.host || '0.0.0.0'
  const port = config.port
  const distPath = resolveDistPath()

  if (!distPath) {
    console.warn('[Remote] Frontend not built. Run `cd desktop && bun run build` first.')
    console.warn('[Remote] Remote server will start but static files will not be served.')
  }

  activeServer = Bun.serve({
    port,
    hostname: host,
    fetch: createFetchHandler(distPath),
    websocket: { message() {}, open(ws) { ws.close() } },
  })

  console.log(`[Remote] Remote access server running at http://${host}:${port}`)
  return { stop: () => stopRemoteServer() }
}

/** Stop the currently active remote server. */
export function stopRemoteServer() {
  if (activeServer) {
    activeServer.stop()
    activeServer = null
    console.log('[Remote] Remote access server stopped')
  }
}

/** Restart the remote server with the latest config. Called after settings change. */
export async function restartRemoteServer(newLocalUrl?: string) {
  if (newLocalUrl) localApiUrl = newLocalUrl

  const config = await remoteAccessService.getConfig()

  stopRemoteServer()

  if (!config.enabled) return

  cachedConfig = config
  const host = config.host || '0.0.0.0'
  const port = config.port
  const distPath = resolveDistPath()

  if (!distPath) {
    console.warn('[Remote] Frontend not built. Run `cd desktop && bun run build` first.')
  }

  activeServer = Bun.serve({
    port,
    hostname: host,
    fetch: createFetchHandler(distPath),
    websocket: { message() {}, open(ws) { ws.close() } },
  })

  console.log(`[Remote] Remote access server restarted at http://${host}:${port}`)
}

export function isRemoteServerRunning(): boolean {
  return activeServer !== null
}
