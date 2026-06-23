import { getConfig, isUserSelectableModel } from '../config.js'
import {
  loadUserConfigOverride,
  resolveUserConfig,
  updateUserConfigOverride,
  type UserConfigOverride,
  type UserModelOverride,
} from '../config/user-override.js'
import { clearPrechargeForModel, getProviderFor } from '../provider/index.js'
import { formatModelTemplates } from '../model-setup.js'
import {
  formatModelRequestParamHelp,
  formatModelRequestParams,
  normalizeModelRequestParams,
  parseModelRequestParamFlagValue,
  parseModelRequestParamJsonFlagValue,
  parseModelRequestParamsJsonObject,
  parseModelTuningParamsText,
  splitModelTuningParams,
  type ModelRequestParams,
  type ModelTuningParams,
} from '../model-request-params.js'
import type { ReasoningEffort, Schema } from '../provider/types.js'
import type { ReplContext } from './registry.js'

const ALIAS_RE = /^[A-Za-z0-9_.-]{1,80}$/
const DEFAULT_CHECK_TIMEOUT_MS = 8000

export async function runModelCustomCommand(args: string, ctx: ReplContext): Promise<string> {
  const userId = ctx.userId
  if (!userId) {
    return 'No active LightClaw identity; /model custom requires a paired user.\n'
  }
  const parts = args.trim().split(/\s+/).filter(Boolean)
  const action = (parts.shift() ?? 'list').toLowerCase()
  try {
    switch (action) {
      case 'list':
        return formatCustomModelList(userId)
      case 'templates':
      case 'template':
        return formatModelTemplates()
      case 'param-help':
      case 'params-help':
      case 'parameters':
        return `${formatModelRequestParamHelp(parseOptionalSchema(parts[0]))}\n`
      case 'add':
        return await addModel(userId, parts, ctx)
      case 'set':
        return await setModelConfig(userId, parts, ctx)
      case 'check':
        return await checkModel(userId, parts, ctx)
      case 'remove':
      case 'rm':
        return removeModel(userId, parts, ctx)
      case 'help':
      case '--help':
      case '-h':
        return modelCustomUsage()
      default:
        return modelCustomUsage()
    }
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}\n`
  }
}

function modelCustomUsage(): string {
  return [
    'Usage:',
    '  /model custom list',
    '  /model custom templates',
    '  /model custom param-help [anthropic|openai|openai-auth]',
    '  /model custom add <model> <anthropic|openai|openai-auth> <endpoint> <upstreamModel> [--reasoning <none|minimal|low|medium|high|xhigh>] [--max-output-tokens <n>] [--param key=value] [--param-json key=<json>] [--params-json <jsonObject>] [--no-default] [--timeout-ms <n>]',
    '  /model custom set <model> [--schema <anthropic|openai|openai-auth>] [--endpoint <endpoint>] [--upstream-model <id>] [--reasoning <none|minimal|low|medium|high|xhigh|->] [--max-output-tokens <n|->] [--param key=value] [--param-json key=<json>] [--params-json <jsonObject>] [--clear-param <key>] [--clear-params] [--timeout-ms <n>]',
    '  /model custom check <model> [--timeout-ms <n>]',
    '  /model custom remove <model>',
    '',
  ].join('\n')
}

async function addModel(userId: string, parts: string[], ctx: ReplContext): Promise<string> {
  const [modelName, schemaText, endpoint, upstreamModel, ...rest] = parts
  if (!modelName || !schemaText || !endpoint || !upstreamModel) return modelCustomUsage()
  assertAlias('model', modelName)
  assertAlias('endpoint', endpoint)
  const schema = parseSchema(schemaText)
  assertUserEndpoint(userId, endpoint)
  const loaded = loadUserConfigOverride(userId)
  if (loaded.ok && loaded.value.models?.[modelName]) {
    return `Error: custom model "${modelName}" already exists. Use /model custom set ${modelName} ... to modify it.\n`
  }
  const paramsUpdate = parseRequestParamsFromFlags(rest, schema)
  const reasoningEffort = paramsUpdate.reasoningEffort ?? parseReasoningEffort(flagValue(rest, '--reasoning'))
  const maxOutputTokens = paramsUpdate.maxOutputTokens ?? parseOptionalPositiveInt(flagValue(rest, '--max-output-tokens'))
  const requestParams = paramsUpdate.params
  const setDefault = !rest.includes('--no-default')
  updateUserConfigOverride(userId, current => {
    const next = cloneOverride(current)
    next.models = {
      ...(next.models ?? {}),
      [modelName]: {
        endpoint,
        schema,
        upstreamModel,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
        ...(requestParams ? { requestParams } : {}),
      },
    }
    if (setDefault) next.defaultModel = modelName
    return next
  })
  refreshContextConfig(userId, ctx)
  const check = await probeModelAccess(userId, modelName, ctx, parseTimeoutMs(rest))
  return [
    `Added custom model "${modelName}" (${schema}, ${endpoint} -> ${upstreamModel}).`,
    check,
    '',
  ].join('\n')
}

async function setModelConfig(userId: string, parts: string[], ctx: ReplContext): Promise<string> {
  const [modelName, ...rest] = parts
  if (!modelName) return modelCustomUsage()
  assertAlias('model', modelName)
  const loaded = loadUserConfigOverride(userId)
  const current = loaded.ok ? loaded.value.models?.[modelName] : undefined
  if (!current) {
    return `Error: custom model "${modelName}" does not exist. Use /model custom add first.\n`
  }
  const next: UserModelOverride = { ...current }
  const schema = flagValue(rest, '--schema')
  if (schema) next.schema = parseSchema(schema)
  const endpoint = flagValue(rest, '--endpoint')
  if (endpoint) {
    assertAlias('endpoint', endpoint)
    assertUserEndpoint(userId, endpoint)
    next.endpoint = endpoint
  }
  const upstreamModel = flagValue(rest, '--upstream-model')
  if (upstreamModel) next.upstreamModel = upstreamModel
  const reasoning = flagValue(rest, '--reasoning')
  if (reasoning !== undefined) {
    if (reasoning === '-') delete next.reasoningEffort
    else next.reasoningEffort = parseReasoningEffort(reasoning)
  }
  const maxOutput = flagValue(rest, '--max-output-tokens')
  if (maxOutput !== undefined) {
    if (maxOutput === '-') delete next.maxOutputTokens
    else next.maxOutputTokens = parseOptionalPositiveInt(maxOutput)
  }
  const paramsUpdate = parseRequestParamsFromFlags(rest, next.schema, next.requestParams)
  if (paramsUpdate.touched) {
    if (paramsUpdate.params) next.requestParams = paramsUpdate.params
    else delete next.requestParams
    if (paramsUpdate.reasoningEffort) next.reasoningEffort = paramsUpdate.reasoningEffort
    if (paramsUpdate.maxOutputTokens !== undefined) next.maxOutputTokens = paramsUpdate.maxOutputTokens
  } else if (next.requestParams) {
    const normalized = normalizeModelRequestParams(next.requestParams, next.schema, 'requestParams')
    if (normalized) next.requestParams = normalized
    else delete next.requestParams
  }
  updateUserConfigOverride(userId, currentConfig => {
    const copy = cloneOverride(currentConfig)
    copy.models = { ...(copy.models ?? {}), [modelName]: next }
    return copy
  })
  clearPrechargeForModel({
    endpoint: next.endpoint,
    baseUrl: ctx.config.endpoints[next.endpoint]?.baseUrl,
    upstreamModel: next.upstreamModel,
  })
  refreshContextConfig(userId, ctx)
  const check = await probeModelAccess(userId, modelName, ctx, parseTimeoutMs(rest))
  return [
    `Updated custom model "${modelName}" (${next.schema}, ${next.endpoint} -> ${next.upstreamModel}).`,
    check,
    '',
  ].join('\n')
}

async function checkModel(userId: string, parts: string[], ctx: ReplContext): Promise<string> {
  const [modelName, ...rest] = parts
  if (!modelName) return modelCustomUsage()
  assertAlias('model', modelName)
  return `${await probeModelAccess(userId, modelName, ctx, parseTimeoutMs(rest))}\n`
}

function removeModel(userId: string, parts: string[], ctx: ReplContext): string {
  const [modelName] = parts
  if (!modelName) return modelCustomUsage()
  updateUserConfigOverride(userId, current => {
    const next = cloneOverride(current)
    if (!next.models?.[modelName]) {
      throw new Error(`custom model "${modelName}" does not exist`)
    }
    delete next.models[modelName]
    if (next.defaultModel === modelName) delete next.defaultModel
    return prune(next)
  })
  refreshContextConfig(userId, ctx)
  return `Removed custom model "${modelName}" from user config.\n`
}

function formatCustomModelList(userId: string): string {
  const loaded = loadUserConfigOverride(userId)
  if (!loaded.ok) return `User config is invalid: ${loaded.error}\n`
  const models = Object.entries(loaded.value.models ?? {})
  if (models.length === 0) return 'No custom models configured. Run /model custom templates for examples.\n'
  return `${[
    'Custom models:',
    ...models
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, model]) => {
        const current = loaded.ok && loaded.value.defaultModel === name ? ' default' : ''
        const params = formatModelRequestParams(model.requestParams as ModelRequestParams | undefined)
        return `  ${name} (${model.schema}, ${model.endpoint} -> ${model.upstreamModel})${current}; params=${params}`
      }),
    '',
  ].join('\n')}`
}

async function probeModelAccess(
  userId: string,
  modelName: string,
  ctx: ReplContext,
  timeoutMs: number,
): Promise<string> {
  const config = resolveUserConfig(userId, getConfig())
  const entry = config.models[modelName]
  if (!isUserSelectableModel(entry)) {
    return `Model check: failed; "${modelName}" is not selectable for this user.`
  }
  try {
    const { provider } = getProviderFor(config, modelName)
    const signal = AbortSignal.timeout(timeoutMs)
    for await (const event of provider.streamChat({
      model: entry.upstreamModel,
      system: 'You are a connectivity checker. Reply with ok.',
      messages: [{ role: 'user', content: 'Reply with ok.' }],
      tools: [],
      maxTokens: 16,
      ...(entry.reasoningEffort ? { reasoningEffort: entry.reasoningEffort } : {}),
      ...(entry.requestParams ? { requestParams: entry.requestParams } : {}),
      signal,
    })) {
      if (event.type === 'stop') break
    }
    refreshContextConfig(userId, ctx)
    return `Model check: ok.`
  } catch (error) {
    refreshContextConfig(userId, ctx)
    return `Model check: failed; ${error instanceof Error ? error.message : String(error)}.`
  }
}

function assertUserEndpoint(userId: string, endpoint: string): void {
  const loaded = loadUserConfigOverride(userId)
  if (!loaded.ok) throw new Error(loaded.error)
  if (!loaded.value.endpoints?.[endpoint]) {
    throw new Error(`endpoint "${endpoint}" is not a custom endpoint. Add it with /endpoint first.`)
  }
}

function refreshContextConfig(userId: string, ctx: ReplContext): void {
  const fresh = resolveUserConfig(userId, getConfig())
  replaceRecord(ctx.config.endpoints, fresh.endpoints)
  replaceRecord(ctx.config.models, fresh.models)
  ctx.config.defaultModel = fresh.defaultModel
  ctx.config.lang = fresh.lang
  ctx.config.permissionMode = fresh.permissionMode
}

function replaceRecord<T>(target: Record<string, T>, source: Record<string, T>): void {
  for (const key of Object.keys(target)) delete target[key]
  Object.assign(target, source)
}

function parseSchema(input: string): Schema {
  if (input === 'anthropic' || input === 'openai' || input === 'openai-auth') return input
  throw new Error('schema must be one of anthropic, openai, openai-auth')
}

function parseOptionalSchema(input: string | undefined): Schema | undefined {
  if (!input) return undefined
  return parseSchema(input)
}

function parseRequestParamsFromFlags(
  parts: string[],
  schema: Schema,
  base?: Record<string, unknown>,
): { touched: boolean; params?: ModelRequestParams } & Pick<ModelTuningParams, 'reasoningEffort' | 'maxOutputTokens'> {
  let touched = false
  let params: ModelRequestParams = base
    ? normalizeModelRequestParams(base, schema, 'requestParams') ?? {}
    : {}
  let reasoningEffort: ModelTuningParams['reasoningEffort']
  let maxOutputTokens: ModelTuningParams['maxOutputTokens']
  if (parts.includes('--clear-params')) {
    params = {}
    touched = true
  }
  const requestParamsText = flagValue(parts, '--request-params') ?? flagValue(parts, '--params')
  if (requestParamsText !== undefined) {
    if (requestParamsText === '-') {
      params = {}
    } else {
      const tuning = parseModelTuningParamsText(requestParamsText, schema)
      params = tuning.requestParams ?? {}
      reasoningEffort = tuning.reasoningEffort
      maxOutputTokens = tuning.maxOutputTokens
    }
    touched = true
  }
  for (const raw of flagValues(parts, '--params-json')) {
    params = { ...params, ...parseModelRequestParamsJsonObject(raw) }
    touched = true
  }
  for (const raw of flagValues(parts, '--param')) {
    const [key, value] = parseModelRequestParamFlagValue(raw)
    params[key] = value
    touched = true
  }
  for (const raw of flagValues(parts, '--param-json')) {
    const [key, value] = parseModelRequestParamJsonFlagValue(raw)
    params[key] = value
    touched = true
  }
  for (const key of flagValues(parts, '--clear-param')) {
    delete params[key]
    touched = true
  }
  if (!touched) return { touched: false, params: base ? normalizeModelRequestParams(base, schema) : undefined }
  const tuning = splitModelTuningParams(params, schema, 'requestParams')
  const finalReasoningEffort = tuning.reasoningEffort ?? reasoningEffort
  const finalMaxOutputTokens = tuning.maxOutputTokens ?? maxOutputTokens
  return {
    touched: true,
    params: tuning.requestParams,
    ...(finalReasoningEffort ? { reasoningEffort: finalReasoningEffort } : {}),
    ...(finalMaxOutputTokens !== undefined ? { maxOutputTokens: finalMaxOutputTokens } : {}),
  }
}

function parseReasoningEffort(input: string | undefined): ReasoningEffort | undefined {
  if (!input) return undefined
  if (
    input === 'none' ||
    input === 'minimal' ||
    input === 'low' ||
    input === 'medium' ||
    input === 'high' ||
    input === 'xhigh'
  ) {
    return input
  }
  throw new Error('--reasoning must be one of none, minimal, low, medium, high, xhigh')
}

function parseOptionalPositiveInt(input: string | undefined): number | undefined {
  if (!input) return undefined
  const n = Number.parseInt(input, 10)
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error('value must be a positive integer')
  }
  return n
}

function parseTimeoutMs(parts: string[]): number {
  return parseOptionalPositiveInt(flagValue(parts, '--timeout-ms')) ?? DEFAULT_CHECK_TIMEOUT_MS
}

function assertAlias(kind: string, value: string): void {
  if (!ALIAS_RE.test(value)) {
    throw new Error(`${kind} alias must match /^[A-Za-z0-9_.-]{1,80}$/`)
  }
}

function flagValue(parts: string[], flag: string): string | undefined {
  const index = parts.indexOf(flag)
  if (index < 0) return undefined
  return parts[index + 1]
}

function flagValues(parts: string[], flag: string): string[] {
  const values: string[] = []
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i] === flag && parts[i + 1] !== undefined) {
      values.push(parts[i + 1]!)
    }
  }
  return values
}

function cloneOverride(current: UserConfigOverride): UserConfigOverride {
  return {
    ...current,
    ...(current.endpoints ? { endpoints: { ...current.endpoints } } : {}),
    ...(current.models ? { models: { ...current.models } } : {}),
  }
}

function prune(value: UserConfigOverride): UserConfigOverride {
  if (value.endpoints && Object.keys(value.endpoints).length === 0) delete value.endpoints
  if (value.models && Object.keys(value.models).length === 0) delete value.models
  return value
}
