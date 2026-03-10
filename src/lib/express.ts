/**
 * Shared Express application factory.
 *
 * Creates and configures the common Express setup used by both
 * stateful and stateless bridges.
 */

import express, { type Express, type Response } from 'express'
import cors, { type CorsOptions } from 'cors'
import type { AuthConfig, Logger } from '../types.js'
import { serializeCorsOrigin } from './cors.js'
import { createDiscoveryRouter } from './discoveryRoutes.js'
import { createAuthMiddleware } from './authMiddleware.js'

export interface CreateAppOptions {
  logger: Logger
  corsOrigin: CorsOptions['origin']
  healthEndpoints: string[]
  headers: Record<string, string>
  auth: AuthConfig | null
  /** Path for the MCP endpoint (used to apply auth middleware) */
  mcpPath: string
}

/** Set custom response headers */
export const setResponseHeaders = (res: Response, headers: Record<string, string>) =>
  Object.entries(headers).forEach(([key, value]) => res.setHeader(key, value))

/**
 * Create and configure an Express application with shared middleware.
 * 
 * Sets up:
 * - JSON body parser
 * - Trust proxy (for X-Forwarded-* headers)
 * - CORS (if configured)
 * - Health endpoints
 * - OAuth discovery routes (if auth enabled)
 * - OAuth proxy routes (if auth enabled)
 * - Auth middleware on mcpPath (if auth enabled)
 */
export function createApp(options: CreateAppOptions): Express {
  const { logger, corsOrigin, healthEndpoints, headers, auth, mcpPath } = options

  const app = express()
  app.set('trust proxy', true)
  app.use(express.json())
  app.use(express.urlencoded({ extended: true }))

  // CORS
  if (corsOrigin) {
    app.use(cors({ origin: corsOrigin, exposedHeaders: ['Mcp-Session-Id'] }))
    logger.info(`  - CORS: enabled (${serializeCorsOrigin(corsOrigin)})`)
  } else {
    logger.info('  - CORS: disabled')
  }

  // Health endpoints
  for (const ep of healthEndpoints) {
    app.get(ep, (_req, res) => {
      setResponseHeaders(res, headers)
      res.send('ok')
    })
  }
  if (healthEndpoints.length) {
    logger.info(`  - Health endpoints: ${healthEndpoints.join(', ')}`)
  }

  // OAuth (when auth is enabled)
  if (auth) {
    // Discovery routes (PRM, AS metadata, pseudo-DCR)
    app.use(createDiscoveryRouter(auth, logger))
    // Auth middleware on MCP path
    app.use(mcpPath, createAuthMiddleware(auth, logger))
    logger.info(`  - Auth: enabled (issuer=${auth.issuer})`)
  } else {
    logger.info('  - Auth: disabled')
  }

  return app
}
