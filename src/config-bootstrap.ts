import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'

import {
  atomicWriteJson,
  mergeExternalConfig,
  readJsonObjectOrEmpty,
} from './config-io.js'
import {
  parsePermissionModeInput,
  permissionModeToAlias,
  type PermissionMode,
} from './permission/types.js'
import { expandHomePath, lightclawHome } from './paths.js'

export function readExternalConfigFile(filePath: string): Record<string, unknown> {
  const resolved = path.resolve(expandHomePath(filePath))
  if (!existsSync(resolved)) {
    throw new Error(`External config not found: ${resolved}`)
  }
  try {
    return readJsonObjectOrEmpty(resolved)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to read external config ${resolved}: ${message}`)
  }
}

export function resolveStartupHome(input: {
  homeFlag?: string
  externalHome?: unknown
}): string {
  const raw =
    input.homeFlag ??
    process.env.LIGHTCLAW_HOME ??
    (typeof input.externalHome === 'string' ? input.externalHome : undefined) ??
    '~/.lightclaw'
  return path.resolve(expandHomePath(raw))
}

export function syncExternalConfig(
  external: Record<string, unknown>,
  home: string,
): void {
  mkdirSync(home, { recursive: true })
  const homeConfigPath = path.join(home, 'config.json')
  const snapshotPath = path.join(home, '.config-source.json')

  if (!existsSync(homeConfigPath)) {
    atomicWriteJson(homeConfigPath, external)
  } else {
    const merged = mergeExternalConfig(
      readJsonObjectOrEmpty(homeConfigPath),
      external,
      readJsonObjectOrEmpty(snapshotPath),
    )
    atomicWriteJson(homeConfigPath, merged)
  }
  atomicWriteJson(snapshotPath, external)
}

export function isHomeConfigPath(configPath: string): boolean {
  return path.resolve(expandHomePath(configPath)) === path.join(lightclawHome(), 'config.json')
}

export function clampPermissionModeToCeiling(): boolean {
  const configPath = path.join(lightclawHome(), 'config.json')
  if (!existsSync(configPath)) {
    return false
  }
  const config = readJsonObjectOrEmpty(configPath)
  const mode = parsePermissionModeValue(
    process.env.LIGHTCLAW_PERMISSION_MODE ?? config.permissionMode,
    'acceptEdits',
  )
  const ceiling = parsePermissionModeValue(
    process.env.LIGHTCLAW_PERMISSION_CEILING ?? config.permissionCeiling,
    'acceptEdits',
  )
  if (permissionModeRank(mode) <= permissionModeRank(ceiling)) {
    return false
  }

  config.permissionMode = ceiling
  atomicWriteJson(configPath, config)
  process.stderr.write(
    `config: permissionMode ${permissionModeToAlias(mode)} exceeds permissionCeiling ${permissionModeToAlias(ceiling)}; clamped home config to ${permissionModeToAlias(ceiling)}.\n`,
  )
  return true
}

function parsePermissionModeValue(value: unknown, fallback: PermissionMode): PermissionMode {
  return typeof value === 'string'
    ? parsePermissionModeInput(value) ?? fallback
    : fallback
}

function permissionModeRank(mode: PermissionMode): number {
  switch (mode) {
    case 'plan':
      return 0
    case 'default':
      return 1
    case 'acceptEdits':
      return 2
    case 'bypassPermissions':
      return 3
  }
}
