import type { Logger } from '../types.js'

export interface OnSignalsOptions {
  logger: Logger
  cleanup?: () => void
}

export function onSignals({ logger, cleanup }: OnSignalsOptions): void {
  const handleSignal = (signal: string) => {
    logger.info(`Caught ${signal}. Exiting...`)
    cleanup?.()
    process.exit(0)
  }

  process.on('SIGINT', () => handleSignal('SIGINT'))
  process.on('SIGTERM', () => handleSignal('SIGTERM'))
  process.on('SIGHUP', () => handleSignal('SIGHUP'))

  process.stdin.on('close', () => {
    logger.info('stdin closed. Exiting...')
    cleanup?.()
    process.exit(0)
  })
}
