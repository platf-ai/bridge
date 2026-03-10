/**
 * MCP message helpers for auto-initialization and protocol handling.
 */

import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { VERSION, SERVER_NAME } from './config.js'

/** Create a synthetic MCP initialize request */
export function createInitializeRequest(
  id: string | number,
  protocolVersion: string,
): JSONRPCMessage {
  return {
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
        name: SERVER_NAME,
        version: VERSION,
      },
    },
  }
}

/** Create an initialized notification */
export function createInitializedNotification(): JSONRPCMessage {
  return {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  }
}

/** Generate a unique ID for auto-init requests */
export function generateAutoInitId(): string {
  return `init_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
}
