// Mirrors claude-code-main/src/memdir/memoryAge.ts. The motivation is identical:
// stale code-state memories with file:line citations sound MORE authoritative,
// not less, when re-injected without a timestamp signal. Day-precision text
// ("47 days ago") triggers a model's staleness reasoning much more reliably
// than a raw ISO timestamp.

const DAY_MS = 86_400_000

/**
 * Days elapsed since mtime. Floor-rounded — 0 for today, 1 for yesterday,
 * 2+ for older. Negative inputs (future mtime, clock skew) clamp to 0.
 */
export function memoryAgeDays(mtimeMs: number): number {
  return Math.max(0, Math.floor((Date.now() - mtimeMs) / DAY_MS))
}

/**
 * Human-readable age string. Models are poor at date arithmetic — a raw ISO
 * timestamp does not trigger staleness reasoning the way "47 days ago" does.
 */
export function memoryAge(mtimeMs: number): string {
  const days = memoryAgeDays(mtimeMs)
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${days} days ago`
}

/**
 * Plain-text staleness caveat for memories >1 day old. Returns '' for fresh
 * (today/yesterday) memories — a warning there is noise. Both the recall
 * renderer and the MemoryRead tool wrap this string in a <system-reminder>
 * before showing it to the model.
 */
export function memoryFreshnessText(mtimeMs: number): string {
  const days = memoryAgeDays(mtimeMs)
  if (days <= 1) return ''
  return (
    `This memory is ${days} days old. ` +
    'Memories are point-in-time observations, not live state — ' +
    'claims about code behavior or file:line citations may be outdated. ' +
    'Verify against current code before asserting as fact.'
  )
}
