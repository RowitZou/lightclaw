/**
 * Read tool dedup: skip re-emitting content when a file/range has already
 * been Read in this session and the file hasn't been touched on disk since.
 *
 * Mirrors Claude Code's `readFileState` strategy: when the model loops over
 * a file (e.g. PDF reading abstract → reading intro → re-reading abstract),
 * the second Read call hits cache and returns a short "file unchanged"
 * stub. The prior tool_result with the actual content is still in the
 * model's context, so this is a cheap dedup that saves cache_creation
 * tokens without losing information.
 *
 * Why module-level (not per-session):
 *   - filePath + mtime is a deterministic global key — same bytes mean same
 *     content regardless of session. Cross-session sharing is pure win.
 *   - LRU caps memory; daemon restart drops state naturally.
 *   - Matches the shape we landed for describe-cache in 2026-05-10.
 *
 * What dedups vs what does NOT:
 *   - Plain text / json / csv with the SAME (file_path, offset, limit, mtime)
 *     dedups. Different offset/limit re-emits because the model wants a
 *     different slice.
 *   - PDF / Office / notebook with the SAME (file_path, max_chars, mtime,
 *     xlsx-spec hash) dedups. PDF visual (with `pages=`) does NOT dedup
 *     because we'd still pay sub-LLM describe-pass cost on non-vision
 *     endpoints and bytes-vs-bytes equality on pdftoppm rasterization is
 *     not stable enough to be a safe key.
 *   - Image files do NOT dedup at this layer — the describe-cache I added
 *     in 2026-05-10 already covers the sub-LLM call site.
 */

interface DedupKey {
  filePath: string
  mtimeMs: number
  variant: string
}

const MAX_ENTRIES = 256

interface DedupEntry {
  insertedAt: number
}

const seen = new Map<string, DedupEntry>()

function keyFor(input: DedupKey): string {
  return `${input.filePath}|${input.mtimeMs}|${input.variant}`
}

/** Returns true if this exact (file, mtime, variant) was already Read in
 *  the current daemon lifetime. */
export function hasBeenRead(input: DedupKey): boolean {
  return seen.has(keyFor(input))
}

/** Record a successful Read so a subsequent identical call can return the
 *  unchanged stub. */
export function markRead(input: DedupKey): void {
  const key = keyFor(input)
  seen.delete(key)
  seen.set(key, { insertedAt: Date.now() })
  while (seen.size > MAX_ENTRIES) {
    const oldest = seen.keys().next().value
    if (oldest === undefined) break
    seen.delete(oldest)
  }
}

/** Returns true if ANY Read variant for this path has been cached in the
 *  current daemon lifetime. Path-only (no mtime/variant lookup) — used by
 *  Write to drop a soft "Read first" reminder without needing the precise
 *  key the model would have hit. Linear over `seen` (≤ MAX_ENTRIES entries),
 *  so this is O(256) at worst — fine for a per-Write check. */
export function hasPathBeenRead(filePath: string): boolean {
  const prefix = `${filePath}|`
  for (const key of seen.keys()) {
    if (key.startsWith(prefix)) return true
  }
  return false
}

/** Test hook — wipe the cache. */
export function _clearReadDedupForTests(): void {
  seen.clear()
}

/** Test hook — current size. */
export function _readDedupSizeForTests(): number {
  return seen.size
}
