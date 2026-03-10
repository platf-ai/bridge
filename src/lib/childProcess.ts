/**
 * Child process management for stdio-based MCP servers.
 *
 * Handles spawning child processes, parsing JSON-RPC messages from stdout,
 * and writing messages to stdin.
 */

import { spawn, type ChildProcess } from 'child_process'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import type { Logger } from '../types.js'

export interface ChildProcessCallbacks {
  /** Called when a JSON-RPC message is received from the child */
  onMessage: (msg: JSONRPCMessage) => void
  /** Called when the child process exits */
  onExit: (code: number | null, signal: string | null, stderrOutput: string) => void
  /** Called when there's an error spawning or communicating with the child */
  onError?: (err: Error) => void
}

export interface ManagedChildProcess {
  /** The underlying child process */
  child: ChildProcess
  /** Send a JSON-RPC message to the child's stdin */
  send: (msg: JSONRPCMessage) => boolean
  /** Kill the child process */
  kill: () => void
  /** Track a request ID as pending (for error reporting on exit) */
  trackRequest: (id: string | number) => void
  /** Mark a request ID as completed */
  completeRequest: (id: string | number) => void
  /** Get all pending request IDs */
  getPendingRequests: () => Set<string | number>
}

/**
 * Spawn a child process and set up JSON-RPC message handling.
 * 
 * The child is expected to speak JSON-RPC over stdio (one message per line).
 */
export function spawnManagedChild(
  command: string,
  logger: Logger,
  callbacks: ChildProcessCallbacks,
): ManagedChildProcess {
  const pendingRequestIds = new Set<string | number>()
  let stderrOutput = ''
  let buffer = ''

  const child = spawn(command, { shell: true, stdio: ['pipe', 'pipe', 'pipe'] })

  logger.info(`[child] Spawned process, pid=${child.pid}`)

  child.on('spawn', () => {
    logger.info(`[child] spawn event fired, pid=${child.pid}`)
  })

  child.on('error', (err) => {
    logger.error(`[child] error event: ${err.message}`)
    callbacks.onError?.(err)
  })

  child.on('exit', (code, signal) => {
    logger.info(`[child] exited: code=${code}, signal=${signal}`)
    callbacks.onExit(code, signal, stderrOutput)
  })

  child.stdout.on('data', (chunk: Buffer) => {
    const chunkStr = chunk.toString('utf8')
    logger.info(`[child] stdout received ${chunk.length} bytes`)
    buffer += chunkStr

    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const jsonMsg = JSON.parse(line) as JSONRPCMessage
        // Auto-complete request tracking for responses
        if ('id' in jsonMsg && jsonMsg.id !== undefined) {
          pendingRequestIds.delete(jsonMsg.id)
        }
        logger.info(`[child] → message: ${line.slice(0, 200)}${line.length > 200 ? '...' : ''}`)
        callbacks.onMessage(jsonMsg)
      } catch {
        logger.error(`[child] non-JSON output: ${line}`)
      }
    }
  })

  child.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8')
    stderrOutput += text
    logger.error(`[child] stderr: ${text}`)
  })

  child.stdin.on('error', (err) => {
    logger.error(`[child] stdin error: ${err.message}`)
  })

  return {
    child,
    send: (msg: JSONRPCMessage) => {
      const payload = JSON.stringify(msg) + '\n'
      logger.info(`[child] ← message: ${JSON.stringify(msg).slice(0, 200)}`)
      return child.stdin.write(payload)
    },
    kill: () => {
      child.kill()
    },
    trackRequest: (id: string | number) => {
      pendingRequestIds.add(id)
    },
    completeRequest: (id: string | number) => {
      pendingRequestIds.delete(id)
    },
    getPendingRequests: () => pendingRequestIds,
  }
}
