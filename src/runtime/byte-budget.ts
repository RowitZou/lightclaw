import type { DataPlane } from './types.js'
import type { Readable } from 'node:stream'

export type ByteBudgetRelease = () => void

type Waiter = {
  bytes: number
  resolve: (release: ByteBudgetRelease) => void
  reject: (error: Error) => void
}

/** Process-wide accounting primitive for whole-buffer filesystem IO. */
export class ByteBudget {
  private limit: number
  private used = 0
  private peak = 0
  private readonly waiters: Waiter[] = []

  constructor(limitBytes: number) {
    this.limit = normalizeLimit(limitBytes)
  }

  get limitBytes(): number { return this.limit }
  get inUseBytes(): number { return this.used }
  get peakInUseBytes(): number { return this.peak }

  setLimit(limitBytes: number): void {
    this.limit = normalizeLimit(limitBytes)
    this.drain()
  }

  acquire(bytes: number): Promise<ByteBudgetRelease> {
    const requested = normalizeBytes(bytes)
    if (requested > this.limit) {
      return Promise.reject(new Error(
        `DataPlane IO requires ${requested} B, exceeding the process-wide byte budget of ${this.limit} B.`,
      ))
    }
    if (this.waiters.length === 0 && this.used + requested <= this.limit) {
      return Promise.resolve(this.reserve(requested))
    }
    return new Promise<ByteBudgetRelease>((resolve, reject) => {
      this.waiters.push({ bytes: requested, resolve, reject })
      this.drain()
    })
  }

  private reserve(bytes: number): ByteBudgetRelease {
    this.used += bytes
    this.peak = Math.max(this.peak, this.used)
    let released = false
    return () => {
      if (released) return
      released = true
      this.used -= bytes
      this.drain()
    }
  }

  private drain(): void {
    while (this.waiters.length > 0) {
      const next = this.waiters[0]
      if (!next) return
      if (next.bytes > this.limit) {
        this.waiters.shift()
        next.reject(new Error(
          `DataPlane IO requires ${next.bytes} B, exceeding the process-wide byte budget of ${this.limit} B.`,
        ))
        continue
      }
      if (this.used + next.bytes > this.limit) return
      this.waiters.shift()
      next.resolve(this.reserve(next.bytes))
    }
  }
}

const DEFAULT_IO_BUDGET_BYTES = 3072 * 1024 * 1024
const globalByteBudget = new ByteBudget(DEFAULT_IO_BUDGET_BYTES)

export function configureGlobalByteBudget(limitBytes: number): ByteBudget {
  globalByteBudget.setLimit(limitBytes)
  return globalByteBudget
}

export function getGlobalByteBudget(): ByteBudget {
  return globalByteBudget
}

/** Wrap whole-buffer reads/writes without changing the underlying DataPlane semantics. */
export function withByteBudget(
  inner: DataPlane,
  budget: ByteBudget = globalByteBudget,
): DataPlane {
  const withReservation = async <T>(bytes: number, fn: () => Promise<T>): Promise<T> => {
    const release = await budget.acquire(bytes)
    try {
      return await fn()
    } finally {
      release()
    }
  }
  const sizedRead = async (pathname: string, fn: () => Promise<Buffer>): Promise<Buffer> => {
    const info = await inner.stat(pathname)
    return withReservation(info.size, fn)
  }
  return {
    kind: inner.kind,
    independentFromControl: inner.independentFromControl,
    reliability: inner.reliability,
    readFile: pathname => sizedRead(pathname, () => inner.readFile(pathname)),
    ...(inner.createReadStream
      ? {
          createReadStream: async (pathname: string): Promise<Readable> => {
            const info = await inner.stat(pathname)
            const release = await budget.acquire(info.size)
            try {
              const stream = await inner.createReadStream!(pathname)
              let settled = false
              const releaseOnce = () => {
                if (settled) return
                settled = true
                release()
              }
              stream.once('end', releaseOnce)
              stream.once('close', releaseOnce)
              stream.once('error', releaseOnce)
              return stream
            } catch (error) {
              release()
              throw error
            }
          },
        }
      : {}),
    writeFile: (pathname, content) => withReservation(
      typeof content === 'string' ? Buffer.byteLength(content) : content.length,
      () => inner.writeFile(pathname, content),
    ),
    ...(inner.chmod ? { chmod: (pathname: string, mode: number) => inner.chmod!(pathname, mode) } : {}),
    stat: pathname => inner.stat(pathname),
    readdir: pathname => inner.readdir(pathname),
    ...(inner.writeFileViaHostMount
      ? { writeFileViaHostMount: (pathname: string, content: Buffer) => inner.writeFileViaHostMount!(pathname, content) }
      : {}),
    ...(inner.readFileViaHostMount
      ? { readFileViaHostMount: (pathname: string) => inner.readFileViaHostMount!(pathname) }
      : {}),
  }
}

function normalizeLimit(value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error('ByteBudget limit must be positive.')
  return Math.floor(value)
}

function normalizeBytes(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error('ByteBudget request must be non-negative.')
  return Math.floor(value)
}
