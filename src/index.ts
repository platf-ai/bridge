#!/usr/bin/env node

import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import { getLogger } from './lib/getLogger.js'
import { parseCorsOrigin } from './lib/cors.js'
import { parseHeaders } from './lib/headers.js'
import { startStatelessBridge } from './gateways/statelessBridge.js'
import { startStatefulBridge } from './gateways/statefulBridge.js'
import type { AuthConfig, LogLevel } from './types.js'

const argv = await yargs(hideBin(process.argv))
  .scriptName('platf-bridge')
  .usage('$0 — Stdio-to-Streamable HTTP bridge for MCP servers')
  .option('stdio', {
    type: 'string',
    demandOption: true,
    describe: 'Shell command that speaks MCP over stdio (stdin/stdout)',
  })
  .option('port', {
    type: 'number',
    default: 8000,
    describe: 'HTTP port to listen on',
  })
  .option('path', {
    type: 'string',
    default: '/mcp',
    describe: 'HTTP path for the Streamable HTTP endpoint',
  })
  .option('stateful', {
    type: 'boolean',
    default: false,
    describe: 'Enable stateful mode (session-based, persistent child process per session)',
  })
  .option('sessionTimeout', {
    type: 'number',
    describe: 'Session inactivity timeout in milliseconds (stateful mode only)',
  })
  .option('protocolVersion', {
    type: 'string',
    default: '2025-03-26',
    describe: 'MCP protocol version for auto-initialization (stateless mode)',
  })
  .option('logLevel', {
    type: 'string',
    choices: ['none', 'info', 'debug'] as const,
    default: 'info',
    describe: 'Log verbosity',
  })
  .option('cors', {
    type: 'array',
    describe: 'CORS origins to allow (omit for no CORS, pass * for all)',
  })
  .option('healthEndpoint', {
    type: 'array',
    string: true,
    default: [] as string[],
    describe: 'Path(s) that return 200 "ok" for health checks',
  })
  .option('header', {
    type: 'array',
    default: [] as (string | number)[],
    describe: 'Additional response headers in "Key: Value" format',
  })
  .option('authIssuer', {
    type: 'string',
    describe: 'OAuth issuer URL (e.g. https://auth.platf.ai). Enables auth when set.',
  })
  .option('authClientId', {
    type: 'string',
    describe: 'OAuth client_id for this bridge instance (pre-registered with auth issuer)',
  })
  .strict()
  .help()
  .parse()

const logger = getLogger(argv.logLevel as LogLevel)
const corsOrigin = parseCorsOrigin(argv.cors as (string | number)[] | undefined)
const headers = parseHeaders(argv.header, logger)

// Build auth config (only when --authIssuer is provided)
let auth: AuthConfig | null = null
if (argv.authIssuer) {
  if (!argv.authClientId) {
    console.error('Error: --authClientId is required when --authIssuer is set')
    process.exit(1)
  }
  auth = { issuer: argv.authIssuer.replace(/\/$/, ''), clientId: argv.authClientId }
  logger.info(`  Auth: enabled (issuer=${auth.issuer}, clientId=${auth.clientId})`)
} else {
  logger.info('  Auth: disabled')
}

logger.info('platf-bridge starting...')
logger.info(`  Mode: ${argv.stateful ? 'stateful' : 'stateless'}`)

if (argv.stateful) {
  await startStatefulBridge({
    stdioCmd: argv.stdio,
    port: argv.port,
    path: argv.path,
    logger,
    corsOrigin,
    healthEndpoints: argv.healthEndpoint,
    headers,
    sessionTimeout: argv.sessionTimeout ?? null,
    auth,
  })
} else {
  await startStatelessBridge({
    stdioCmd: argv.stdio,
    port: argv.port,
    path: argv.path,
    logger,
    corsOrigin,
    healthEndpoints: argv.healthEndpoint,
    headers,
    protocolVersion: argv.protocolVersion,
    auth,
  })
}
