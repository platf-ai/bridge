import express from 'express'
import cors, { type CorsOptions } from 'cors'
import { spawn } from 'child_process'
import { randomUUID } from 'node:crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { type JSONRPCMessage, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import type { AuthConfig, Logger } from '../types.js'
import { onSignals } from '../lib/onSignals.js'
import { serializeCorsOrigin } from '../lib/cors.js'
import { SessionAccessCounter } from '../lib/sessionAccessCounter.js'
import { createAuthMiddleware } from '../lib/authMiddleware.js'
import { createDiscoveryRouter } from '../lib/discoveryRoutes.js'

const VERSION = '1.0.0'

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

const setResponseHeaders = (res: express.Response, headers: Record<string, string>) =>
  Object.entries(headers).forEach(([key, value]) => res.setHeader(key, value))

/**
 * Stateful stdio-to-Streamable HTTP bridge.
 *
 * Maintains session state via `Mcp-Session-Id` header.  Each session
 * spawns one child process; subsequent requests for the same session
 * reuse the existing transport and process.  Sessions are cleaned up
 * after an optional inactivity timeout.
 */
export async function startStatefulBridge(args: StatefulBridgeArgs) {
  const {
    stdioCmd,
    port,
    path,
    logger,
    corsOrigin,
    healthEndpoints,
    headers,
    sessionTimeout,
    auth,
  } = args

  logger.info(`[stateful] Starting platf-bridge`)
  logger.info(`  - Headers: ${Object.keys(headers).length ? JSON.stringify(headers) : '(none)'}`)
  logger.info(`  - port: ${port}`)
  logger.info(`  - stdio: ${stdioCmd}`)
  logger.info(`  - path: ${path}`)
  logger.info(
    `  - CORS: ${corsOrigin ? `enabled (${serializeCorsOrigin(corsOrigin)})` : 'disabled'}`,
  )
  logger.info(
    `  - Health endpoints: ${healthEndpoints.length ? healthEndpoints.join(', ') : '(none)'}`,
  )
  logger.info(`  - Session timeout: ${sessionTimeout ? `${sessionTimeout}ms` : 'disabled'}`)

  onSignals({ logger })

  const app = express()
  app.set('trust proxy', true)
  app.use(express.json())

  if (corsOrigin) {
    app.use(cors({ origin: corsOrigin, exposedHeaders: ['Mcp-Session-Id'] }))
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

  // Session state
  const transports: Record<string, StreamableHTTPServerTransport> = {}

  const sessionCounter = sessionTimeout
    ? new SessionAccessCounter(
        sessionTimeout,
        (sessionId) => {
          logger.info(`Session ${sessionId} timed out, cleaning up`)
          const transport = transports[sessionId]
          if (transport) transport.close()
          delete transports[sessionId]
        },
        logger,
      )
    : null

  // --- POST handler ---
  app.post(path, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined
    let transport: StreamableHTTPServerTransport

    if (sessionId && transports[sessionId]) {
      // Reuse existing session
      transport = transports[sessionId]
      sessionCounter?.inc(sessionId, 'POST request for existing session')
    } else if (!sessionId && isInitializeRequest(req.body)) {
      // New session — spawn child process
      const server = new Server(
        { name: 'platf-bridge', version: VERSION },
        { capabilities: {} },
      )

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          transports[newSessionId] = transport
          sessionCounter?.inc(newSessionId, 'session initialization')
        },
      })

      await server.connect(transport)
      logger.info('[debug] Server connected to transport')

      const child = spawn(stdioCmd, { shell: true, stdio: ['pipe', 'pipe', 'pipe'] })
      logger.info(`[debug] Child spawned, pid=${child.pid}`)

      const pendingRequestIds = new Set<string | number>()
      let stderrOutput = ''

      child.on('spawn', () => {
        logger.info(`[debug] Child spawn event fired, pid=${child.pid}`)
      })

      child.on('error', (err) => {
        logger.error(`[debug] Child error event: ${err.message}`)
      })

      child.on('exit', (code, signal) => {
        logger.error(`Child exited: code=${code}, signal=${signal}`)

        // Send JSON-RPC error responses for all pending requests
        for (const id of pendingRequestIds) {
          const detail = stderrOutput.trim().slice(0, 1000)
          const message = detail
            ? `Child process exited (code=${code}): ${detail}`
            : `Child process exited unexpectedly (code=${code}, signal=${signal})`
          transport.send({
            jsonrpc: '2.0',
            error: { code: -32603, message },
            id,
          } as JSONRPCMessage).catch(e => {
            logger.error(`Failed to send error response for request ${id}`, e)
          })
        }
        pendingRequestIds.clear()

        transport.close()
      })

      let buffer = ''
      child.stdout.on('data', (chunk: Buffer) => {
        const chunkStr = chunk.toString('utf8')
        logger.info(`[debug] stdout.on('data') received ${chunk.length} bytes: ${chunkStr.slice(0, 200)}...`)
        buffer += chunkStr
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        logger.info(`[debug] Split into ${lines.length} lines, remaining buffer: ${buffer.length} chars`)

        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const jsonMsg = JSON.parse(line)
            if ('id' in jsonMsg && jsonMsg.id !== undefined) {
              pendingRequestIds.delete(jsonMsg.id)
            }
            logger.info('Child → HTTP:', line.slice(0, 500))
            transport.send(jsonMsg).then(() => {
              logger.info('[debug] transport.send() succeeded')
            }).catch(e => {
              logger.error('Failed to send to HTTP transport', e)
            })
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

      child.stdout.on('close', () => {
        logger.info('[debug] child.stdout closed')
      })

      child.stdout.on('end', () => {
        logger.info('[debug] child.stdout ended')
      })

      child.stdin.on('error', (err) => {
        logger.error(`[debug] child.stdin error: ${err.message}`)
      })

      transport.onmessage = (msg: JSONRPCMessage) => {
        logger.info(`HTTP → Child: ${JSON.stringify(msg)}`)
        if ('id' in msg && msg.id !== undefined) {
          pendingRequestIds.add(msg.id as string | number)
        }
        const payload = JSON.stringify(msg) + '\n'
        const written = child.stdin.write(payload)
        logger.info(`[debug] stdin.write() returned ${written}, payload length=${payload.length}`)
      }

      transport.onclose = () => {
        logger.info(`HTTP connection closed (session ${sessionId})`)
        if (transport.sessionId) {
          sessionCounter?.clear(transport.sessionId, false, 'transport closed')
          delete transports[transport.sessionId]
        }
        child.kill()
      }

      transport.onerror = (err) => {
        logger.error(`HTTP transport error (session ${sessionId}):`, err)
        if (transport.sessionId) {
          sessionCounter?.clear(transport.sessionId, false, 'transport error')
          delete transports[transport.sessionId]
        }
        child.kill()
      }
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
      if (!responseEnded && transport.sessionId) {
        responseEnded = true
        logger.info(`Response ${event}`, transport.sessionId)
        sessionCounter?.dec(transport.sessionId, `POST response ${event}`)
      }
    }
    res.on('finish', () => handleResponseEnd('finished'))
    res.on('close', () => handleResponseEnd('closed'))

    await transport.handleRequest(req, res, req.body)
  })

  // --- GET / DELETE handler (session-bound) ---
  const handleSessionRequest = async (req: express.Request, res: express.Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send('Invalid or missing session ID')
      return
    }

    sessionCounter?.inc(sessionId, `${req.method} request for existing session`)

    let responseEnded = false
    const handleResponseEnd = (event: string) => {
      if (!responseEnded) {
        responseEnded = true
        logger.info(`Response ${event}`, sessionId)
        sessionCounter?.dec(sessionId, `${req.method} response ${event}`)
      }
    }
    res.on('finish', () => handleResponseEnd('finished'))
    res.on('close', () => handleResponseEnd('closed'))

    const transport = transports[sessionId]
    await transport.handleRequest(req, res)
  }

  app.get(path, handleSessionRequest)
  app.delete(path, handleSessionRequest)

  app.listen(port, () => {
    logger.info(`Listening on port ${port}`)
    logger.info(`Streamable HTTP endpoint: http://localhost:${port}${path}`)
  })
}
