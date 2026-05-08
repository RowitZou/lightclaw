import { access, readFile } from 'node:fs/promises'
import path from 'node:path'

import { lightclawHome } from '../paths.js'
import { getCwd } from '../state.js'
import { isValidServerName, normalizeServerName } from './normalization.js'
import type {
  McpScope,
  McpServerConfig,
  ScopedMcpServerConfig,
} from './types.js'

export type McpConfigPaths = {
  user?: string
}

const ENV_VAR_RE = /\$\{([A-Z_][A-Z0-9_]*)\}/gi
const warnedLegacyMcpPaths = new Set<string>()

export function defaultMcpConfigPaths(): Required<McpConfigPaths> {
  void warnIfLegacyMcpConfig(getCwd())
  return {
    user: path.join(lightclawHome(), 'mcp.json'),
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
  const user = await loadOneFile(paths.user, 'user', warnedKeys)
  const merged = new Map<string, ScopedMcpServerConfig>()

  for (const config of user) {
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

async function warnIfLegacyMcpConfig(cwd: string): Promise<void> {
  const legacyPaths = [
    path.join(cwd, '.lightclaw', 'mcp.json'),
    path.join(cwd, '.lightclaw', 'mcp.local.json'),
  ]
  for (const legacyPath of legacyPaths) {
    if (warnedLegacyMcpPaths.has(legacyPath)) {
      continue
    }
    warnedLegacyMcpPaths.add(legacyPath)
    try {
      await access(legacyPath)
      process.stderr.write(
        `mcp: ${legacyPath} is no longer scanned. Move admin-owned MCP config to ${path.join(lightclawHome(), 'mcp.json')}\n`,
      )
    } catch {
      // ENOENT and permission failures should not block startup.
    }
  }
}
