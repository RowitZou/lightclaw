import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export type LightClawConfig = {
  apiKey: string
  baseUrl?: string
  model: string
}

type ConfigFileShape = {
  apiKey?: string
  baseUrl?: string
  model?: string
}

const DEFAULT_MODEL = 'claude-sonnet-4-20250514'

function loadConfigFile(): ConfigFileShape {
  const configPath = path.join(homedir(), '.lightclaw', 'config.json')
  if (!existsSync(configPath)) {
    return {}
  }

  const raw = readFileSync(configPath, 'utf8')
  const parsed = JSON.parse(raw) as ConfigFileShape
  return parsed
}

export function getConfig(): LightClawConfig {
  const fileConfig = loadConfigFile()
  const apiKey = process.env.ANTHROPIC_API_KEY ?? fileConfig.apiKey
  const baseUrl = process.env.ANTHROPIC_BASE_URL ?? fileConfig.baseUrl
  const model = process.env.LIGHTCLAW_MODEL ?? fileConfig.model ?? DEFAULT_MODEL

  if (!apiKey) {
    throw new Error(
      'Missing Anthropic API key. Set ANTHROPIC_API_KEY or ~/.lightclaw/config.json.',
    )
  }

  return {
    apiKey,
    baseUrl,
    model,
  }
}