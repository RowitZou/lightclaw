import {
  classifyFeishuError,
  detectFeishuScopeMissing,
  FeishuApiError,
  formatFeishuHttpError,
  formatFeishuScopeMissing,
  type FeishuScopeMissingInfo,
} from './errors.js'

export type FeishuEnvelope<T = unknown> = {
  code?: number
  msg?: string
  data?: T
}

/**
 * Recognize the "you forgot to enable a scope" family of Feishu errors.
 *
 * We deliberately don't pin to a single error code (Feishu cycles codes
 * occasionally — today `drive:drive` returns `99991672`, tomorrow a
 * different module's scope-missing might land on a different code). Match
 * on the structural signal Feishu actually keeps stable:
 *
 *   1. `error.permission_violations[].type === 'action_scope_required'` —
 *      the canonical machine-readable shape, lists exactly which scopes
 *      would satisfy the call.
 *   2. Fallback: message text contains `scope[s] (is|are) required` (en)
 *      or `应用尚未开通所需的应用身份权限` (zh).
 *
 * Returns null when the error is something else (network, malformed body,
 * unrelated 4xx, etc.) — callers should keep their normal error path.
 */
export { detectFeishuScopeMissing, formatFeishuScopeMissing, type FeishuScopeMissingInfo }

export async function callFeishu<T extends FeishuEnvelope>(
  fn: () => Promise<T>,
): Promise<T> {
  let result: T
  try {
    result = await fn()
  } catch (error) {
    throw new FeishuApiError(classifyFeishuError(error), error)
  }
  if (typeof result?.code === 'number' && result.code !== 0) {
    throw new FeishuApiError(classifyFeishuError({
      response: {
        status: 400,
        data: { code: result.code, msg: result.msg ?? 'unknown error' },
      },
    }))
  }
  return result
}

export function feishuErrorMessage(error: unknown): string {
  return formatFeishuHttpError(error)
}
