export interface Logger {
  info: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

/** OAuth auth config passed when --authIssuer is set */
export interface AuthConfig {
  /** OAuth issuer URL (e.g. https://auth.platf.ai) */
  issuer: string
  /** OAuth client_id for this bridge instance */
  clientId: string
}
