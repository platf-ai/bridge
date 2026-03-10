/**
 * Stateless stdio-to-Streamable HTTP bridge.
 *
 * For every incoming POST request, spawns a fresh child process,
 * auto-initializes it if the request is not an initialize request,
 * and proxies JSON-RPC messages between the HTTP transport and the
 * child's stdin/stdout.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { type JSONRPCMessage, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import type { CorsOptions } from 'cors'
import type { AuthConfig, Logger } from '../types.js'
import { createApp, setResponseHeaders } from '../lib/express.js'
import { onSignals } from '../lib/onSignals.js'
import { spawnManagedChild } from '../lib/childProcess.js'
import { createInitializeRequest, createInitializedNotification, generateAutoInitId } from '../lib/mcpMessages.js'
import { VERSION, SERVER_NAME } from '../lib/config.js'

export interface StatelessBridgeArgs {
  stdioCmd: string
  port: number
  path: string
  logger: Logger
  corsOrigin: CorsOptions['origin']
  healthEndpoints: string[]
  headers: Record<string, string>
  protocolVersion: string
  auth: AuthConfig | null
}

/**
 * Start the stateless bridge server.
 */
export async function startStatelessBridge(args: StatelessBridgeArgs) {
  const { stdioCmd, port, path, logger, corsOrigin, healthEndpoints, headers, protocolVersion, auth } = args

  logger.info(`[stateless] Starting ${SERVER_NAME}`)
  logger.info(`  - port: ${port}`)
  logger.info(`  - stdio: ${stdioCmd}`)
  logger.info(`  - path: ${path}`)
  logger.info(`  - protocolVersion: ${protocolVersion}`)
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

  // POST handler — spawn child, proxy messages
  app.post(path, async (req, res) => {
    try {
      const server = new Server({ name: SERVER_NAME, version: VERSION }, { capabilities: {} })
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      await server.connect(transport)

      // Auto-initialization state
      let isInitialized = false
      let initializeRequestId: string | number | null = null
      let isAutoInitializing = false
      let pendingOriginalMessage: JSONRPCMessage | null = null

      const managedChild = spawnManagedChild(stdioCmd, logger, {
        onMessage: (msg) => {
          // Handle initialize response (auto or client-initiated)
          if (initializeRequestId && 'id' in msg && msg.id === initializeRequestId) {
            logger.info('[stateless] Initialize response received')
            isInitialized = true

            if (isAutoInitializing) {
              // Send initialized notification then the queued original message
              managedChild.send(createInitializedNotification())

              if (pendingOriginalMessage) {
                managedChild.send(pendingOriginalMessage)
                pendingOriginalMessage = null
              }

              isAutoInitializing = false
              initializeRequestId = null
              return // don't forward auto-init response to client
            }

            initializeRequestId = null
          }

          transport.send(msg).catch((e) => {
            logger.error('[stateless] Failed to send to HTTP transport', e)
          })
        },

        onExit: (code, signal, stderrOutput) => {
          // Include queued original message's ID if never sent
          if (pendingOriginalMessage && 'id' in pendingOriginalMessage && pendingOriginalMessage.id !== undefined) {
            managedChild.trackRequest(pendingOriginalMessage.id as string | number)
            pendingOriginalMessage = null
          }

          // Remove auto-init ID — client doesn't expect a response for it
          if (isAutoInitializing && initializeRequestId !== null) {
            managedChild.completeRequest(initializeRequestId)
          }

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
        // Track client request IDs for error reporting on child exit
        if ('id' in msg && msg.id !== undefined) {
          managedChild.trackRequest(msg.id as string | number)
        }

        // Auto-initialize if first message is not an initialize request
        if (!isInitialized && !isInitializeRequest(msg)) {
          pendingOriginalMessage = msg
          initializeRequestId = generateAutoInitId()
          isAutoInitializing = true

          logger.info('[stateless] Non-initialize message detected, sending auto-initialize first')
          managedChild.send(createInitializeRequest(initializeRequestId, protocolVersion))
          return
        }

        // Track client-initiated initialize
        if (isInitializeRequest(msg) && 'id' in msg && msg.id !== undefined) {
          initializeRequestId = msg.id
          isAutoInitializing = false
          logger.info(`[stateless] Tracking initialize request ID: ${msg.id}`)
        }

        managedChild.send(msg)
      }

      transport.onclose = () => {
        logger.info('[stateless] HTTP connection closed')
        managedChild.kill()
      }

      transport.onerror = (err) => {
        logger.error('[stateless] HTTP transport error:', err)
        managedChild.kill()
      }

      await transport.handleRequest(req, res, req.body)
    } catch (error) {
      logger.error('[stateless] Error handling MCP request:', error)
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        })
      }
    }
  })

  // GET/DELETE not allowed in stateless mode
  const methodNotAllowed = (_req: any, res: any) => {
    res.writeHead(405).end(JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed.' },
      id: null,
    }))
  }
  app.get(path, methodNotAllowed)
  app.delete(path, methodNotAllowed)

  app.listen(port, () => {
    logger.info(`Listening on port ${port}`)
    logger.info(`Streamable HTTP endpoint: http://localhost:${port}${path}`)
  })
}
