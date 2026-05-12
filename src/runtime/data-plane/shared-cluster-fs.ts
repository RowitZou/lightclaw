import * as fsp from 'node:fs/promises'
import path from 'node:path'

import fastGlob from 'fast-glob'

import type { DataPlane, GlobOptions, PathPolicy, RuntimeStat } from '../types.js'
import { DataPlaneNotApplicableError, isFatalFsError } from './layered.js'

export class SharedClusterFsData implements DataPlane {
  readonly kind = 'shared-cluster-fs' as const
  readonly independentFromControl = true
  readonly reliability = 'fs-semantic' as const

  private disabled = false

  constructor(
    private readonly policy: PathPolicy,
    private readonly workerName: () => string | null,
  ) {}

  async readFile(workerPath: string): Promise<Buffer> {
    const hostPath = this.hostPath(workerPath)
    return this.guard('read', () => fsp.readFile(hostPath))
  }

  async writeFile(workerPath: string, content: Buffer | string): Promise<void> {
    const hostPath = this.hostPath(workerPath)
    return this.guard('write', async () => {
      await fsp.mkdir(path.dirname(hostPath), { recursive: true })
      await fsp.writeFile(hostPath, content)
    })
  }

  async stat(workerPath: string): Promise<RuntimeStat> {
    const hostPath = this.hostPath(workerPath)
    const result = await this.guard('stat', () => fsp.stat(hostPath))
    return {
      size: result.size,
      isFile: result.isFile(),
      isDirectory: result.isDirectory(),
      mtimeMs: result.mtimeMs,
    }
  }

  async glob(pattern: string | string[], options: GlobOptions = {}): Promise<string[]> {
    const cwd = options.cwd ? this.hostPath(options.cwd) : this.policy.mountTable[0]?.host
    if (!cwd) {
      throw new DataPlaneNotApplicableError('shared-cluster-fs has no mount root for glob')
    }
    return this.guard('glob', async () => fastGlob(pattern, {
      cwd,
      ignore: options.ignore,
      onlyFiles: options.onlyFiles ?? true,
      dot: options.dot ?? false,
    }))
  }

  async readdir(workerPath: string): Promise<string[]> {
    const hostPath = this.hostPath(workerPath)
    return this.guard('readdir', () => fsp.readdir(hostPath))
  }

  private hostPath(workerPath: string): string {
    if (this.disabled) {
      throw new DataPlaneNotApplicableError(
        `shared-cluster-fs disabled for worker ${this.workerName() ?? '<unbound>'}`,
      )
    }
    const hostPath = this.policy.toHostPath(workerPath)
    if (!hostPath) {
      throw new DataPlaneNotApplicableError(`${workerPath} is not in a shared mount`)
    }
    return hostPath
  }

  private async guard<T>(op: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (error) {
      if (!isFatalFsError(error)) {
        this.disabled = true
        process.stderr.write(
          `[runtime] shared-cluster-fs disabled for worker ${this.workerName() ?? '<unbound>'}; ` +
            `op=${op}; falling back to control-plane relay: ` +
            `${error instanceof Error ? error.message : String(error)}\n`,
        )
      }
      throw error
    }
  }
}
