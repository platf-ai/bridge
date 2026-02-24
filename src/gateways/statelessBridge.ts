import express from 'express'
import cors, { type CorsOptions } from 'cors'
import { spawn } from 'child_process'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  type JSONRPCMessage,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js'
import type { AuthConfig, Logger } from '../types.js'
import { onSignals } from '../lib/onSignals.js'
import { serializeCorsOrigin } from '../lib/cors.js'
import { createAuthMiddleware } from '../lib/authMiddleware.js'
import { createDiscoveryRouter } from '../lib/discoveryRoutes.js'

const VERSION = '1.0.0'

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

const setResponseHeaders = (res: express.Response, headers: Record<string, string>) =>
  Object.entries(headers).forEach(([key, value]) => res.setHeader(key, value))

/** Create a synthetic MCP initialize request */
const createInitializeRequest = (
  id: string | number,
  protocolVersion: string,
): JSONRPCMessage => ({
  jsonrpc: '2.0',
  id,
  method: 'initialize',
  params: {
    protocolVersion,
    capabilities: {
      roots: { listChanged: true },
      sampling: {},
    },
    clientInfo: {
      name: 'platf-bridge',
      version: VERSION,
    },
  },
})

const createInitializedNotification = (): JSONRPCMessage => ({
  jsonrpc: '2.0',
  method: 'notifications/initialized',
})

/**
 * Stateless stdio-to-Streamable HTTP bridge.
 *
 * For every incoming POST request, spawns a fresh child process,
 * auto-initializes it if the request is not an initialize request,
 * and proxies JSON-RPC messages between the HTTP transport and the
 * child's stdin/stdout.
 */
export async function startStatelessBridge(args: StatelessBridgeArgs) {
  const {
    stdioCmd,
    port,
    path,
    logger,
    corsOrigin,
    healthEndpoints,
    headers,
    protocolVersion,
    auth,
  } = args

  logger.info(`[stateless] Starting platf-bridge`)
  logger.info(`  - Headers: ${Object.keys(headers).length ? JSON.stringify(headers) : '(none)'}`)
  logger.info(`  - port: ${port}`)
  logger.info(`  - stdio: ${stdioCmd}`)
  logger.info(`  - path: ${path}`)
  logger.info(`  - protocolVersion: ${protocolVersion}`)
  logger.info(
    `  - CORS: ${corsOrigin ? `enabled (${serializeCorsOrigin(corsOrigin)})` : 'disabled'}`,
  )
  logger.info(
    `  - Health endpoints: ${healthEndpoints.length ? healthEndpoints.join(', ') : '(none)'}`,
  )

  onSignals({ logger })

  const app = express()
  app.use(express.json())

  if (corsOrigin) {
    app.use(cors({ origin: corsOrigin }))
  }

  for (const ep of healthEndpoints) {
    app.get(ep, (_req, res) => {
      setResponseHeaders(res, headers)
      res.send('ok')
    })
  }

  // --- OAuth discovery & auth middleware (when auth is enabled) ---
  if (auth) {
    app.use(createDiscoveryRouter(auth, logger))
    app.use(path, createAuthMiddleware(auth, logger))
    logger.info(`  - Auth: enabled (issuer=${auth.issuer})`)
  }

  app.post(path, async (req, res) => {
    try {
      const server = new Server(
        { name: 'platf-bridge', version: VERSION },
        { capabilities: {} },
      )
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      })

      await server.connect(transport)
      const child = spawn(stdioCmd, { shell: true })

      const pendingRequestIds = new Set<string | number>()
      let stderrOutput = ''

      child.on('exit', (code, signal) => {
        logger.error(`Child exited: code=${code}, signal=${signal}`)

        // Include queued original message's ID if it was never sent to the child
        if (pendingOriginalMessage && 'id' in pendingOriginalMessage && pendingOriginalMessage.id !== undefined) {
          pendingRequestIds.add(pendingOriginalMessage.id as string | number)
          pendingOriginalMessage = null
        }

        // Remove auto-init ID — the client doesn't expect a response for it
        if (isAutoInitializing && initializeRequestId !== null) {
          pendingRequestIds.delete(initializeRequestId)
        }

        // Send JSON-RPC error responses for all pending client requests
        for (const id of pendingRequestIds) {
          const detail = stderrOutput.trim().slice(0, 1000)
          const message = detail
            ? `Child process exited (code=${code}): ${detail}`
            : `Child process exited unexpectedly (code=${code}, signal=${signal})`
          try {
            transport.send({
              jsonrpc: '2.0',
              error: { code: -32603, message },
              id,
            } as JSONRPCMessage)
          } catch (e) {
            logger.error(`Failed to send error response for request ${id}`, e)
          }
        }
        pendingRequestIds.clear()

        transport.close()
      })

      // --- Auto-initialization state ---
      let isInitialized = false
      let initializeRequestId: string | number | null = null
      let isAutoInitializing = false
      let pendingOriginalMessage: JSONRPCMessage | null = null

      let buffer = ''
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const jsonMsg = JSON.parse(line)
            if ('id' in jsonMsg && jsonMsg.id !== undefined) {
              pendingRequestIds.delete(jsonMsg.id)
            }
            logger.info('Child → HTTP:', line)

            // Handle initialize response (auto or client-initiated)
            if (initializeRequestId && jsonMsg.id === initializeRequestId) {
              logger.info('Initialize response received')
              isInitialized = true

              if (isAutoInitializing) {
                // Send initialized notification then the queued original message
                const notification = createInitializedNotification()
                logger.info(`HTTP → Child (initialized): ${JSON.stringify(notification)}`)
                child.stdin.write(JSON.stringify(notification) + '\n')

                if (pendingOriginalMessage) {
                  logger.info(`HTTP → Child (original): ${JSON.stringify(pendingOriginalMessage)}`)
                  child.stdin.write(JSON.stringify(pendingOriginalMessage) + '\n')
                  pendingOriginalMessage = null
                }

                isAutoInitializing = false
                initializeRequestId = null
                return // don't forward auto-init response to client
              }

              initializeRequestId = null
            }

            try {
              transport.send(jsonMsg)
            } catch (e) {
              logger.error('Failed to send to HTTP transport', e)
            }
          } catch {
            logger.error(`Child non-JSON: ${line}`)
          }
        }
      })

      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        stderrOutput += text
        logger.error(`Child stderr: ${text}`)
      })

      transport.onmessage = (msg: JSONRPCMessage) => {
        logger.info(`HTTP → Child: ${JSON.stringify(msg)}`)

        // Track client request IDs for error reporting on child exit
        if ('id' in msg && msg.id !== undefined) {
          pendingRequestIds.add(msg.id as string | number)
        }

        // Auto-initialize if the first message is not an initialize request
        if (!isInitialized && !isInitializeRequest(msg)) {
          pendingOriginalMessage = msg
          initializeRequestId = `init_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
          isAutoInitializing = true

          logger.info('Non-initialize message detected, sending auto-initialize first')
          const initReq = createInitializeRequest(initializeRequestId, protocolVersion)
          logger.info(`HTTP → Child (auto-init): ${JSON.stringify(initReq)}`)
          child.stdin.write(JSON.stringify(initReq) + '\n')
          return
        }

        // Track client-initiated initialize
        if (isInitializeRequest(msg) && 'id' in msg && msg.id !== undefined) {
          initializeRequestId = msg.id
          isAutoInitializing = false
          logger.info(`Tracking initialize request ID: ${msg.id}`)
        }

        child.stdin.write(JSON.stringify(msg) + '\n')
      }

      transport.onclose = () => {
        logger.info('HTTP connection closed')
        child.kill()
      }

      transport.onerror = (err) => {
        logger.error('HTTP transport error:', err)
        child.kill()
      }

      await transport.handleRequest(req, res, req.body)
    } catch (error) {
      logger.error('Error handling MCP request:', error)
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        })
      }
    }
  })

  app.get(path, (_req, res) => {
    logger.info('Received GET — method not allowed in stateless mode')
    res.writeHead(405).end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed.' },
        id: null,
      }),
    )
  })

  app.delete(path, (_req, res) => {
    logger.info('Received DELETE — method not allowed in stateless mode')
    res.writeHead(405).end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed.' },
        id: null,
      }),
    )
  })

  app.listen(port, () => {
    logger.info(`Listening on port ${port}`)
    logger.info(`Streamable HTTP endpoint: http://localhost:${port}${path}`)
  })
}
