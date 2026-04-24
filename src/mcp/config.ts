import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import { getCwd } from '../state.js'
import { isValidServerName, normalizeServerName } from './normalization.js'
import type {
  McpScope,
  McpServerConfig,
  ScopedMcpServerConfig,
} from './types.js'

export type McpConfigPaths = {
  user?: string
  project?: string
  local?: string
}

const ENV_VAR_RE = /\$\{([A-Z_][A-Z0-9_]*)\}/gi

export function defaultMcpConfigPaths(cwd = getCwd()): Required<McpConfigPaths> {
  return {
    user: path.join(homedir(), '.lightclaw', 'mcp.json'),
    project: path.join(cwd, '.lightclaw', 'mcp.json'),
    local: path.join(cwd, '.lightclaw', 'mcp.local.json'),
  }
}

function warn(message: string): void {
  console.warn(message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function expandEnvValue(value: string, warnedKeys: Set<string>): string {
  return value.replace(ENV_VAR_RE, (_, key: string) => {
    const envValue = process.env[key]
    if (envValue === undefined) {
      if (!warnedKeys.has(key)) {
        warn(`mcp: env var \${${key}} is undefined, expanded to empty string`)
        warnedKeys.add(key)
      }
      return ''
    }

    return envValue
  })
}

function expandConfigEnv(
  config: McpServerConfig,
  warnedKeys: Set<string>,
): McpServerConfig {
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return expandEnvValue(value, warnedKeys)
    }

    if (Array.isArray(value)) {
      return value.map(walk)
    }

    if (isRecord(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, nested]) => [key, walk(nested)]),
      )
    }

    return value
  }

  return walk(config) as McpServerConfig
}

function parseServerConfig(
  name: string,
  value: unknown,
  scope: McpScope,
  warnedKeys: Set<string>,
): ScopedMcpServerConfig | undefined {
  if (!isRecord(value)) {
    warn(`mcp: skipped ${scope} server ${name}: config must be an object`)
    return undefined
  }

  const type = typeof value.type === 'string' ? value.type : 'stdio'
  if (type !== 'stdio' && type !== 'http' && type !== 'sse') {
    warn(`mcp: skipped ${scope} server ${name}: unsupported type ${type}`)
    return undefined
  }

  if (type === 'stdio' && typeof value.command !== 'string') {
    warn(`mcp: skipped ${scope} server ${name}: stdio command is required`)
    return undefined
  }

  if ((type === 'http' || type === 'sse') && typeof value.url !== 'string') {
    warn(`mcp: skipped ${scope} server ${name}: url is required`)
    return undefined
  }

  const normalizedName = normalizeServerName(name)
  if (!isValidServerName(normalizedName) || normalizedName.length === 0) {
    warn(`mcp: skipped ${scope} server ${name}: normalized name is invalid`)
    return undefined
  }

  const expanded = expandConfigEnv(value as McpServerConfig, warnedKeys)
  return {
    ...expanded,
    scope,
    name,
    normalizedName,
  }
}

async function loadOneFile(
  filePath: string | undefined,
  scope: McpScope,
  warnedKeys: Set<string>,
): Promise<ScopedMcpServerConfig[]> {
  if (!filePath) {
    return []
  }

  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return []
    }

    const message = error instanceof Error ? error.message : String(error)
    warn(`mcp: failed to read ${scope} config ${filePath}: ${message}`)
    return []
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    warn(`mcp: failed to parse ${scope} config ${filePath}: ${message}`)
    return []
  }

  if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
    warn(`mcp: skipped ${scope} config ${filePath}: missing mcpServers object`)
    return []
  }

  const result: ScopedMcpServerConfig[] = []
  for (const [name, value] of Object.entries(parsed.mcpServers)) {
    const config = parseServerConfig(name, value, scope, warnedKeys)
    if (config) {
      result.push(config)
    }
  }

  return result
}

export async function loadMcpConfig(
  paths: McpConfigPaths,
): Promise<ScopedMcpServerConfig[]> {
  const warnedKeys = new Set<string>()
  const [user, project, local] = await Promise.all([
    loadOneFile(paths.user, 'user', warnedKeys),
    loadOneFile(paths.project, 'project', warnedKeys),
    loadOneFile(paths.local, 'local', warnedKeys),
  ])
  const merged = new Map<string, ScopedMcpServerConfig>()

  for (const config of [...user, ...project, ...local]) {
    const existing = merged.get(config.normalizedName)
    if (existing && existing.name !== config.name) {
      throw new Error(
        `mcp: server name collision: "${existing.name}" (${existing.scope}) and "${config.name}" (${config.scope}) both normalize to "${config.normalizedName}". Rename one of them.`,
      )
    }
    merged.set(config.normalizedName, config)
  }

  return [...merged.values()]
}
