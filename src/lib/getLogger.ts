import util from 'node:util'
import type { Logger } from '../types.js'

const defaultFormatArgs = (args: unknown[]) => args

const log =
  ({ formatArgs = defaultFormatArgs }: { formatArgs?: typeof defaultFormatArgs } = {}) =>
  (...args: unknown[]) =>
    console.log('[platf-bridge]', ...formatArgs(args))

const logStderr =
  ({ formatArgs = defaultFormatArgs }: { formatArgs?: typeof defaultFormatArgs } = {}) =>
  (...args: unknown[]) =>
    console.error('[platf-bridge]', ...formatArgs(args))

const noneLogger: Logger = {
  info: () => {},
  error: () => {},
}

const infoLogger: Logger = {
  info: log(),
  error: logStderr(),
}

const debugFormatArgs = (args: unknown[]) =>
  args.map((arg) => {
    if (typeof arg === 'object') {
      return util.inspect(arg, {
        depth: null,
        colors: process.stderr.isTTY,
        compact: false,
      })
    }
    return arg
  })

const debugLogger: Logger = {
  info: log({ formatArgs: debugFormatArgs }),
  error: logStderr({ formatArgs: debugFormatArgs }),
}

export type LogLevel = 'none' | 'info' | 'debug'

export function getLogger(logLevel: LogLevel): Logger {
  if (logLevel === 'none') return noneLogger
  if (logLevel === 'debug') return debugLogger
  return infoLogger
}
