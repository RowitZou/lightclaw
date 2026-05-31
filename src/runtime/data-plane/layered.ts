import type { DataPlane, DataPlaneKind, PathPolicy, RuntimeStat } from '../types.js'

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
    // Read-only mount writes must be rejected BEFORE any layer runs — host-fs
    // layers (bind-mount / shared-cluster-fs) running daemon-side would
    // otherwise bypass the worker-visible read-only flag. Other rejection
    // shapes (out-of-mount, `..` traversal) are left to each layer's own
    // path translation so the legacy "Path is not within ..." error text is
    // preserved verbatim.
    if (!this.policy.isAllowed(pathname, 'write')) {
      throw new Error(`Cannot write to read-only mount: ${pathname}`)
    }
    return this.tryLayers('write', pathname, layer => layer.writeFile(pathname, content))
  }

  async chmod(pathname: string, mode: number): Promise<void> {
    if (!this.policy.isAllowed(pathname, 'write')) {
      throw new Error(`Cannot chmod read-only mount: ${pathname}`)
    }
    return this.tryLayers('chmod', pathname, async layer => {
      if (!layer.chmod) {
        throw new DataPlaneNotApplicableError(`${layer.kind} cannot chmod ${pathname}`)
      }
      return layer.chmod(pathname, mode)
    })
  }

  async stat(pathname: string): Promise<RuntimeStat> {
    return this.tryLayers('stat', pathname, layer => layer.stat(pathname))
  }

  async readdir(pathname: string): Promise<string[]> {
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
