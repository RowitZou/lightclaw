import type { FeishuClient } from '../client.js'
import { feishuErrorMessage } from '../resources/api.js'
import {
  getFileMetadata,
  type FeishuDriveItemType,
} from '../resources/folder.js'

export type AncestryChainEntry = {
  token: string
  type: FeishuDriveItemType
  parentToken: string | null
  name?: string
}

export type AncestryResolver = {
  resolve(targetToken: string): Promise<AncestryChainEntry[] | null>
  isWithin(targetToken: string, ancestorToken: string): Promise<boolean>
  evict(targetToken: string): void
  reset(): void
}

export function createAncestryResolver(
  client: FeishuClient,
  opts: { ttlMs?: number; maxEntries?: number; maxDepth?: number } = {},
): AncestryResolver {
  const ttlMs = opts.ttlMs ?? 5 * 60 * 1000
  const maxEntries = opts.maxEntries ?? 1000
  const maxDepth = opts.maxDepth ?? 50
  const cache = new Map<string, { expiresAt: number; chain: AncestryChainEntry[] | null }>()
  const inFlight = new Map<string, Promise<AncestryChainEntry[] | null>>()

  async function resolve(targetToken: string): Promise<AncestryChainEntry[] | null> {
    const now = Date.now()
    const cached = cache.get(targetToken)
    if (cached && cached.expiresAt > now) {
      cache.delete(targetToken)
      cache.set(targetToken, cached)
      return cached.chain
    }
    if (cached) {
      cache.delete(targetToken)
    }
    const existing = inFlight.get(targetToken)
    if (existing) {
      return existing
    }
    const promise = resolveUncached(targetToken)
      .then(chain => {
        cache.set(targetToken, { expiresAt: Date.now() + ttlMs, chain })
        trimCache()
        return chain
      })
      .finally(() => inFlight.delete(targetToken))
    inFlight.set(targetToken, promise)
    return promise
  }

  async function resolveUncached(targetToken: string): Promise<AncestryChainEntry[] | null> {
    const chain: AncestryChainEntry[] = []
    const seen = new Set<string>()
    let current: string | null = targetToken
    // Parents of any file/folder in Feishu drive are always folders. After
    // the first hop we know the next node is a folder; pass that hint so
    // SDKs without a direct getMetadata don't iterate doc_type guesses.
    let nextHintForParent: 'folder' | undefined
    for (let depth = 0; current && depth < maxDepth; depth += 1) {
      if (seen.has(current)) {
        process.stderr.write(`[feishu-workspace] ancestry cycle detected at token=${current}\n`)
        return null
      }
      seen.add(current)
      let meta
      try {
        meta = await getFileMetadata({
          client,
          token: current,
          ...(nextHintForParent ? { docTypeHint: nextHintForParent } : {}),
        })
      } catch (error) {
        process.stderr.write(`[feishu-workspace] ancestry metadata failed token=${current}: ${feishuErrorMessage(error)}\n`)
        return null
      }
      if (!meta) {
        return null
      }
      const parentToken = meta.parentToken ?? null
      chain.push({
        token: meta.token,
        type: meta.type,
        parentToken,
        ...(meta.name ? { name: meta.name } : {}),
      })
      current = parentToken
      nextHintForParent = 'folder'
    }
    if (current) {
      process.stderr.write(`[feishu-workspace] ancestry depth exceeded token=${targetToken}\n`)
      return null
    }
    return chain
  }

  function trimCache(): void {
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next().value as string | undefined
      if (!oldest) {
        return
      }
      cache.delete(oldest)
    }
  }

  return {
    resolve,
    async isWithin(targetToken: string, ancestorToken: string): Promise<boolean> {
      const chain = await resolve(targetToken)
      return Boolean(chain?.some(entry => entry.token === ancestorToken))
    },
    evict(targetToken: string): void {
      cache.delete(targetToken)
    },
    reset(): void {
      cache.clear()
      inFlight.clear()
    },
  }
}
