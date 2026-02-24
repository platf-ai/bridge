import type { CorsOptions } from 'cors'

export function parseCorsOrigin(
  corsValues: (string | number)[] | undefined,
): CorsOptions['origin'] | false {
  if (!corsValues) return false
  if (corsValues.length === 0) return '*'

  const origins = corsValues.map((item) => `${item}`)
  if (origins.includes('*')) return '*'

  return origins.map((origin) => {
    if (/^\/.*\/$/.test(origin)) {
      const pattern = origin.slice(1, -1)
      try {
        return new RegExp(pattern)
      } catch {
        return origin
      }
    }
    return origin
  })
}

export function serializeCorsOrigin(corsOrigin: CorsOptions['origin']): string {
  return JSON.stringify(corsOrigin, (_key, value) => {
    if (value instanceof RegExp) return value.toString()
    return value
  })
}
