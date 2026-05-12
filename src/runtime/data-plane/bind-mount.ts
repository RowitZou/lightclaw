import * as fsp from 'node:fs/promises'
import path from 'node:path'

import fastGlob from 'fast-glob'

import type { DataPlane, GlobOptions, PathPolicy, RuntimeStat } from '../types.js'
import { DataPlaneNotApplicableError } from './layered.js'

export class BindMountData implements DataPlane {
  readonly kind = 'bind-mount' as const
  readonly independentFromControl = true
  readonly reliability = 'fs-semantic' as const

  constructor(private readonly policy: PathPolicy) {}

  async readFile(workerPath: string): Promise<Buffer> {
    return fsp.readFile(this.hostPath(workerPath))
  }

  async writeFile(workerPath: string, content: Buffer | string): Promise<void> {
    const hostPath = this.hostPath(workerPath)
    await fsp.mkdir(path.dirname(hostPath), { recursive: true })
    await fsp.writeFile(hostPath, content)
  }

  async stat(workerPath: string): Promise<RuntimeStat> {
    const result = await fsp.stat(this.hostPath(workerPath))
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
      throw new DataPlaneNotApplicableError('bind-mount has no mount root for glob')
    }
    return fastGlob(pattern, {
      cwd,
      ignore: options.ignore,
      onlyFiles: options.onlyFiles ?? true,
      dot: options.dot ?? false,
    })
  }

  async readdir(workerPath: string): Promise<string[]> {
    return fsp.readdir(this.hostPath(workerPath))
  }

  private hostPath(workerPath: string): string {
    const hostPath = this.policy.toHostPath(workerPath)
    if (!hostPath) {
      throw new DataPlaneNotApplicableError(`${workerPath} is not in a bind mount`)
    }
    return hostPath
  }
}
