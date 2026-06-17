import { constants as fsConstants, statSync } from 'node:fs'
import { access } from 'node:fs/promises'

import type { LightClawConfig } from '../config.js'
import { resolveGpfsMountRule } from '../runtime/gpfs-mount-rules.js'
import { normalizeRlaunchMountPath } from '../runtime/rlaunch-mounts.js'

export type DataRootValidationResult =
  | { ok: true; path: string }
  | { ok: false; reason: string }

export function normalizeUserDataRootPath(input: string): string {
  return normalizeRlaunchMountPath(input)
}

export async function validateUserDataRootPath(
  input: string,
  config: LightClawConfig,
): Promise<DataRootValidationResult> {
  let normalized: string
  try {
    normalized = normalizeUserDataRootPath(input)
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }

  if (config.runtime.backend === 'cluster') {
    try {
      resolveGpfsMountRule(normalized, config.runtime.clusterSettings)
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  try {
    const stat = statSync(normalized)
    if (!stat.isDirectory()) {
      return { ok: false, reason: `dataRoot path exists but is not a directory: ${normalized}` }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        ok: false,
        reason: `dataRoot path does not exist: ${normalized}. Create the directory first, then run /config set-home again.`,
      }
    }
    return {
      ok: false,
      reason: `dataRoot is not accessible: ${normalized} (${error instanceof Error ? error.message : String(error)})`,
    }
  }

  try {
    await access(normalized, fsConstants.R_OK | fsConstants.W_OK)
  } catch (error) {
    return {
      ok: false,
      reason: `dataRoot must be readable and writable by the daemon: ${normalized} (${error instanceof Error ? error.message : String(error)})`,
    }
  }

  return { ok: true, path: normalized }
}
