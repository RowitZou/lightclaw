import path from 'node:path'

import type { RlaunchGpfsMountRule, RlaunchRuntimeSettings } from '../config.js'
import { expandHomePath } from '../paths.js'

/**
 * The subset of rlaunch settings the gpfs translation needs: the `gpfsMounts`
 * host→gpfs rule table. Tools and tests can pass either the full
 * `RlaunchRuntimeSettings` or a hand-built object of this shape.
 */
export type RlaunchGpfsMountConfig = Pick<RlaunchRuntimeSettings, 'gpfsMounts'>

export function buildGpfsMountStringFromRules(
  hostPathInput: string,
  workerPathInput: string,
  rlaunchConfig: RlaunchGpfsMountConfig,
): string {
  const hostPath = normalizeHostPath(hostPathInput)
  const workerPath = path.posix.normalize(workerPathInput)
  if (!workerPath.startsWith('/')) {
    throw new Error(`rlaunch worker mount path must be absolute: ${workerPathInput}`)
  }
  const { rule, suffix } = resolveGpfsMountRule(hostPath, rlaunchConfig)
  return `${rule.mountPrefix}${suffix ? `/${suffix}` : ''}:${workerPath}`
}

export function resolveGpfsMountRule(
  hostPathInput: string,
  rlaunchConfig: RlaunchGpfsMountConfig,
): { rule: RlaunchGpfsMountRule; suffix: string } {
  const hostPath = normalizeHostPath(hostPathInput)
  const rules = normalizeGpfsMountRules(rlaunchConfig)
  const matches = rules.filter(rule =>
    hostPath === rule.hostPrefix || hostPath.startsWith(`${rule.hostPrefix}${path.sep}`),
  )
  matches.sort((a, b) => b.hostPrefix.length - a.hostPrefix.length)
  const rule = matches[0]
  if (!rule) {
    throw new Error(
      `rlaunch mount path must be under one of runtime.clusterSettings.gpfsMounts hostPrefix values ` +
      `(${rules.map(item => item.hostPrefix).join(', ')}); got ${hostPath}`,
    )
  }
  const suffix = hostPath.slice(rule.hostPrefix.length).split(path.sep).filter(Boolean).join('/')
  return { rule, suffix }
}

/**
 * The minimum number of path segments a workspace / rw mount must sit BELOW a
 * gpfs `hostPrefix`. `<prefix>` (depth 0) is the mount root and `<prefix>/<team>`
 * (depth 1) is a public/shared top-level directory; both are too broad to be a
 * workspace or a whole-tree mount — they pollute the shared space and trigger
 * GPFS metadata storms on recursive ops. Real per-user work lives at
 * `<prefix>/<team-or-project>/<user>` (depth 2) or deeper. This is a footgun
 * guardrail, NOT an isolation boundary: uid alignment on the cluster means the
 * agent can already reach shared paths via Bash regardless, and the mount `mode`
 * is neither knowable for worker-only mounts nor kernel-enforced against Bash —
 * so the guard refuses by path depth alone, ignoring ro/rw and scope.
 *
 * The depth floor is per-prefix: each `gpfsMounts` rule may set its own
 * `minWorkspaceDepth` (the private layer can sit at a different level per
 * deployment / per filesystem); this is the fallback when the matched rule
 * omits it. `0` on a rule disables the guard for that prefix.
 */
export const MIN_GPFS_PATH_DEPTH = 2

/**
 * Returns the matched gpfs `hostPrefix` when `hostPath` sits FEWER than that
 * prefix's required depth below it (i.e. it is the mount root or a top-level
 * shared dir), else `null`. The required depth is the matched rule's
 * `minWorkspaceDepth`, falling back to `MIN_GPFS_PATH_DEPTH`. Returns `null`
 * when the path is under no configured gpfs prefix — "must be under a prefix" is
 * a separate validation's job; this guard only refuses paths that ARE under a
 * prefix but too shallow.
 */
export function findShallowGpfsRoot(
  hostPathInput: string,
  rlaunchConfig: RlaunchGpfsMountConfig,
): string | null {
  let resolved: { rule: RlaunchGpfsMountRule; suffix: string }
  try {
    resolved = resolveGpfsMountRule(hostPathInput, rlaunchConfig)
  } catch {
    return null
  }
  const minDepth = resolved.rule.minWorkspaceDepth ?? MIN_GPFS_PATH_DEPTH
  const segments = resolved.suffix.split('/').filter(Boolean)
  return segments.length < minDepth ? resolved.rule.hostPrefix : null
}

export function normalizeGpfsMountRules(
  rlaunchConfig: RlaunchGpfsMountConfig,
): RlaunchGpfsMountRule[] {
  const byHostPrefix = new Map<string, RlaunchGpfsMountRule>()
  const addRule = (rule: RlaunchGpfsMountRule): void => {
    if (!rule.hostPrefix.trim()) {
      throw new Error('runtime.clusterSettings.gpfsMounts hostPrefix must be a non-empty string.')
    }
    const hostPrefix = normalizeHostPath(rule.hostPrefix)
    const mountPrefix = rule.mountPrefix.replace(/\/+$/, '')
    if (!mountPrefix) {
      throw new Error('runtime.clusterSettings.gpfsMounts mountPrefix must be a non-empty string.')
    }
    byHostPrefix.set(hostPrefix, {
      hostPrefix,
      mountPrefix,
      ...(rule.minWorkspaceDepth !== undefined ? { minWorkspaceDepth: rule.minWorkspaceDepth } : {}),
    })
  }

  const configuredRules = rlaunchConfig.gpfsMounts ?? []
  if (configuredRules.length === 0) {
    throw new Error('runtime.clusterSettings.gpfsMounts must contain at least one rule.')
  }
  for (const rule of configuredRules) {
    addRule(rule)
  }

  return [...byHostPrefix.values()].sort((a, b) => b.hostPrefix.length - a.hostPrefix.length)
}

function normalizeHostPath(input: string): string {
  return path.resolve(expandHomePath(input.trim()))
}
