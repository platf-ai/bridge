import type { Logger } from '../types.js'

export function parseHeaders(
  rawHeaders: (string | number)[],
  logger: Logger,
): Record<string, string> {
  return rawHeaders.reduce<Record<string, string>>((acc, rawHeader) => {
    const header = `${rawHeader}`
    const colonIndex = header.indexOf(':')
    if (colonIndex === -1) {
      logger.error(`Invalid header format: ${header}, ignoring`)
      return acc
    }

    const key = header.slice(0, colonIndex).trim()
    const value = header.slice(colonIndex + 1).trim()

    if (!key || !value) {
      logger.error(`Invalid header format: ${header}, ignoring`)
      return acc
    }

    acc[key] = value
    return acc
  }, {})
}
