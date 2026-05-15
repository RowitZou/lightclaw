import type { ResolvedRolePolicy } from '../role-presets.js'
import type { Role } from '../types.js'
import type { LightClawConfig } from '../../config.js'
import type { InvocationContext } from '../invocation-context.js'
import type { SystemPromptTemplate } from '../../prompt.js'
import type { TurnToolCatalog } from '../../tools/deferred-loading.js'
import type { Tool } from '../../tool.js'
import type {
  Message,
  UsageStats,
  UserContentBlock,
} from '../../types.js'

export type RenderedPrompt = {
  system: string
  systemVariableSuffix?: string
}

export type HookErrorAction = { kind: 'retry' } | { kind: 'rethrow' }

export type HookContext = {
  role: Role
  rolePolicy: ResolvedRolePolicy
  config: LightClawConfig
  invocation: InvocationContext
  messages: Message[]
  messagesSnapshot?: Message[]
  allTools: Tool[]
  systemPrompt: {
    hasOverride: boolean
    override?: string
    template?: SystemPromptTemplate
    renderEffective(): string
  }
  turnCatalog: TurnToolCatalog
  setTurnCatalog(catalog: TurnToolCatalog): void
  mergeUsage(usage: UsageStats): void
  markDidCompact(): void
  stopReason(): string | null
}

export type Hook = {
  name: string
  beforeTurn?(ctx: HookContext): Promise<void> | void
  beforeStream?(ctx: HookContext): Promise<RenderedPrompt | void> | RenderedPrompt | void
  afterAssistantMessage?(ctx: HookContext): Promise<void> | void
  atToolBoundary?(ctx: HookContext): Promise<UserContentBlock[] | void> | UserContentBlock[] | void
  afterEndTurn?(ctx: HookContext, usage: UsageStats): Promise<void> | void
  onStreamError?(error: unknown, ctx: HookContext): Promise<HookErrorAction> | HookErrorAction
}
