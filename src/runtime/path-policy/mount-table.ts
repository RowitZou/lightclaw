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

  isAllowed(workerPath: string, op: 'read' | 'write' | 'stat'): boolean {
    if (hasTraversal(workerPath)) {
      return false
    }
    const normalizedWorker = path.posix.normalize(workerPath)
    const mount = this.findMount(normalizedWorker)
    if (op === 'write' && mount?.mode === 'ro') {
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

function hasTraversal(pathname: string): boolean {
  return pathname.split(/[\\/]+/).includes('..')
}

function isSameOrChildPosix(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}/`)
}

function isSameOrChildHost(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`)
}
