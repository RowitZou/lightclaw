import type {
  HookAuditEntry,
  HookName,
  HookPayloadMap,
  HookResultMap,
  RegisteredHook,
} from './types.js'

const BLOCKING_HOOKS = new Set<HookName>(['beforeQuery', 'beforeToolCall'])

export type HookManagerOptions = {
  blockingTimeoutMs: number
  nonBlockingTimeoutMs: number
}

export class HookManager {
  private hooksByName = new Map<HookName, RegisteredHook[]>()

  constructor(private options: HookManagerOptions) {}

  configure(options: HookManagerOptions): void {
    this.options = options
  }

  setHooks(hooks: RegisteredHook[]): void {
    this.hooksByName.clear()
    for (const hook of hooks) {
      const existing = this.hooksByName.get(hook.name) ?? []
      existing.push(hook)
      this.hooksByName.set(hook.name, existing)
    }
  }

  clear(): void {
    this.hooksByName.clear()
  }

  list(): RegisteredHook[] {
    return Array.from(this.hooksByName.values()).flat()
  }

  async run<N extends HookName>(
    name: N,
    payload: HookPayloadMap[N],
    onAudit?: (entry: HookAuditEntry) => void,
  ): Promise<HookResultMap[N]> {
    const hooks = this.hooksByName.get(name)
    if (!hooks || hooks.length === 0) {
      return undefined as HookResultMap[N]
    }

    const timeout = BLOCKING_HOOKS.has(name)
      ? this.options.blockingTimeoutMs
      : this.options.nonBlockingTimeoutMs
    let accumulated: unknown

    for (const hook of hooks) {
      try {
        const effectivePayload = Object.freeze({
          ...mergeAccumulatedIntoPayload(name, payload, accumulated),
        }) as HookPayloadMap[N]
        const result = await runWithTimeout(
          () => hook.fn(effectivePayload as never) as Promise<unknown>,
          timeout,
          `${name}@${hook.identifier}`,
        )
        if (result && typeof result === 'object') {
          accumulated = mergeResult(name, accumulated, result)
        }
        onAudit?.({
          hook: hook.identifier,
          hookName: name,
          file: hook.file,
          result,
        })

        if (
          name === 'beforeToolCall' &&
          result &&
          typeof result === 'object' &&
          (result as { decision?: string }).decision === 'deny'
        ) {
          return accumulated as HookResultMap[N]
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        process.stderr.write(`hooks: ${hook.identifier} (${name}) failed: ${message}\n`)
        onAudit?.({
          hook: hook.identifier,
          hookName: name,
          file: hook.file,
          error: message,
        })
      }
    }

    return accumulated as HookResultMap[N]
  }
}

async function runWithTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<undefined>(resolve => {
    timer = setTimeout(() => {
      process.stderr.write(`hooks: ${label} timed out after ${timeoutMs}ms\n`)
      resolve(undefined)
    }, timeoutMs)
  })

  try {
    return await Promise.race([fn(), timeout])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

function mergeAccumulatedIntoPayload<N extends HookName>(
  name: N,
  payload: HookPayloadMap[N],
  accumulated: unknown,
): HookPayloadMap[N] {
  if (!accumulated || typeof accumulated !== 'object') {
    return payload
  }

  if (name === 'beforeQuery') {
    const replacementInput = (accumulated as { replacementInput?: string }).replacementInput
    if (replacementInput !== undefined) {
      return { ...payload, input: replacementInput } as HookPayloadMap[N]
    }
  }

  if (name === 'beforeToolCall') {
    const replacementInput = (accumulated as { replacementInput?: unknown }).replacementInput
    if (replacementInput !== undefined) {
      return { ...payload, input: replacementInput } as HookPayloadMap[N]
    }
  }

  if (name === 'afterToolCall') {
    const replacementResult = (accumulated as { replacementResult?: string }).replacementResult
    if (replacementResult !== undefined) {
      return { ...payload, result: replacementResult } as HookPayloadMap[N]
    }
  }

  return payload
}

function mergeResult(
  name: HookName,
  previous: unknown,
  result: unknown,
): unknown {
  if (!result || typeof result !== 'object') {
    return previous
  }

  if (name === 'beforeQuery' || name === 'beforeToolCall' || name === 'afterToolCall') {
    return {
      ...(previous && typeof previous === 'object' ? previous : {}),
      ...(result as Record<string, unknown>),
    }
  }

  return previous
}
