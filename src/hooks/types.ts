export type HookName =
  | 'onSessionStart'
  | 'beforeQuery'
  | 'beforeToolCall'
  | 'afterToolCall'
  | 'afterQuery'
  | 'onSessionEnd'

export type HookSource = 'user' | 'project'
export type HookSessionTrigger = 'repl' | 'single' | 'channel' | 'resume'
export type HookToolSource = 'builtin' | 'mcp'

export type OnSessionStartPayload = {
  sessionId: string
  cwd: string
  trigger: HookSessionTrigger
  /** Present when trigger === 'channel'; e.g. 'feishu', 'wechat'. */
  channelId?: string
}

export type BeforeQueryPayload = {
  sessionId: string
  input: string
  messageCount: number
}

export type BeforeQueryResult = void | {
  replacementInput?: string
  abort?: { reason: string }
}

export type BeforeToolCallPayload = {
  sessionId: string
  callId: string
  toolName: string
  source: HookToolSource
  mcpServer?: string
  input: unknown
}

export type BeforeToolCallResult = void | {
  decision?: 'allow' | 'deny'
  reason?: string
  replacementInput?: unknown
  replacementResult?: string
}

export type AfterToolCallPayload = {
  sessionId: string
  callId: string
  toolName: string
  source: HookToolSource
  mcpServer?: string
  input: unknown
  result: string
  durationMs: number
  error?: string
}

export type AfterToolCallResult = void | {
  replacementResult?: string
}

export type AfterQueryPayload = {
  sessionId: string
  finalText?: string
  usage: { input: number; output: number }
  abortReason?: string
  messageCount: number
}

export type OnSessionEndPayload = {
  sessionId: string
  reason: 'exit' | 'timeout' | 'error'
}

export type HookPayloadMap = {
  onSessionStart: OnSessionStartPayload
  beforeQuery: BeforeQueryPayload
  beforeToolCall: BeforeToolCallPayload
  afterToolCall: AfterToolCallPayload
  afterQuery: AfterQueryPayload
  onSessionEnd: OnSessionEndPayload
}

export type HookResultMap = {
  onSessionStart: void
  beforeQuery: BeforeQueryResult
  beforeToolCall: BeforeToolCallResult
  afterToolCall: AfterToolCallResult
  afterQuery: void
  onSessionEnd: void
}

export type HookFn<N extends HookName> = (
  payload: HookPayloadMap[N],
) => HookResultMap[N] | Promise<HookResultMap[N]>

export type RegisteredHook<N extends HookName = HookName> = {
  name: N
  source: HookSource
  file: string
  identifier: string
  fn: HookFn<N>
}

export type HookModule = Partial<{ [N in HookName]: HookFn<N> }>

export type HookAuditEntry = {
  hook: string
  hookName: HookName
  file: string
  result?: unknown
  error?: string
}
