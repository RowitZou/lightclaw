import path from 'node:path'

import type { MountEntry, PathPolicy } from '../types.js'

export class MountTablePathPolicy implements PathPolicy {
  readonly mountTable: ReadonlyArray<MountEntry>

  constructor(entries: ReadonlyArray<MountEntry>) {
    this.mountTable = entries.map(entry => ({
      host: path.resolve(entry.host),
      worker: path.posix.normalize(entry.worker),
      mode: entry.mode,
    }))
    validateMountTable(this.mountTable)
  }

  toHostPath(workerPath: string): string | null {
    const normalizedWorker = path.posix.normalize(workerPath)
    for (const mount of this.mountTable) {
      if (isSameOrChildPosix(normalizedWorker, mount.worker)) {
        return path.join(mount.host, normalizedWorker.slice(mount.worker.length))
      }
    }

    const resolvedHost = path.resolve(workerPath)
    for (const mount of this.mountTable) {
      if (isSameOrChildHost(resolvedHost, mount.host)) {
        return resolvedHost
      }
    }
    return null
  }

  toWorkerPath(hostPath: string): string | null {
    const resolvedHost = path.resolve(hostPath)
    for (const mount of this.mountTable) {
      if (isSameOrChildHost(resolvedHost, mount.host)) {
        const suffix = resolvedHost.slice(mount.host.length)
        return path.posix.join(mount.worker, suffix.split(path.sep).join(path.posix.sep))
      }
    }
    return null
  }

  isShared(workerPath: string): boolean {
    return this.toHostPath(workerPath) !== null
  }

  /**
   * Reserved for sandbox constraints the data-plane layer cannot enforce on
   * its own. Currently only the `op === 'write' && mount.mode === 'ro'` case:
   * a `bind-mount` / `shared-cluster-fs` layer running daemon-side has host
   * write permission and would otherwise bypass the worker-visible read-only
   * flag. Returning `false` here causes LayeredDataPlane.writeFile to throw
   * before any layer runs.
   *
   * Phase 33 deliberately does NOT short-circuit `..` traversal here — each
   * backend's own path translation (`toContainerPath` in docker.ts /
   * rlaunch.ts) already throws `Path is not within {RuntimeKind}Runtime
   * workspace: ...` for traversal that escapes the mount. Letting that
   * natural error propagate preserves the pre-refactor error message text
   * verbatim (zero behavior change for the traversal-rejection path).
   */
  isAllowed(workerPath: string, op: 'read' | 'write' | 'stat'): boolean {
    if (op !== 'write') {
      return true
    }
    const normalizedWorker = path.posix.normalize(workerPath)
    const mount = this.findMount(normalizedWorker)
    if (mount?.mode === 'ro') {
      return false
    }
    return true
  }

  private findMount(workerPath: string): MountEntry | null {
    for (const mount of this.mountTable) {
      if (isSameOrChildPosix(workerPath, mount.worker)) {
        return mount
      }
    }
    return null
  }
}

function validateMountTable(entries: ReadonlyArray<MountEntry>): void {
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const a = entries[i]
      const b = entries[j]
      if (
        isSameOrChildHost(a.host, b.host) ||
        isSameOrChildHost(b.host, a.host) ||
        isSameOrChildPosix(a.worker, b.worker) ||
        isSameOrChildPosix(b.worker, a.worker)
      ) {
        throw new Error(`Overlapping runtime mount entries are not allowed: ${a.worker} <-> ${b.worker}`)
      }
    }
  }
}

function isSameOrChildPosix(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}/`)
}

function isSameOrChildHost(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`)
}
