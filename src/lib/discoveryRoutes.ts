/**
 * OAuth 2.0 discovery endpoints for the bridge.
 *
 * When auth is enabled these routes expose:
 *  - GET  /.well-known/oauth-protected-resource[/*]  (RFC 9728)
 *  - GET  /.well-known/oauth-authorization-server[/*] (RFC 8414 — proxied from issuer)
 *  - POST /register                                   (Pseudo-DCR — RFC 7591)
 *
 * These endpoints are unauthenticated — they must be accessible to
 * any client performing OAuth discovery before obtaining a token.
 */

import { Router, type Request, type Response } from 'express'
import type { AuthConfig, Logger } from '../types.js'

export function createDiscoveryRouter(auth: AuthConfig, logger: Logger): Router {
  const router = Router()

  /**
   * RFC 9728 — OAuth Protected Resource Metadata
   *
   * Tells the client:
   *  - which authorization server protects this resource
   *  - which scopes are available
   *  - where to find the authorization server metadata
   *
   * Handles both root and path-suffixed variants (e.g. /.well-known/oauth-protected-resource/mcp)
   * as required by the MCP SDK for path-based resource discovery.
   *
   * The `resource` field MUST match the URL the client is accessing (RFC 9728 §2).
   * For path-suffixed requests like /.well-known/oauth-protected-resource/mcp,
   * the resource is the path after the well-known prefix.
   *
   * IMPORTANT: We advertise the BRIDGE as the authorization_server (not the upstream issuer).
   * This ensures clients use our proxied AS metadata (which patches registration_endpoint),
   * rather than going directly to the upstream auth server's DCR endpoint.
   */
  router.get('/.well-known/oauth-protected-resource', (req: Request, res: Response) => {
    // Exact match — client is looking for the root resource
    // Return /mcp as that's our protected endpoint
    const scheme = req.protocol
    const host = req.get('host')
    const bridgeOrigin = `${scheme}://${host}`
    const resourceMetadata = {
      resource: `${bridgeOrigin}/mcp`,
      // Point to OURSELVES so clients use our proxied AS metadata
      authorization_servers: [bridgeOrigin],
      scopes_supported: ['openid', 'profile', 'email'],
      bearer_methods_supported: ['header'],
    }
    res.json(resourceMetadata)
  })

  router.get('/.well-known/oauth-protected-resource/*', (req: Request, res: Response) => {
    // Path-suffixed request — the suffix IS the protected resource path
    const scheme = req.protocol
    const host = req.get('host')
    const bridgeOrigin = `${scheme}://${host}`
    const resourcePath = '/' + req.params[0]
    const resourceMetadata = {
      resource: `${bridgeOrigin}${resourcePath}`,
      // Point to OURSELVES so clients use our proxied AS metadata
      authorization_servers: [bridgeOrigin],
      scopes_supported: ['openid', 'profile', 'email'],
      bearer_methods_supported: ['header'],
    }
    res.json(resourceMetadata)
  })

  /**
   * RFC 8414 — Authorization Server Metadata (proxied)
   *
   * We proxy the issuer's .well-known/oauth-authorization-server document
   * and patch `registration_endpoint` to point to our local pseudo-DCR.
   *
   * Handles both root and path-suffixed variants.
   */
  router.get('/.well-known/oauth-authorization-server*', async (req: Request, res: Response) => {
    try {
      const metadataUrl = `${auth.issuer}/.well-known/oauth-authorization-server`
      const upstream = await fetch(metadataUrl)

      if (!upstream.ok) {
        logger.error(`[discovery] Failed to fetch AS metadata: ${upstream.status}`)
        return res.status(502).json({ error: 'upstream_error' })
      }

      const metadata = (await upstream.json()) as Record<string, unknown>

      // Only patch registration_endpoint to point to our pseudo-DCR
      // Keep original issuer/authorization_endpoint/token_endpoint so tokens validate correctly
      const scheme = req.protocol
      const host = req.get('host')
      metadata.registration_endpoint = `${scheme}://${host}/register`

      res.json(metadata)
    } catch (err: any) {
      logger.error('[discovery] Error proxying AS metadata:', err.message ?? err)
      res.status(502).json({ error: 'upstream_error' })
    }
  })

  /**
   * Pseudo–Dynamic Client Registration (RFC 7591)
   *
   * Always returns the same pre-registered client_id — no new client
   * is actually created.  This lets standards-based OAuth clients
   * (e.g., VS Code Copilot) discover the correct client_id through
   * the normal DCR flow without requiring out-of-band configuration.
   */
  router.post('/register', (req: Request, res: Response) => {
    const body = req.body ?? {}
    res.status(201).json({
      client_id: auth.clientId,
      client_name: 'platf-bridge',
      // No client_secret — public client using PKCE
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
      redirect_uris: Array.isArray(body.redirect_uris) ? body.redirect_uris : [],
    })
  })

  return router
}
