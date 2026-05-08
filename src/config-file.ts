import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { lightclawHome } from './paths.js'

// Pure file IO + JSON shape for `<lightclawHome>/config.json`. Lives apart
// from `config.ts` so modules that only need to peek at the raw file
// (e.g. `identity/paths.ts:workspaceRoot()`) can do so without pulling in
// `config.ts`'s downstream type imports — keeps the import graph acyclic
// even if someone later adds a non-type runtime import to `config.ts`.

export type ConfigFileEndpoint = {
  apiKey?: string
  baseUrl?: string
  /** When set, the endpoint is sourced via OAuth (no apiKey on this entry).
   *  Currently only `'codex-oauth'` is recognized; it routes to the
   *  Codex backend with credentials managed by `src/auth/codex/`. */
  auth?: 'codex-oauth'
  /** Explicit proxy URL for outbound calls to this endpoint. Empty string
   *  / omitted = direct connect. Never inherits from ambient
   *  `http_proxy` / `HTTPS_PROXY` env. */
  proxy?: string
}

export type ConfigFileModel = {
  /** Reference to a key in `endpoints`. */
  endpoint?: string
  /** Wire protocol the SDK speaks. Decides which client/provider services
   *  this model. */
  schema?: string
  /** Real model id as the upstream expects it. The display name (this
   *  entry's outer key) is decoupled. */
  upstreamModel?: string
}

export type ConfigFileShape = {
  /** Named endpoint pool (apiKey + optional baseUrl) referenced by models.
   *  Same physical gateway can host both anthropic and openai protocols —
   *  schema lives on each model entry, not here. */
  endpoints?: Record<string, ConfigFileEndpoint>
  /** Display-name -> { endpoint alias, schema, upstreamModel }. The keys
   *  are what users see in `/model` and write into routing. */
  models?: Record<string, ConfigFileModel>
  /** Display name picked at startup when no env / per-identity preference
   *  overrides. Must exist in `models`. */
  defaultModel?: string
  routing?: {
    main?: string
    compact?: string
    extract?: string
    webSearch?: string
  }
  sessionsDir?: string
  autoCompact?: boolean
  autoMemory?: boolean
  autoDream?: {
    enabled?: boolean
    minHours?: number
    minSessions?: number
    scanThrottleMs?: number
    maxTurns?: number
  }
  backgroundTask?: {
    maxConcurrentRunsPerUser?: number
    startupCatchupIntervalMs?: number
    fireRetryMaxAttempts?: number
    recurringAutoDisableThreshold?: number
  }
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
  tools?: {
    webSearch?: {
      braveApiKey?: string
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
      security?: {
        capDrop?: string[]
        capAdd?: string[]
        noNewPrivileges?: boolean
        readOnlyRootfs?: boolean
        pidsLimit?: number | null
        ulimits?: Record<string, string>
        tmpfsOptions?: string
      }
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
      /** Explicit proxy URL forwarded by the bridge and injected into
       *  LocalRuntime Bash subprocess env. Empty / omitted = direct. */
      proxy?: string
      /** Destinations that bypass `proxy` (CIDR / `.suffix` / exact
       *  hostname). Same list drives bridge routing + container/Bash
       *  `no_proxy` env. */
      noProxy?: string[]
      port?: number
      bindHost?: string
      acl?: string[]
    }
  }
  apiLogs?: {
    enabled?: boolean
    dir?: string
  }
  lang?: string
}

export function loadConfigFile(): ConfigFileShape {
  const configPath = path.join(lightclawHome(), 'config.json')
  if (!existsSync(configPath)) {
    return {}
  }

  const raw = readFileSync(configPath, 'utf8')
  return JSON.parse(raw) as ConfigFileShape
}
