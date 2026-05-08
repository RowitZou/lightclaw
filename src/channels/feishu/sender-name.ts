type CacheEntry = {
  name: string
  fetchedAt: number
}

const CACHE_TTL_MS = 60 * 60 * 1000
const NAME_INVALID_CHARS = /[\[\]\n\r\t]/g
const cache = new Map<string, CacheEntry>()

export type SenderNameResolver = {
  resolve(input: {
    openId: string
    mentionNames?: ReadonlyMap<string, string>
  }): Promise<string>
}

export function createSenderNameResolver(opts: {
  fetchUserName?: (openId: string) => Promise<string | undefined>
}): SenderNameResolver {
  return {
    async resolve(input) {
      const cached = cache.get(input.openId)
      if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        return cached.name
      }

      if (opts.fetchUserName) {
        try {
          const fetched = await opts.fetchUserName(input.openId)
          if (fetched) {
            return remember(input.openId, sanitizeName(fetched))
          }
        } catch {
          // Best effort only; mentions/open_id fallback keeps the hot path alive.
        }
      }

      const mentioned = input.mentionNames?.get(input.openId)
      if (mentioned) {
        return remember(input.openId, sanitizeName(mentioned))
      }

      return remember(input.openId, input.openId.slice(-8).toLowerCase() || 'unknown')
    },
  }
}

export function sanitizeSenderNameForTest(name: string): string {
  return sanitizeName(name)
}

export function resetSenderNameCacheForTest(): void {
  cache.clear()
}

function remember(openId: string, name: string): string {
  cache.set(openId, { name, fetchedAt: Date.now() })
  return name
}

function sanitizeName(name: string): string {
  const sanitized = name.trim().replace(NAME_INVALID_CHARS, '').slice(0, 32)
  return sanitized || 'unknown'
}
