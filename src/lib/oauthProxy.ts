/**
 * OAuth 2.0 proxy routes for the bridge.
 *
 * These routes proxy OAuth endpoints to the upstream authorization server:
 *  - GET  /authorize  → Redirect to upstream (preserves query params)
 *  - POST /token      → Proxy to upstream
 *  - GET  /jwks       → Proxy JWKS for token verification
 *
 * This separation allows the bridge to advertise itself as the authorization
 * server while delegating actual auth operations to the upstream issuer.
 */

import { Router, type Request, type Response } from 'express'
import type { AuthConfig, Logger } from '../types.js'

export function createOAuthProxyRouter(auth: AuthConfig, logger: Logger): Router {
  const router = Router()

  /**
   * OAuth Authorization Endpoint — Redirect to upstream
   *
   * Since the bridge advertises itself as the authorization_server,
   * clients will attempt to call /authorize here. We redirect
   * to the upstream auth server, preserving all query parameters.
   */
  router.get('/authorize', (req: Request, res: Response) => {
    const upstreamUrl = new URL(`${auth.issuer}/oauth/authorize`)
    // Copy all query params to upstream
    for (const [key, value] of Object.entries(req.query)) {
      if (typeof value === 'string') {
        upstreamUrl.searchParams.set(key, value)
      }
    }
    logger.info(`[oauth-proxy] Redirecting /authorize to upstream`)
    res.redirect(upstreamUrl.toString())
  })

  /**
   * OAuth Token Endpoint — Proxy to upstream
   *
   * Proxies token exchange requests to the upstream auth server.
   */
  router.post('/token', async (req: Request, res: Response) => {
    try {
      const upstreamUrl = `${auth.issuer}/oauth/token`
      logger.info('[oauth-proxy] Proxying /token to upstream')

      const upstreamRes = await fetch(upstreamUrl, {
        method: 'POST',
        headers: {
          'Content-Type': req.get('Content-Type') || 'application/x-www-form-urlencoded',
        },
        body: req.get('Content-Type')?.includes('application/json')
          ? JSON.stringify(req.body)
          : new URLSearchParams(req.body as Record<string, string>).toString(),
      })

      const data = await upstreamRes.text()
      res.status(upstreamRes.status)
      res.set('Content-Type', upstreamRes.headers.get('Content-Type') || 'application/json')
      res.send(data)
    } catch (err: any) {
      logger.error('[oauth-proxy] Error proxying /token:', err.message ?? err)
      res.status(502).json({ error: 'upstream_error' })
    }
  })

  /**
   * JWKS Endpoint — Proxy to upstream
   *
   * Proxies JSON Web Key Set requests for token verification.
   */
  router.get('/jwks', async (_req: Request, res: Response) => {
    try {
      const upstreamUrl = `${auth.issuer}/jwks`
      const upstreamRes = await fetch(upstreamUrl)
      const data = await upstreamRes.json()
      res.json(data)
    } catch (err: any) {
      logger.error('[oauth-proxy] Error proxying /jwks:', err.message ?? err)
      res.status(502).json({ error: 'upstream_error' })
    }
  })

  return router
}
