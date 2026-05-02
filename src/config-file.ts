import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { lightclawHome } from './paths.js'

// Pure file IO + JSON shape for `<lightclawHome>/config.json`. Lives apart
// from `config.ts` so modules that only need to peek at the raw file
// (e.g. `identity/paths.ts:workspaceRoot()`) can do so without pulling in
// `config.ts`'s downstream type imports — keeps the import graph acyclic
// even if someone later adds a non-type runtime import to `config.ts`.

export type ConfigFileShape = {
  apiKey?: string
  baseUrl?: string
  model?: string
  allowedModels?: string[]
  provider?: string
  providerOptions?: {
    anthropic?: {
      apiKey?: string
      baseUrl?: string
    }
    openai?: {
      apiKey?: string
      baseUrl?: string
    }
  }
  routing?: {
    main?: string
    compact?: string
    extract?: string
    webSearch?: string
  }
  sessionsDir?: string
  autoCompact?: boolean
  autoMemory?: boolean
  memoryDir?: string
  workspaceRoot?: string
  contextWindow?: number
  compactThresholdRatio?: number
  compactKeepRecent?: number
  maxTurns?: number
  subagentMaxTurns?: number
  permissionMode?: string
  permissionRuleFiles?: {
    user?: string
    project?: string
    local?: string
  }
  permissionAuditLog?: string
  mcpEnabled?: boolean
  mcpConnectTimeout?: number
  mcpConnectConcurrency?: number
  mcpConfigFiles?: {
    user?: string
    project?: string
    local?: string
  }
  mcpMaxToolOutputBytes?: number
  maxToolOutputBytes?: number
  hooksEnabled?: boolean
  hookTimeoutBlocking?: number
  hookTimeoutNonBlocking?: number
  hookDirs?: {
    user?: string
    project?: string
  }
  memoryRecall?: {
    enabled?: boolean
    topN?: number
  }
  sessionMemory?: {
    enabled?: boolean
    updateTokenThreshold?: number
    updateToolCallThreshold?: number
  }
  preCompactFlush?: {
    enabled?: boolean
    timeoutMs?: number
  }
  microCompact?: {
    enabled?: boolean
    perTool?: {
      enabled?: boolean
      tokenThreshold?: number
      summaryMaxTokens?: number
      archiveOriginals?: boolean
    }
    idle?: {
      enabled?: boolean
      gapThresholdMinutes?: number
      keepRecent?: number
    }
  }
  runtime?: {
    backend?: string
    docker?: {
      image?: string
      imageOverride?: string
      idleTimeoutMs?: number
      memoryLimit?: string
      cpuLimit?: number
      network?: string
      mounts?: Array<{
        host?: string
        container?: string
        mode?: string
      }>
      tmpfs?: string[]
      env?: Record<string, string>
      autoPull?: boolean
    }
    rlaunch?: {
      image?: string
      chargedGroup?: string
      namespace?: string
      cpu?: number
      memoryMb?: number
      gpu?: number
      privateMachine?: string
      positiveTags?: string[]
      gpfsHostPrefix?: string
      gpfsMountPrefix?: string
      imagePullPolicy?: string
      maxWaitDuration?: string
      workerGcTimeHours?: number
      predictBeforeStart?: boolean
      healthCheckIntervalMs?: number
      preheatOnStartup?: boolean
      preheatOnApproval?: boolean
      env?: Record<string, string>
    }
    network?: {
      mode?: string
      upstream?: string
      port?: number
      bindHost?: string
      acl?: string[]
    }
  }
}

export function loadConfigFile(): ConfigFileShape {
  const configPath = path.join(lightclawHome(), 'config.json')
  if (!existsSync(configPath)) {
    return {}
  }

  const raw = readFileSync(configPath, 'utf8')
  return JSON.parse(raw) as ConfigFileShape
}
