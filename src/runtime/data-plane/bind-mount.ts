import * as fsp from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'

import type { DataPlane, PathPolicy, RuntimeStat } from '../types.js'
import { DataPlaneNotApplicableError } from './layered.js'

export class BindMountData implements DataPlane {
  readonly kind = 'bind-mount' as const
  readonly independentFromControl = true
  readonly reliability = 'fs-semantic' as const

  constructor(private readonly policy: PathPolicy) {}

  async readFile(workerPath: string): Promise<Buffer> {
    return fsp.readFile(this.hostPath(workerPath))
  }

  async createReadStream(workerPath: string) {
    return createReadStream(this.hostPath(workerPath))
  }

  async writeFile(workerPath: string, content: Buffer | string): Promise<void> {
    const hostPath = this.hostPath(workerPath)
    await fsp.mkdir(path.dirname(hostPath), { recursive: true })
    await fsp.writeFile(hostPath, content)
  }

  async chmod(workerPath: string, mode: number): Promise<void> {
    await fsp.chmod(this.hostPath(workerPath), mode)
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
