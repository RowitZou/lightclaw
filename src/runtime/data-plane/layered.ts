import type { DataPlane, DataPlaneKind, GlobOptions, PathPolicy, RuntimeStat } from '../types.js'

export class DataPlaneNotApplicableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DataPlaneNotApplicableError'
  }
}

export class LayeredDataPlane implements DataPlane {
  readonly kind: DataPlaneKind
  readonly independentFromControl: boolean
  readonly reliability: DataPlane['reliability']

  constructor(
    private readonly layers: ReadonlyArray<DataPlane>,
    private readonly policy: PathPolicy,
    private readonly config: { maxExecRelayBytes: number } = { maxExecRelayBytes: 4 * 1024 * 1024 },
  ) {
    if (layers.length === 0) {
      throw new Error('LayeredDataPlane requires at least one layer')
    }
    this.kind = layers[0].kind
    this.independentFromControl = layers.every(layer => layer.independentFromControl)
    this.reliability = layers[0].reliability
  }

  async readFile(pathname: string): Promise<Buffer> {
    if (!this.policy.isAllowed(pathname, 'read')) {
      throw new Error(`Path is not allowed for read: ${pathname}`)
    }
    return this.tryLayers('read', pathname, async layer => {
      if (layer.kind === 'exec-relay') {
        const stat = await layer.stat(pathname).catch(() => null)
        if (stat && stat.size > this.config.maxExecRelayBytes) {
          throw new Error(
            `LayeredDataPlane: refusing to read ${pathname} (${stat.size} B) via exec-relay; ` +
              'host-mount fast path unavailable.',
          )
        }
      }
      return layer.readFile(pathname)
    })
  }

  async writeFile(pathname: string, content: Buffer | string): Promise<void> {
    if (!this.policy.isAllowed(pathname, 'write')) {
      throw new Error(`Path is not allowed for write: ${pathname}`)
    }
    return this.tryLayers('write', pathname, layer => layer.writeFile(pathname, content))
  }

  async stat(pathname: string): Promise<RuntimeStat> {
    if (!this.policy.isAllowed(pathname, 'stat')) {
      throw new Error(`Path is not allowed for stat: ${pathname}`)
    }
    return this.tryLayers('stat', pathname, layer => layer.stat(pathname))
  }

  async glob(pattern: string | string[], options?: GlobOptions): Promise<string[]> {
    const cwd = options?.cwd
    if (cwd && !this.policy.isAllowed(cwd, 'read')) {
      throw new Error(`Path is not allowed for glob: ${cwd}`)
    }
    return this.tryLayers('glob', cwd ?? '<workspace>', layer => layer.glob(pattern, options))
  }

  async readdir(pathname: string): Promise<string[]> {
    if (!this.policy.isAllowed(pathname, 'read')) {
      throw new Error(`Path is not allowed for readdir: ${pathname}`)
    }
    return this.tryLayers('readdir', pathname, layer => layer.readdir(pathname))
  }

  private async tryLayers<T>(
    op: string,
    pathname: string,
    fn: (layer: DataPlane) => Promise<T>,
  ): Promise<T> {
    let lastError: unknown
    const applicable = this.layers.filter(layer => this.canHandle(layer, pathname))
    for (const [index, layer] of applicable.entries()) {
      try {
        return await fn(layer)
      } catch (error) {
        lastError = error
        if (isFatalFsError(error) || index === applicable.length - 1) {
          throw error
        }
        process.stderr.write(
          `[runtime] layered ${op} fall-through: ${layer.kind} -> next; ` +
            `err=${error instanceof Error ? error.message : String(error)}\n`,
        )
      }
    }
    if (lastError instanceof Error) {
      throw lastError
    }
    throw new Error(`No data plane can ${op} ${pathname}`)
  }

  private canHandle(layer: DataPlane, pathname: string): boolean {
    if (layer.kind === 'exec-relay' || layer.kind === 'host-direct') return true
    return this.policy.isShared(pathname)
  }
}

export function isFatalFsError(error: unknown): boolean {
  if (error instanceof DataPlaneNotApplicableError) return false
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
  return ['ENOENT', 'EACCES', 'EISDIR', 'ENOTDIR', 'EPERM'].includes(code ?? '')
}
