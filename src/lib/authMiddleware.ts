/**
 * OAuth 2.0 JWT auth middleware for the bridge.
 *
 * - Fetches JWKS from `{issuer}/jwks` using jose's createRemoteJWKSet (auto-caches).
 * - Validates Bearer token: signature, `iss`, `exp`.
 * - Validates `aud` claim per RFC 9068: must be resource URL or client ID.
 * - On failure returns 401 with RFC 9728–compliant `WWW-Authenticate` header
 *   pointing at the OAuth Protected Resource Metadata document.
 */

import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { RequestHandler } from 'express'
import type { AuthConfig, Logger } from '../types.js'

/** Build a reusable auth middleware for the given auth config */
export function createAuthMiddleware(auth: AuthConfig, logger: Logger): RequestHandler {
  const jwksUri = new URL(`${auth.issuer}/jwks`)
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

      // ── RFC 9068 §2.2: Audience Validation ──
      // If aud is a URL, it must match this resource server's URL.
      // If aud is a client ID (non-URL), accept it for backward compatibility.
      const aud = payload.aud
      if (aud) {
        const audValues = Array.isArray(aud) ? aud : [aud]
        const scheme = req.get('x-forwarded-proto') || req.protocol
        const host = req.get('host')
        const resourceUrl = `${scheme}://${host}/mcp`

        // Check if any audience value is valid
        const isValidAudience = audValues.some(a => {
          // If it looks like a URL, it must match our resource URL
          if (typeof a === 'string' && (a.startsWith('http://') || a.startsWith('https://'))) {
            return a === resourceUrl
          }
          // Non-URL audience (client ID) - accept for backward compat with user OAuth flow
          return true
        })

        if (!isValidAudience) {
          logger.error('[auth] Token audience mismatch:', { aud, expected: resourceUrl })
          return unauthorized(req, res, auth, 'invalid_token: audience mismatch')
        }
      }

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
