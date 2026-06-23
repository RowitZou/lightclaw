import type { ReasoningEffort, Schema } from './provider/types.js'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type ModelRequestParams = Record<string, JsonValue>
export type ModelTuningParams = {
  requestParams?: ModelRequestParams
  reasoningEffort?: ReasoningEffort
  maxOutputTokens?: number
}

export const MODEL_REQUEST_PARAMS_MAX_CHARS = 8192

const COMMON_RESERVED = new Set([
  'model',
  'messages',
  'message',
  'input',
  'instructions',
  'system',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'stream',
  'stream_options',
  'store',
  'prompt_cache_key',
  'max_tokens',
  'max_output_tokens',
  'reasoning',
  'signal',
])

const RESERVED_BY_SCHEMA: Record<Schema, Set<string>> = {
  anthropic: new Set([
    ...COMMON_RESERVED,
    'max_tokens',
  ]),
  openai: new Set([
    ...COMMON_RESERVED,
    'max_completion_tokens',
  ]),
  'openai-auth': new Set([
    ...COMMON_RESERVED,
    'include',
    'previous_response_id',
  ]),
}

export function normalizeModelRequestParams(
  value: unknown,
  schema: Schema,
  field = 'requestParams',
): ModelRequestParams | undefined {
  if (value === undefined) return undefined
  if (!isPlainRecord(value)) {
    throw new Error(`${field} must be a JSON object`)
  }
  const out: ModelRequestParams = {}
  for (const [key, raw] of Object.entries(value)) {
    const name = key.trim()
    if (!name) throw new Error(`${field} contains an empty key`)
    assertAllowedModelRequestParamKey(schema, name, field)
    if (!isJsonValue(raw)) {
      throw new Error(`${field}.${name} must be a JSON value`)
    }
    out[name] = raw
  }
  assertModelRequestParamsSize(out, field)
  return Object.keys(out).length > 0 ? out : undefined
}

export function assertAllowedModelRequestParamKey(
  schema: Schema,
  key: string,
  field = 'requestParams',
): void {
  const reserved = RESERVED_BY_SCHEMA[schema] ?? COMMON_RESERVED
  if (reserved.has(key)) {
    throw new Error(`${field}.${key} is managed by LightClaw; use the dedicated model fields instead`)
  }
}

export function assertModelRequestParamsSize(
  params: ModelRequestParams,
  field = 'requestParams',
): void {
  const size = JSON.stringify(params).length
  if (size > MODEL_REQUEST_PARAMS_MAX_CHARS) {
    throw new Error(`${field} is too large (${size} chars; max ${MODEL_REQUEST_PARAMS_MAX_CHARS})`)
  }
}

export function parseModelRequestParamsText(
  raw: string | undefined,
  schema: Schema,
): ModelRequestParams | undefined {
  return parseModelTuningParamsText(raw, schema).requestParams
}

export function parseModelTuningParamsText(
  raw: string | undefined,
  schema: Schema,
): ModelTuningParams {
  const text = raw?.trim()
  if (!text || text === '-') return {}
  if (text.startsWith('{')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new Error(`requestParams JSON parse failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return splitModelTuningParams(parsed, schema, 'requestParams')
  }

  const params: Record<string, JsonValue> = {}
  const lines = text
    .split(/[\n;]/)
    .map(line => line.trim())
    .filter(Boolean)
  for (const line of lines) {
    const eq = line.indexOf('=')
    if (eq <= 0) {
      throw new Error(`requestParams line must be key=value: ${line}`)
    }
    const key = line.slice(0, eq).trim()
    const valueText = line.slice(eq + 1).trim()
    if (!key) throw new Error('requestParams contains an empty key')
    params[key] = parseLooseJsonValue(valueText)
  }
  return splitModelTuningParams(params, schema, 'requestParams')
}

export function parseModelRequestParamFlagValue(raw: string): [string, JsonValue] {
  const eq = raw.indexOf('=')
  if (eq <= 0) throw new Error('--param values must look like key=value')
  const key = raw.slice(0, eq).trim()
  if (!key) throw new Error('--param key is empty')
  return [key, parseLooseJsonValue(raw.slice(eq + 1).trim())]
}

export function parseModelRequestParamJsonFlagValue(raw: string): [string, JsonValue] {
  const eq = raw.indexOf('=')
  if (eq <= 0) throw new Error('--param-json values must look like key=<json>')
  const key = raw.slice(0, eq).trim()
  if (!key) throw new Error('--param-json key is empty')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(eq + 1).trim())
  } catch (error) {
    throw new Error(`--param-json ${key} parse failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isJsonValue(parsed)) {
    throw new Error(`--param-json ${key} must be a JSON value`)
  }
  return [key, parsed]
}

export function parseModelRequestParamsJsonObject(raw: string): ModelRequestParams {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`--params-json parse failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isPlainRecord(parsed)) {
    throw new Error('--params-json must be a JSON object')
  }
  const out: ModelRequestParams = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (!isJsonValue(value)) throw new Error(`--params-json ${key} must be a JSON value`)
    out[key] = value
  }
  return out
}

export function splitModelTuningParams(
  value: unknown,
  schema: Schema,
  field = 'requestParams',
): ModelTuningParams {
  if (value === undefined) return {}
  if (!isPlainRecord(value)) {
    throw new Error(`${field} must be a JSON object`)
  }
  const requestParams: ModelRequestParams = {}
  let reasoningEffort: ReasoningEffort | undefined
  let maxOutputTokens: number | undefined
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = rawKey.trim()
    if (!key) throw new Error(`${field} contains an empty key`)
    if (!isJsonValue(rawValue)) {
      throw new Error(`${field}.${key} must be a JSON value`)
    }
    if (isReasoningKey(key)) {
      reasoningEffort = parseReasoningEffortValue(rawValue, `${field}.${key}`)
      continue
    }
    if (isMaxOutputTokensKey(key)) {
      maxOutputTokens = parsePositiveIntValue(rawValue, `${field}.${key}`)
      continue
    }
    requestParams[key] = rawValue
  }
  const normalized = normalizeModelRequestParams(requestParams, schema, field)
  return {
    ...(normalized ? { requestParams: normalized } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
  }
}

export function formatModelRequestParams(params: ModelRequestParams | undefined): string {
  if (!params || Object.keys(params).length === 0) return '-'
  return Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join('; ')
}

export function formatModelRequestParamsForCard(params: ModelRequestParams | undefined): string {
  const formatted = formatModelRequestParams(params)
  return formatted.length <= 120 ? formatted : `${formatted.slice(0, 119)}…`
}

export function formatModelRequestParamHelp(schema?: Schema | 'self-hosted'): string {
  const sections = [
    '模型自定义请求参数只用于可选请求字段，不能覆盖 model/messages/tools/stream/max_tokens/reasoning 等 LightClaw 核心字段。',
    '',
    'OpenAI / OpenAI-compatible：',
    '- 常用：temperature、top_p、presence_penalty、frequency_penalty、seed、stop、response_format、logit_bias、user',
    '- vLLM / SGLang 常见：temperature、top_p、top_k、min_p、repetition_penalty、stop、stop_token_ids、guided_json、guided_regex',
    '',
    'Anthropic：',
    '- 常用：temperature、top_p、top_k、stop_sequences、metadata、service_tier',
    '',
    'Codex OAuth / Responses：',
    '- 建议先少量使用 temperature、top_p、text、truncation 等字段；Codex 后端可能拒绝部分 Responses 参数。',
    '',
    '填写格式：',
    '- 常用专用参数也可在参数行中填写：reasoningEffort=high、maxOutputTokens=64000。',
    '- UI：每行或分号分隔 key=value；复杂值可直接填 JSON object。',
    '- 命令：`--param temperature=0.2`、`--param-json response_format={"type":"json_object"}`、`--params-json {"temperature":0.2}`。',
  ]
  if (schema) {
    sections.unshift(`当前参考类型：${schema}`)
  }
  return sections.join('\n')
}

function parseReasoningEffortValue(value: JsonValue, field: string): ReasoningEffort {
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string: none, minimal, low, medium, high, xhigh`)
  }
  if (
    value === 'none' ||
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh'
  ) {
    return value
  }
  throw new Error(`${field} must be one of none, minimal, low, medium, high, xhigh`)
}

function parsePositiveIntValue(value: JsonValue, field: string): number {
  const n = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseInt(value, 10)
      : NaN
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${field} must be a positive integer`)
  }
  return n
}

function isReasoningKey(key: string): boolean {
  return key === 'reasoningEffort' || key === 'reasoning_effort' || key === 'reasoning'
}

function isMaxOutputTokensKey(key: string): boolean {
  return (
    key === 'maxOutputTokens' ||
    key === 'max_output_tokens' ||
    key === 'maxTokens' ||
    key === 'max_tokens'
  )
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return true
  }
  if (typeof value === 'number') {
    return Number.isFinite(value)
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue)
  }
  if (isPlainRecord(value)) {
    return Object.values(value).every(isJsonValue)
  }
  return false
}

function parseLooseJsonValue(raw: string): JsonValue {
  if (raw === '') return ''
  if (
    raw === 'true' ||
    raw === 'false' ||
    raw === 'null' ||
    raw.startsWith('{') ||
    raw.startsWith('[') ||
    /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(raw)
  ) {
    try {
      const parsed = JSON.parse(raw)
      if (isJsonValue(parsed)) return parsed
    } catch {
      // Fall through to string for user-friendly key=value input.
    }
  }
  return raw
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
