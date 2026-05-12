/**
 * Workspace containment: "is target token inside user workspace?"
 *
 * Earlier versions tried to walk *up* via `drive.v1.meta.batchQuery` (or a
 * non-existent `drive.v1.file.getMetadata`). That approach has two problems
 * the actual Feishu SDK exposed in production:
 *
 *   1. `meta.batchQuery` is the only metadata API the SDK ships, and its
 *      response shape does **not** include `parent_token` — only doc_token /
 *      doc_type / title / owner / timestamps / url. Walking parents up is
 *      simply not possible with the supplied API.
 *   2. The code therefore threw "metadata API is unavailable" on every
 *      ancestry check, which made `assertWithinWorkspace` always reject,
 *      which made every Phase 34 write tool error before doing anything.
 *
 * Drive list responses DO contain `parent_token` for every child item.
 * That gives us the inverse direction for free: every time we list folder
 * F, we observe (child, F) edges for each child. Build an in-memory
 * Map<childToken, parentToken> from those observations.
 *
 * To check containment of T under U, we walk *up* through the local map
 * (synchronous, no HTTP). Hits mean T was previously seen under some
 * folder; if the walk lands on U we accept. Misses (or hitting a node we
 * never observed) mean T was not legitimately obtained via a workspace
 * list — refuse. This matches the Phase 34 invariant: agents only ever
 * acquire tokens via name resolution that walks down from the user
 * workspace, so legitimate tokens are always populated; tokens injected
 * via legacy escape hatches (e.g. `FeishuCreateFile.folder_token` typed
 * by the model) are not, and get rejected.
 *
 * The map is process-wide because all workspaces share the same Feishu
 * drive. To guard against stale data on rename / move / share changes,
 * write tools call `evict(token)` after mutation. The map is bounded with
 * a simple insertion-order trim (default 5000 entries).
 */

/** Marker for "this token is a known workspace root (no further parent)". */
const ROOT_MARKER = '__feishu_workspace_root__'

export type ParentCache = {
  /** Record that `childToken` was observed as a direct child of `parentToken`. */
  observeChild(childToken: string, parentToken: string): void
  /** Record that a token is itself a known workspace root (no further parent). */
  markRoot(token: string): void
  /** Is `target` inside `ancestor` per the observed parent chain? */
  isWithin(target: string, ancestor: string): boolean
  /** Drop a token (call after move / delete that invalidates its parent edge). */
  evict(token: string): void
  /** Inspect: walk target → ancestors, stop when reach a known root or unknown. */
  ancestryChain(target: string): string[]
  /** Test-only: clear everything. */
  reset(): void
  /** Diagnostic. */
  size(): number
}

export function createParentCache(opts: { maxEntries?: number; maxDepth?: number } = {}): ParentCache {
  const maxEntries = opts.maxEntries ?? 5000
  const maxDepth = opts.maxDepth ?? 50
  // childToken → parentToken, OR ROOT_MARKER if child is itself a known root.
  // Insertion-ordered Map so `trim()` evicts oldest entries first.
  const parents = new Map<string, string>()

  function trim(): void {
    while (parents.size > maxEntries) {
      const oldest = parents.keys().next().value as string | undefined
      if (!oldest) return
      parents.delete(oldest)
    }
  }

  function observeChild(childToken: string, parentToken: string): void {
    if (!childToken || !parentToken) return
    // Re-insert to refresh insertion-order (MRU semantics for trim).
    parents.delete(childToken)
    parents.set(childToken, parentToken)
    trim()
  }

  function markRoot(token: string): void {
    if (!token) return
    parents.delete(token)
    parents.set(token, ROOT_MARKER)
    trim()
  }

  function ancestryChain(target: string): string[] {
    const chain: string[] = []
    const seen = new Set<string>()
    let current: string | undefined = target
    for (let depth = 0; current && depth < maxDepth; depth += 1) {
      if (seen.has(current)) {
        process.stderr.write(`[feishu-workspace] parent cache cycle at token=${current}\n`)
        return []
      }
      seen.add(current)
      chain.push(current)
      const next = parents.get(current)
      if (!next || next === ROOT_MARKER) {
        return chain
      }
      current = next
    }
    return chain
  }

  function isWithin(target: string, ancestor: string): boolean {
    if (target === ancestor) return true
    const chain = ancestryChain(target)
    return chain.includes(ancestor)
  }

  return {
    observeChild,
    markRoot,
    isWithin,
    evict(token: string): void { parents.delete(token) },
    ancestryChain,
    reset(): void { parents.clear() },
    size(): number { return parents.size },
  }
}

// Module-level singleton. The whole point is to amortize observations
// across all tool calls within one daemon process. The cache is global
// because containment edges (child → parent) are intrinsic to the Feishu
// drive itself and identical no matter which client read them.
let sharedCache: ParentCache = createParentCache()

export function getWorkspaceParentCache(): ParentCache {
  return sharedCache
}

/** Test-only: rebuild the singleton so tests start from empty state. */
export function resetWorkspaceParentCacheForTest(): void {
  sharedCache = createParentCache()
}
