const enabled = process.env.LIGHTCLAW_STALL_TRACE !== '0'

export function stallTrace(event: string, fields: Record<string, unknown> = {}): void {
  if (!enabled) return
  const ts = new Date().toISOString().slice(11, 23)
  const parts = [`[stall-trace] ${ts} ${event}`]
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue
    const rendered =
      typeof v === 'string'
        ? v
        : typeof v === 'number' || typeof v === 'boolean'
        ? String(v)
        : JSON.stringify(v)
    parts.push(`${k}=${rendered}`)
  }
  process.stderr.write(parts.join(' ') + '\n')
}

export function startStallTimer(event: string, fields: Record<string, unknown> = {}): () => void {
  if (!enabled) return () => {}
  const started = Date.now()
  stallTrace(`${event}-start`, fields)
  return () => {
    stallTrace(`${event}-end`, { ...fields, ms: Date.now() - started })
  }
}
