import { constants as fsConstants } from 'node:fs'
import * as fsp from 'node:fs/promises'
import path from 'node:path'

import type { MountEntry, PathPolicy } from '../types.js'

/**
 * Thrown by {@link validateMountTable} when two mount entries overlap. The
 * `.message` stays English so runtime backends that build a PathPolicy can log
 * it to stderr unchanged; the user-facing `/system mount` command boundary
 * catches this and renders the i18n `mount.overlap` string instead.
 */
export class MountOverlapError extends Error {
  constructor(
    readonly workerA: string,
    readonly workerB: string,
  ) {
    super(`Overlapping runtime mount entries are not allowed: ${workerA} <-> ${workerB}`)
    this.name = 'MountOverlapError'
  }
}

export class MountTablePathPolicy implements PathPolicy {
  readonly mountTable: ReadonlyArray<MountEntry>

  constructor(entries: ReadonlyArray<MountEntry>) {
    this.mountTable = entries.map(entry => ({
      host: path.resolve(entry.host),
      worker: path.posix.normalize(entry.worker),
      mode: entry.mode,
      ...(entry.daemonVisible === false ? { daemonVisible: false } : {}),
    }))
    validateMountTable(this.mountTable)
  }

  toHostPath(workerPath: string): string | null {
    const normalizedWorker = path.posix.normalize(workerPath)
    for (const mount of this.mountTable) {
      if (mount.daemonVisible === false) continue
      if (isSameOrChildPosix(normalizedWorker, mount.worker)) {
        return path.join(mount.host, normalizedWorker.slice(mount.worker.length))
      }
    }

    const resolvedHost = path.resolve(workerPath)
    for (const mount of this.mountTable) {
      if (mount.daemonVisible === false) continue
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
   * `daemonVisible: false` (worker-only) entries are exempt: they have no
   * daemon-side byte path to gate (`toHostPath` skips them, so writes go
   * through exec-relay INSIDE the worker where the cluster's real permission
   * applies), and their recorded `ro` is only a probe placeholder — the
   * daemon cannot observe the true mode. Enforcing the placeholder here
   * blocked Write/Edit on paths Bash could legitimately write.
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
    if (mount?.mode === 'ro' && mount.daemonVisible !== false) {
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
        throw new MountOverlapError(a.worker, b.worker)
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

/**
 * Startup-time probe: assert that every mount in `policy.mountTable` is
 * reachable from the daemon side with the perms required by its `mode`.
 *
 * This catches misconfigured mounts before the runtime starts serving tool
 * calls. Without this check, a `bind-mount` / `shared-cluster-fs` layer
 * that the daemon cannot access would sticky-disable on the first op and
 * silently fall back to exec-relay — re-introducing the Bug 1 large-read
 * regression risk and burying the misconfig in a single stderr line nobody
 * reads. Fail loud at start instead.
 *
 * Scope:
 * - Only probes the mount **entry points** (each `MountEntry.host`), not
 *   per-file perms inside. Runtime-time per-file perm issues stay with
 *   the layer-level sticky-disabled flag.
 * - For `rw` mounts, requires R_OK | W_OK; for `ro`, requires R_OK only.
 * - Throws on first failure with a clear admin message including the
 *   mount entry, mode, and original errno text. The exception is meant
 *   to abort `Runtime.start()` and surface via init.ts / RuntimePool to
 *   the admin (typically via stderr or a system notice).
 *
 * Use from `DockerRuntime.start()` and `RlaunchRuntime._startOnce()` only.
 * LocalRuntime has an empty mountTable and treats every path as host, so
 * the probe is a no-op for it.
 */
export async function assertMountsAccessible(
  policy: PathPolicy,
  runtimeKind: string,
): Promise<void> {
  for (const mount of policy.mountTable) {
    if (mount.daemonVisible === false) continue
    const required = fsConstants.R_OK | (mount.mode === 'rw' ? fsConstants.W_OK : 0)
    try {
      await fsp.access(mount.host, required)
    } catch (error) {
      const errnoCode = error instanceof Error && 'code' in error
        ? String((error as { code?: unknown }).code)
        : ''
      const msg = error instanceof Error ? error.message : String(error)
      throw new Error(
        `[${runtimeKind}] runtime mount ${mount.worker} (host=${mount.host}, mode=${mount.mode}) ` +
        `is not accessible from daemon${errnoCode ? ` (${errnoCode})` : ''}: ${msg}. ` +
        `Fix the host path / permissions, or remove the entry from runtime.${runtimeKind}.mounts.`,
      )
    }
  }
}
