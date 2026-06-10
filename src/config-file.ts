import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { lightclawHome } from './paths.js'
import type { FeishuChannelConfig } from './channels/types.js'

// Pure file IO + JSON shape for `<lightclawHome>/config.json`. Lives apart
// from `config.ts` so modules that only need to peek at the raw file
// (e.g. `identity/paths.ts:workspaceRoot()`) can do so without pulling in
// `config.ts`'s downstream type imports — keeps the import graph acyclic
// even if someone later adds a non-type runtime import to `config.ts`.
// Type-only imports from leaf type modules are erased at build time and keep
// this module runtime-independent.

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
  /** Optional Responses API reasoning effort for reasoning-capable models. */
  reasoningEffort?: string
  /** Optional per-model output-token ceiling (`max_tokens`). Falls back to the
   *  global `maxOutputTokens`. Lives per-model because the hard API ceiling is
   *  model-specific (e.g. Sonnet/Haiku 64K vs Opus 128K). */
  maxOutputTokens?: number
}

export type ConfigFilePathsSection = {
  /** Per-canonical-user session transcript root. Env override:
   *  LIGHTCLAW_SESSIONS_DIR. */
  sessions?: string
  /** Per-user workspace cwd root. Env override: LIGHTCLAW_WORKSPACE_ROOT. */
  workspace?: string
  /** Per-canonical-user memory tree root. Env override: LIGHTCLAW_MEMORY_DIR. */
  memory?: string
  /** Directory under which apiLogs JSONL files are written. */
  apiLogs?: string
  /** Root for audit JSONL trees (`audit/dispatch/<date>/<chainId>.jsonl`,
   *  `audit/memory-writes/<date>.jsonl`, `audit/feishu-writes/<date>.jsonl`).
   *  Env override: LIGHTCLAW_AUDIT_DIR. */
  audit?: string
  /** Daemon log root for the stderr tee (`<logs>/<YYYY-MM-DD>.log`).
   *  Env override: LIGHTCLAW_LOGS_DIR. Defaults to `<lightclawHome>/logs`. */
  logs?: string
  /** Admin hooks discovery directory (single admin-owned tree). */
  hooks?: string
  /** Admin MCP config file path. */
  mcpConfig?: string
  /** Permission audit log file path (admin only). */
  permissionAudit?: string
  /** Layered permission rule files. All three are read+merged at startup;
   *  `user` is canonical, `project` / `local` are cwd-anchored fallbacks. */
  permissionRules?: {
    user?: string
    project?: string
    local?: string
  }
}

export type ConfigFileChannelsSection = {
  feishu?: Partial<FeishuChannelConfig> & {
    /** @deprecated Inbound media now lands in the runtime workspace inbox. */
    mediaDir?: string
    webhook?: Partial<FeishuChannelConfig['webhook']>
    inboxAging?: Partial<FeishuChannelConfig['inboxAging']>
    cloudSpace?: Partial<FeishuChannelConfig['cloudSpace']>
  }
}

export type ConfigFileTurnsSection = {
  /** Main agent loop hard cap. Undefined = no cap (matches Claude Code CLI). */
  main?: number
  /** Default cap for any subagent whose role does not set its own `maxTurns`.
   *  Undefined = no fallback cap (subagents run until end_turn / context
   *  exhaustion unless role-pinned). */
  subagentDefault?: number
}

export type ConfigFileMcpSection = {
  enabled?: boolean
  connectTimeout?: number
  connectConcurrency?: number
  maxToolOutputBytes?: number
}

export type ConfigFileHooksSection = {
  enabled?: boolean
  timeoutBlocking?: number
  timeoutNonBlocking?: number
}

export type ConfigFileMemorySection = {
  extractor?: {
    enabled?: boolean
  }
  curator?: {
    enabled?: boolean
    minHours?: number
    minSessions?: number
    scanThrottleMs?: number
    burstFileThreshold?: number
    maxTurns?: number
  }
  recall?: {
    enabled?: boolean
    topN?: number
  }
  session?: {
    enabled?: boolean
    updateTokenThreshold?: number
    updateToolCallThreshold?: number
  }
  nudge?: {
    enabled?: boolean
    everyTurns?: number
  }
}

export type ConfigFileCompactSection = {
  auto?: boolean
  thresholdRatio?: number
  keepRecent?: number
  preFlush?: {
    enabled?: boolean
    timeoutMs?: number
  }
  micro?: {
    enabled?: boolean
    idle?: {
      enabled?: boolean
      gapThresholdMinutes?: number
      keepRecent?: number
    }
  }
}

export type ConfigFileDispatchSchedulerSection = {
  maxConcurrentRunsPerUser?: number
  startupCatchupIntervalMs?: number
  fireRetryMaxAttempts?: number
}

/** Sub-LLM model pins. Each value is the display name of a model in
 *  `models`. These are framework-internal LLMs (not user-visible Tools);
 *  kept here so `tools.<X>.model` doesn't conflate "Tool config" with
 *  "sub-LLM selection". */
export type ConfigFileSubLLMSection = {
  /** Sub-LLM that summarizes / rewrites compaction prefixes. */
  compact?: string
  /** Sub-LLM that produces text descriptions of inline images. */
  imageRead?: string
  /** Sub-LLM that summarizes WebSearch / WebFetch results. */
  webSearch?: string
}

export type ConfigFileToolCatalogSection = {
  deferredLoading?: string
  deferredLoadingThreshold?: number
  discoveredToolsMaxSize?: number
  discoveredToolsTtlTurns?: number
}

export type ConfigFileShape = {
  /** Data root used only when this file is passed as an external `--config`.
   *  The loader never reads `home` from `<home>/config.json`, because that
   *  would create a cycle: finding config would first require knowing home. */
  home?: string
  /** Named endpoint pool (apiKey + optional baseUrl) referenced by models.
   *  Same physical gateway can host both anthropic and openai protocols —
   *  schema lives on each model entry, not here. */
  endpoints?: Record<string, ConfigFileEndpoint>
  /** Display-name -> { endpoint alias, schema, upstreamModel }. The keys
   *  are what users see in `/model`. */
  models?: Record<string, ConfigFileModel>
  /** Display name picked at startup when no env / per-identity preference
   *  overrides. Must exist in `models`. */
  defaultModel?: string
  roles?: Record<string, {
    model?: unknown
    maxTurns?: unknown
  }>
  contextWindow?: number
  /** Global default output-token ceiling (`max_tokens`) for the main agent
   *  loop. Per-model `models.<name>.maxOutputTokens` overrides it. */
  maxOutputTokens?: number
  /** Permission policy mode. Top-level flat field (not nested) because the
   *  permission concept currently has only this one knob — `ruleFiles` /
   *  `auditLog` are paths and live under `paths.*`. */
  permissionMode?: string
  /** Default per-identity permission ceiling. Accepts internal mode names
   *  or user-facing aliases (`read` / `ask` / `auto` / `yolo`). */
  permissionCeiling?: string
  /** Channel configuration now lives in config.json. The legacy standalone
   *  `<home>/channels.json` file is still read as a deprecation fallback
   *  when this section is absent. */
  channels?: ConfigFileChannelsSection
  /** Master switch for the apiLogs JSONL persistence feature. Top-level
   *  flat because only the `enabled` knob remains here — log directory
   *  lives under `paths.apiLogs`. */
  apiLogsEnabled?: boolean
  /** All filesystem paths in one place. Per-feature dirs (apiLogs / hooks /
   *  mcpConfig / permission*) live here even though each belongs to a
   *  different feature, so a single grep tells the admin where every byte
   *  lands. */
  paths?: ConfigFilePathsSection
  /** Turn caps. `roles.<X>.maxTurns` overrides for a specific role. */
  turns?: ConfigFileTurnsSection
  /** Stream idle abort thresholds. Defaults live in config.ts. */
  streamIdle?: {
    /** Max wait for the first stream event before abort + retry. */
    ttfbMs?: number
    /** Max gap between stream events after the first event. */
    interEventMs?: number
  }
  /** Memory subsystem. Groups extractor / curator / recall / session / nudge
   *  knobs that were previously scattered as top-level `autoMemory` /
   *  `autoDream` / `memoryRecall` / `sessionMemory` / `memoryNudge`. Memory
   *  dir moved to `paths.memory`. Legacy top-level keys still accepted
   *  with a one-time deprecation warning. */
  memory?: ConfigFileMemorySection
  /** Compaction subsystem. Groups auto / threshold / keep-recent / pre-flush /
   *  micro-compact knobs that were previously top-level `autoCompact` /
   *  `compactThresholdRatio` / `compactKeepRecent` / `preCompactFlush` /
   *  `microCompact`. Legacy top-level keys still accepted with deprecation
   *  warning. */
  compact?: ConfigFileCompactSection
  taskrun?: {
    resume?: {
      maxGapMs?: number
    }
    ask?: {
      timeoutMs?: number
    }
    watchdog?: {
      intervalMinutes?: number
      deliveredGraceMs?: number
      waitingGraceMs?: number
      budgetWindowMinutes?: number
      deliveryRetryMaxAttempts?: number
    }
  }
  dispatch?: {
    maxChainDepth?: number
    maxChainDepthCeiling?: number
    ephemeralSessionTtlMs?: number
    /** Scheduler / store backing `Dispatch(mode:'background', schedule:...)`.
     *  Previously top-level `backgroundTask.*`. Legacy key still accepted
     *  with deprecation warning. */
    scheduler?: ConfigFileDispatchSchedulerSection
  }
  /** Sub-LLM model pins for framework-internal LLM operations. Each value
   *  is a model display name. Was `tools.<X>.model`; conflated tool config
   *  with sub-LLM selection — separated out into its own namespace. */
  subLLM?: ConfigFileSubLLMSection
  mcp?: ConfigFileMcpSection
  hooks?: ConfigFileHooksSection
  tools?: {
    webSearch?: {
      braveApiKey?: string
      /** @deprecated Moved to `subLLM.webSearch` (string). */
      model?: string
    }
    webFetch?: {
      preapprovedDomains?: string[]
    }
    /** @deprecated Moved to `subLLM.imageRead` (string). */
    imageRead?: {
      model?: string
    }
    /** @deprecated Moved to `subLLM.compact` (string). */
    compact?: {
      model?: string
    }
    /** General tool output byte cap (per-call, post-channel-encoding).
     *  Previously top-level `maxToolOutputBytes`. */
    maxOutputBytes?: number
    /** Tool catalog system (deferred loading + discovery LRU). Previously
     *  these four fields lived directly under `tools.*` alongside per-tool
     *  config; grouped here so the `tools.*` namespace contains either
     *  per-tool config or the catalog meta. Legacy top-level
     *  `tools.deferredLoading*` / `tools.discoveredTools*` still accepted. */
    catalog?: ConfigFileToolCatalogSection
    /** @deprecated Moved to `tools.catalog.deferredLoading`. */
    deferredLoading?: string
    /** @deprecated Moved to `tools.catalog.deferredLoadingThreshold`. */
    deferredLoadingThreshold?: number
    /** @deprecated Moved to `tools.catalog.discoveredToolsMaxSize`. */
    discoveredToolsMaxSize?: number
    /** @deprecated Moved to `tools.catalog.discoveredToolsTtlTurns`. */
    discoveredToolsTtlTurns?: number
  }
  runtime?: {
    driver?: 'brainpp' | null
    backend?: string
    dockerSettings?: {
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
        /** Docker `--storage-opt size=<value>` cap on the container's
         *  rootfs writable layer. Null = omit the flag (host default,
         *  which is the entire docker storage volume). Requires
         *  overlay2 + XFS with `prjquota`; non-conforming hosts will
         *  fail container creation. */
        storageOptSize?: string | null
        /** Hard cap (MiB) on `/workspace` bind-mount usage. Polled via
         *  `du -sb` with a 60s cache; over-cap exec() and writeFile()
         *  refuse with an error. Null / 0 = disabled. */
        workspaceQuotaMb?: number | null
      }
    }
    clusterSettings?: {
      image?: string
      chargedGroup?: string
      namespace?: string
      cpu?: number
      memoryMb?: number
      gpu?: number
      privateMachine?: string
      positiveTags?: string[]
      gpfsMounts?: Array<{
        hostPrefix?: string
        mountPrefix?: string
      }>
      distributedRdmaResources?: Record<string, string | number>
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
  attachments?: {
    /** Image inline cap. Files above this size are Pillow-resized down
     *  before submission to a vision-capable model. Default 5 MB. */
    imageMaxMb?: number
    /** PDF inline cap. Files above this size skip inline submission and
     *  fall through to the text-path breadcrumb so the agent picks them
     *  up via Read tool. Default 32 MB. */
    pdfMaxMb?: number
    /** Per-turn cap on inline blocks (image + pdf combined). Excess goes
     *  to the text-path breadcrumb. Default 5. */
    maxInlinePerTurn?: number
  }
  lang?: string

  // ──────── LEGACY top-level fields (deprecated, still accepted) ────────
  // Migration layer in `config.ts` reads these as a fallback when the new
  // namespace key is missing, emits a one-time warning per field, and maps
  // them to the new locations. Will be removed in a future cleanup.

  /** @deprecated → `paths.sessions` */
  sessionsDir?: string
  /** @deprecated → `paths.workspace` */
  workspaceRoot?: string
  /** @deprecated → `paths.memory` */
  memoryDir?: string
  /** @deprecated → `apiLogsEnabled` + `paths.apiLogs` */
  apiLogs?: {
    enabled?: boolean
    dir?: string
  }
  /** @deprecated → `paths.permissionAudit` */
  permissionAuditLog?: string
  /** @deprecated → `paths.permissionRules.*` */
  permissionRuleFiles?: {
    user?: string
    project?: string
    local?: string
  }
  /** @deprecated → `paths.hooks` */
  hookDirs?: {
    user?: string
  }
  /** @deprecated → `paths.mcpConfig` */
  mcpConfigFiles?: {
    user?: string
  }
  /** @deprecated → `turns.main` */
  maxTurns?: number
  /** @deprecated → `turns.subagentDefault` */
  subagentMaxTurns?: number
  /** @deprecated → `mcp.enabled` */
  mcpEnabled?: boolean
  /** @deprecated → `mcp.connectTimeout` */
  mcpConnectTimeout?: number
  /** @deprecated → `mcp.connectConcurrency` */
  mcpConnectConcurrency?: number
  /** @deprecated → `mcp.maxToolOutputBytes` */
  mcpMaxToolOutputBytes?: number
  /** @deprecated → `hooks.enabled` */
  hooksEnabled?: boolean
  /** @deprecated → `hooks.timeoutBlocking` */
  hookTimeoutBlocking?: number
  /** @deprecated → `hooks.timeoutNonBlocking` */
  hookTimeoutNonBlocking?: number
  /** @deprecated → `tools.maxOutputBytes` */
  maxToolOutputBytes?: number
  /** @deprecated → `memory.extractor.enabled` */
  autoMemory?: boolean
  /** @deprecated → `memory.curator` */
  autoDream?: {
    enabled?: boolean
    minHours?: number
    minSessions?: number
    scanThrottleMs?: number
    burstFileThreshold?: number
    maxTurns?: number
  }
  /** @deprecated → `memory.recall` */
  memoryRecall?: {
    enabled?: boolean
    topN?: number
  }
  /** @deprecated → `memory.session` */
  sessionMemory?: {
    enabled?: boolean
    updateTokenThreshold?: number
    updateToolCallThreshold?: number
  }
  /** @deprecated → `memory.nudge` */
  memoryNudge?: {
    enabled?: boolean
    everyTurns?: number
  }
  /** @deprecated → `compact.auto` */
  autoCompact?: boolean
  /** @deprecated → `compact.thresholdRatio` */
  compactThresholdRatio?: number
  /** @deprecated → `compact.keepRecent` */
  compactKeepRecent?: number
  /** @deprecated → `compact.preFlush` */
  preCompactFlush?: {
    enabled?: boolean
    timeoutMs?: number
  }
  /** @deprecated → `compact.micro` */
  microCompact?: {
    enabled?: boolean
    idle?: {
      enabled?: boolean
      gapThresholdMinutes?: number
      keepRecent?: number
    }
  }
  /** @deprecated → `dispatch.scheduler` */
  backgroundTask?: {
    maxConcurrentRunsPerUser?: number
    startupCatchupIntervalMs?: number
    fireRetryMaxAttempts?: number
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
