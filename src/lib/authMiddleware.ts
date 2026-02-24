/**
 * OAuth 2.0 JWT auth middleware for the bridge.
 *
 * - Fetches JWKS from `{issuer}/jwks` using jose's createRemoteJWKSet (auto-caches).
 * - Validates Bearer token: signature, `iss`, `exp`.
 * - On failure returns 401 with RFC 9728–compliant `WWW-Authenticate` header
 *   pointing at the OAuth Protected Resource Metadata document.
 */

import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { RequestHandler } from 'express'
import type { AuthConfig, Logger } from '../types.js'

/** Build a reusable auth middleware for the given auth config */
export function createAuthMiddleware(auth: AuthConfig, logger: Logger): RequestHandler {
  const jwksUri = new URL('/jwks', auth.issuer)
  const JWKS = createRemoteJWKSet(jwksUri)

  return async (req, res, next) => {
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return unauthorized(req, res, auth, 'missing or malformed Authorization header')
    }

    const token = authHeader.slice(7)

    try {
      const { payload } = await jwtVerify(token, JWKS, {
        issuer: auth.issuer,
      })

      // Attach token payload to request for downstream use
      ;(req as any).tokenPayload = payload
      next()
    } catch (err: any) {
      logger.error('[auth] JWT verification failed:', err.message ?? err)
      return unauthorized(req, res, auth, 'invalid_token')
    }
  }
}

function unauthorized(
  req: import('express').Request,
  res: import('express').Response,
  auth: AuthConfig,
  error: string,
) {
  // RFC 9728: include resource_metadata URI in WWW-Authenticate
  const scheme = req.protocol
  const host = req.get('host')
  const resourceMetadataUri = `${scheme}://${host}/.well-known/oauth-protected-resource`

  res.setHeader(
    'WWW-Authenticate',
    `Bearer realm="mcp", error="${error}", resource_metadata="${resourceMetadataUri}"`,
  )
  res.status(401).json({ error: 'unauthorized', message: error })
}
