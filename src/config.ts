import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export type LightClawConfig = {
  apiKey: string
  baseUrl?: string
  model: string
  sessionsDir: string
  autoCompact: boolean
  autoMemory: boolean
  memoryDir: string
  contextWindow: number
  compactThresholdRatio: number
  compactKeepRecent: number
}

type ConfigFileShape = {
  apiKey?: string
  baseUrl?: string
  model?: string
  sessionsDir?: string
  autoCompact?: boolean
  autoMemory?: boolean
  memoryDir?: string
  contextWindow?: number
  compactThresholdRatio?: number
  compactKeepRecent?: number
}

const DEFAULT_MODEL = 'claude-sonnet-4-20250514'
const DEFAULT_CONTEXT_WINDOW = 200_000
const DEFAULT_COMPACT_THRESHOLD_RATIO = 0.75
const DEFAULT_COMPACT_KEEP_RECENT = 6

function expandHomePath(input: string): string {
  if (input === '~') {
    return homedir()
  }

  if (input.startsWith('~/')) {
    return path.join(homedir(), input.slice(2))
  }

  return input
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (!value) {
    return undefined
  }

  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false
  }

  return undefined
}

function parseNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined
  }

  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function loadConfigFile(): ConfigFileShape {
  const configPath = path.join(homedir(), '.lightclaw', 'config.json')
  if (!existsSync(configPath)) {
    return {}
  }

  const raw = readFileSync(configPath, 'utf8')
  const parsed = JSON.parse(raw) as ConfigFileShape
  return parsed
}

export function resolveSessionsDir(): string {
  const fileConfig = loadConfigFile()
  const configuredPath =
    process.env.LIGHTCLAW_SESSIONS_DIR ??
    fileConfig.sessionsDir ??
    path.join(homedir(), '.lightclaw', 'sessions')

  return path.resolve(expandHomePath(configuredPath))
}

export function getConfig(): LightClawConfig {
  const fileConfig = loadConfigFile()
  const apiKey = process.env.ANTHROPIC_API_KEY ?? fileConfig.apiKey
  const baseUrl = process.env.ANTHROPIC_BASE_URL ?? fileConfig.baseUrl
  const model = process.env.LIGHTCLAW_MODEL ?? fileConfig.model ?? DEFAULT_MODEL
  const autoCompact =
    parseBoolean(process.env.LIGHTCLAW_AUTO_COMPACT) ??
    fileConfig.autoCompact ??
    true
  const contextWindow = Math.max(
    1000,
    Math.floor(
      parseNumber(process.env.LIGHTCLAW_CONTEXT_WINDOW) ??
        fileConfig.contextWindow ??
        DEFAULT_CONTEXT_WINDOW,
    ),
  )
  const compactThresholdRatio = clampNumber(
    parseNumber(process.env.LIGHTCLAW_COMPACT_THRESHOLD_RATIO) ??
      fileConfig.compactThresholdRatio ??
      DEFAULT_COMPACT_THRESHOLD_RATIO,
    0.1,
    0.95,
  )
  const compactKeepRecent = Math.max(
    0,
    Math.floor(
      parseNumber(process.env.LIGHTCLAW_COMPACT_KEEP_RECENT) ??
        fileConfig.compactKeepRecent ??
        DEFAULT_COMPACT_KEEP_RECENT,
    ),
  )
  const autoMemory =
    parseBoolean(process.env.LIGHTCLAW_AUTO_MEMORY) ??
    fileConfig.autoMemory ??
    true
  const memoryDir = path.resolve(
    expandHomePath(
      process.env.LIGHTCLAW_MEMORY_DIR ??
        fileConfig.memoryDir ??
        path.join(homedir(), '.lightclaw', 'memory'),
    ),
  )

  if (!apiKey) {
    throw new Error(
      'Missing Anthropic API key. Set ANTHROPIC_API_KEY or ~/.lightclaw/config.json.',
    )
  }

  return {
    apiKey,
    baseUrl,
    model,
    sessionsDir: resolveSessionsDir(),
    autoCompact,
    autoMemory,
    memoryDir,
    contextWindow,
    compactThresholdRatio,
    compactKeepRecent,
  }
}