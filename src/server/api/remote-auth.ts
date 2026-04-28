import { remoteAccessService } from '../services/remoteAccessService.js'

export async function handleRemoteAuthApi(req: Request, url: URL, segments: string[]): Promise<Response> {
  const resource = segments[2]

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
