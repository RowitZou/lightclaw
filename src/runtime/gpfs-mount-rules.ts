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

export function normalizeGpfsMountRules(
  rlaunchConfig: RlaunchGpfsMountConfig,
): RlaunchGpfsMountRule[] {
  const byHostPrefix = new Map<string, string>()
  const addRule = (rule: RlaunchGpfsMountRule): void => {
    if (!rule.hostPrefix.trim()) {
      throw new Error('runtime.clusterSettings.gpfsMounts hostPrefix must be a non-empty string.')
    }
    const hostPrefix = normalizeHostPath(rule.hostPrefix)
    const mountPrefix = rule.mountPrefix.replace(/\/+$/, '')
    if (!mountPrefix) {
      throw new Error('runtime.clusterSettings.gpfsMounts mountPrefix must be a non-empty string.')
    }
    byHostPrefix.set(hostPrefix, mountPrefix)
  }

  const configuredRules = rlaunchConfig.gpfsMounts ?? []
  if (configuredRules.length === 0) {
    throw new Error('runtime.clusterSettings.gpfsMounts must contain at least one rule.')
  }
  for (const rule of configuredRules) {
    addRule(rule)
  }

  return [...byHostPrefix.entries()]
    .map(([hostPrefix, mountPrefix]) => ({ hostPrefix, mountPrefix }))
    .sort((a, b) => b.hostPrefix.length - a.hostPrefix.length)
}

function normalizeHostPath(input: string): string {
  return path.resolve(expandHomePath(input.trim()))
}
