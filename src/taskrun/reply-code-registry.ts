import { randomUUID } from 'node:crypto'

const codesByRunId = new Map<string, Set<string>>()

export function mintReplyCode(childRunId: string): string {
  const code = `rc_${randomUUID().slice(0, 8)}`
  const existing = codesByRunId.get(childRunId)
  if (existing) {
    existing.add(code)
  } else {
    codesByRunId.set(childRunId, new Set([code]))
  }
  return code
}

export function consumeReplyCode(childRunId: string, code: string): boolean {
  const codes = codesByRunId.get(childRunId)
  if (!codes) return false
  const consumed = codes.delete(code)
  if (codes.size === 0) codesByRunId.delete(childRunId)
  return consumed
}

export function clearReplyCodesForRun(childRunId: string): void {
  codesByRunId.delete(childRunId)
}

export function hasReplyCode(childRunId: string, code: string): boolean {
  return codesByRunId.get(childRunId)?.has(code) ?? false
}

export function resetReplyCodeRegistryForTest(): void {
  codesByRunId.clear()
}
