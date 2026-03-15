/** Logger interface for structured logging */
export interface Logger {
  info: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

/** Log level for the logger */
export type LogLevel = 'none' | 'info' | 'debug'

/** OAuth auth config passed when --authIssuer is set */
export interface AuthConfig {
  /** OAuth issuer URL (e.g. https://app.platf.ai/oauth) */
  issuer: string
  /** OAuth client_id for this bridge instance */
  clientId: string
}
