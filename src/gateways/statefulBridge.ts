/**
 * Stateful stdio-to-Streamable HTTP bridge.
 *
 * Maintains session state via `Mcp-Session-Id` header. Each session
 * spawns one child process; subsequent requests for the same session
 * reuse the existing transport and process. Sessions are cleaned up
 * after an optional inactivity timeout.
 */

import express from 'express'
import { randomUUID } from 'node:crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { type JSONRPCMessage, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import type { CorsOptions } from 'cors'
import type { AuthConfig, Logger } from '../types.js'
import { createApp } from '../lib/express.js'
import { onSignals } from '../lib/onSignals.js'
import { spawnManagedChild, type ManagedChildProcess } from '../lib/childProcess.js'
import { SessionAccessCounter } from '../lib/sessionAccessCounter.js'
import { VERSION, SERVER_NAME } from '../lib/config.js'

export interface StatefulBridgeArgs {
  stdioCmd: string
  port: number
  path: string
  logger: Logger
  corsOrigin: CorsOptions['origin']
  healthEndpoints: string[]
  headers: Record<string, string>
  sessionTimeout: number | null
  auth: AuthConfig | null
}

interface SessionState {
  transport: StreamableHTTPServerTransport
  child: ManagedChildProcess
}

/**
 * Start the stateful bridge server.
 */
export async function startStatefulBridge(args: StatefulBridgeArgs) {
  const { stdioCmd, port, path, logger, corsOrigin, healthEndpoints, headers, sessionTimeout, auth } = args

  logger.info(`[stateful] Starting ${SERVER_NAME}`)
  logger.info(`  - port: ${port}`)
  logger.info(`  - stdio: ${stdioCmd}`)
  logger.info(`  - path: ${path}`)
  logger.info(`  - Session timeout: ${sessionTimeout ? `${sessionTimeout}ms` : 'disabled'}`)
  logger.info(`  - Headers: ${Object.keys(headers).length ? JSON.stringify(headers) : '(none)'}`)

  onSignals({ logger })

  const app = createApp({
    logger,
    corsOrigin,
    healthEndpoints,
    headers,
    auth,
    mcpPath: path,
  })

  // Session state
  const sessions: Record<string, SessionState> = {}

  const sessionCounter = sessionTimeout
    ? new SessionAccessCounter(
        sessionTimeout,
        (sessionId) => {
          logger.info(`[stateful] Session ${sessionId} timed out, cleaning up`)
          const session = sessions[sessionId]
          if (session) {
            session.transport.close()
            session.child.kill()
          }
          delete sessions[sessionId]
        },
        logger,
      )
    : null

  // POST handler
  app.post(path, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined
    let session: SessionState

    if (sessionId && sessions[sessionId]) {
      // Reuse existing session
      session = sessions[sessionId]
      sessionCounter?.inc(sessionId, 'POST request for existing session')
    } else if (!sessionId && isInitializeRequest(req.body)) {
      // New session — spawn child process
      const server = new Server({ name: SERVER_NAME, version: VERSION }, { capabilities: {} })

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          sessions[newSessionId] = session
          sessionCounter?.inc(newSessionId, 'session initialization')
        },
      })

      await server.connect(transport)
      logger.info('[stateful] Server connected to transport')

      const managedChild = spawnManagedChild(stdioCmd, logger, {
        onMessage: (msg) => {
          logger.info(`[stateful] Child → HTTP: ${JSON.stringify(msg).slice(0, 500)}`)
          transport.send(msg).catch((e) => {
            logger.error('[stateful] Failed to send to HTTP transport', e)
          })
        },

        onExit: (code, signal, stderrOutput) => {
          logger.error(`[stateful] Child exited: code=${code}, signal=${signal}`)

          // Send error responses for all pending requests
          for (const id of managedChild.getPendingRequests()) {
            const detail = stderrOutput.trim().slice(0, 1000)
            const message = detail
              ? `Child process exited (code=${code}): ${detail}`
              : `Child process exited unexpectedly (code=${code}, signal=${signal})`
            transport.send({
              jsonrpc: '2.0',
              error: { code: -32603, message },
              id,
            } as JSONRPCMessage).catch(() => {})
          }

          transport.close()
        },
      })

      transport.onmessage = (msg: JSONRPCMessage) => {
        logger.info(`[stateful] HTTP → Child: ${JSON.stringify(msg)}`)
        if ('id' in msg && msg.id !== undefined) {
          managedChild.trackRequest(msg.id as string | number)
        }
        managedChild.send(msg)
      }

      transport.onclose = () => {
        logger.info(`[stateful] HTTP connection closed (session ${transport.sessionId})`)
        if (transport.sessionId) {
          sessionCounter?.clear(transport.sessionId, false, 'transport closed')
          delete sessions[transport.sessionId]
        }
        managedChild.kill()
      }

      transport.onerror = (err) => {
        logger.error(`[stateful] HTTP transport error (session ${transport.sessionId}):`, err)
        if (transport.sessionId) {
          sessionCounter?.clear(transport.sessionId, false, 'transport error')
          delete sessions[transport.sessionId]
        }
        managedChild.kill()
      }

      session = { transport, child: managedChild }
    } else {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
        id: null,
      })
      return
    }

    // Track response lifecycle for session cleanup
    let responseEnded = false
    const handleResponseEnd = (event: string) => {
      if (!responseEnded && session.transport.sessionId) {
        responseEnded = true
        logger.info(`[stateful] Response ${event}`, session.transport.sessionId)
        sessionCounter?.dec(session.transport.sessionId, `POST response ${event}`)
      }
    }
    res.on('finish', () => handleResponseEnd('finished'))
    res.on('close', () => handleResponseEnd('closed'))

    await session.transport.handleRequest(req, res, req.body)
  })

  // GET/DELETE handler (session-bound)
  const handleSessionRequest = async (req: express.Request, res: express.Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined
    if (!sessionId || !sessions[sessionId]) {
      res.status(400).send('Invalid or missing session ID')
      return
    }

    sessionCounter?.inc(sessionId, `${req.method} request for existing session`)

    let responseEnded = false
    const handleResponseEnd = (event: string) => {
      if (!responseEnded) {
        responseEnded = true
        logger.info(`[stateful] Response ${event}`, sessionId)
        sessionCounter?.dec(sessionId, `${req.method} response ${event}`)
      }
    }
    res.on('finish', () => handleResponseEnd('finished'))
    res.on('close', () => handleResponseEnd('closed'))

    const session = sessions[sessionId]
    await session.transport.handleRequest(req, res)
  }

  app.get(path, handleSessionRequest)
  app.delete(path, handleSessionRequest)

  app.listen(port, () => {
    logger.info(`Listening on port ${port}`)
    logger.info(`Streamable HTTP endpoint: http://localhost:${port}${path}`)
  })
}
