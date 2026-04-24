import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const TTL_MS = 24 * 60 * 60 * 1000
const MAX_MEMORY_ENTRIES = 10_000

export class FeishuDedup {
  private memory = new Map<string, number>()
  private loaded = false

  constructor(private filePath: string) {}

  async claim(eventId: string): Promise<boolean> {
    const id = eventId.trim()
    if (!id) {
      return false
    }

    await this.load()
    const now = Date.now()
    this.prune(now)
    if (this.memory.has(id)) {
      return false
    }

    this.memory.set(id, now)
    this.capMemory()
    await this.flush()
    return true
  }

  private async load(): Promise<void> {
    if (this.loaded) {
      return
    }
    this.loaded = true

    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as Record<string, number>
      for (const [id, timestamp] of Object.entries(parsed)) {
        if (Number.isFinite(timestamp)) {
          this.memory.set(id, timestamp)
        }
      }
      this.prune(Date.now())
    } catch {
      // Missing or corrupt dedup state should not block webhook handling.
    }
  }

  private prune(now: number): void {
    for (const [id, timestamp] of this.memory) {
      if (now - timestamp > TTL_MS) {
        this.memory.delete(id)
      }
    }
  }

  private capMemory(): void {
    while (this.memory.size > MAX_MEMORY_ENTRIES) {
      const first = this.memory.keys().next().value as string | undefined
      if (!first) {
        return
      }
      this.memory.delete(first)
    }
  }

  private async flush(): Promise<void> {
    try {
      await mkdir(path.dirname(this.filePath), { recursive: true })
      await writeFile(
        this.filePath,
        `${JSON.stringify(Object.fromEntries(this.memory), null, 2)}\n`,
        'utf8',
      )
    } catch {
      // Memory dedup remains active even if disk persistence fails.
    }
  }
}
