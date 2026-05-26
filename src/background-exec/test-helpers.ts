import path from 'node:path'

import type { Runtime, RuntimeStat } from '../runtime/index.js'
import type { ExecInput, ExecResult } from '../runtime/types.js'

export class FakeRuntime {
  readonly kind = 'local' as const
  readonly isolated = false
  readonly workspaceRoot = '/workspace'
  readonly scratchRoot = '/scratch'
  readonly securityProfile = 'host-trusted' as const
  readonly control = {} as Runtime['control']
  readonly paths = {} as Runtime['paths']
  readonly execCalls: ExecInput[] = []
  private readonly files = new Map<string, Buffer>()
  private readonly dirs = new Set<string>(['/workspace'])
  private execQueue: Array<ExecResult | { throw: Error } | { callback: () => Promise<ExecResult> }> = []

  readonly fs = {
    kind: 'host-direct' as const,
    independentFromControl: true,
    reliability: 'fs-semantic' as const,
    readFile: async (pathname: string): Promise<Buffer> => {
      const file = this.files.get(pathname)
      if (!file) {
        throw Object.assign(new Error(`ENOENT: ${pathname}`), { code: 'ENOENT' })
      }
      return file
    },
    writeFile: async (pathname: string, content: Buffer | string): Promise<void> => {
      this.dirs.add(path.posix.dirname(pathname))
      this.files.set(pathname, Buffer.isBuffer(content) ? content : Buffer.from(content))
    },
    stat: async (pathname: string): Promise<RuntimeStat> => {
      const file = this.files.get(pathname)
      if (file) {
        return { size: file.length, isFile: true, isDirectory: false, mtimeMs: Date.now() }
      }
      if (this.dirs.has(pathname)) {
        return { size: 0, isFile: false, isDirectory: true, mtimeMs: Date.now() }
      }
      throw Object.assign(new Error(`ENOENT: ${pathname}`), { code: 'ENOENT' })
    },
    readdir: async (pathname: string): Promise<string[]> => {
      if (!this.dirs.has(pathname)) {
        throw Object.assign(new Error(`ENOENT: ${pathname}`), { code: 'ENOENT' })
      }
      return [...this.files.keys()]
        .filter(file => path.posix.dirname(file) === pathname)
        .map(file => path.posix.basename(file))
    },
  }

  readonly data = this.fs

  queueExec(result: ExecResult): void {
    this.execQueue.push(result)
  }

  queueExecError(error: Error): void {
    this.execQueue.push({ throw: error })
  }

  // For race-window tests: the callback runs when this exec is dequeued and
  // can perform side effects (e.g. write the exit sentinel to simulate the
  // bg-runner wrapper landing its `mv exit.tmp exit` during the probe's
  // `kill -0` call) before returning the simulated kill-0 exit code.
  queueExecCallback(callback: () => Promise<ExecResult>): void {
    this.execQueue.push({ callback })
  }

  async exec(input: ExecInput): Promise<ExecResult> {
    this.execCalls.push(input)
    if (input.command.startsWith('mkdir -p ')) {
      const match = input.command.match(/'([^']+)'/)
      if (match) {
        this.dirs.add(match[1])
      }
    }
    const killedMatch = input.command.match(/>\s*'([^']+\/killed)'/)
    if (killedMatch) {
      await this.fs.writeFile(killedMatch[1], 'killed')
    }
    const next = this.execQueue.shift()
    if (next && 'throw' in next) {
      throw next.throw
    }
    if (next && 'callback' in next) {
      return await next.callback()
    }
    return next ?? { stdout: '', stderr: '', exitCode: 0 }
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  isRunning(): boolean { return true }
  async isAvailable(): Promise<{ ok: true }> { return { ok: true } }

  asRuntime(): Runtime {
    return this as unknown as Runtime
  }
}
