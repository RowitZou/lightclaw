import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export function readJsonObjectOrEmpty(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {}
  const raw = readFileSync(file, 'utf8')
  if (!raw.trim()) return {}
  const parsed = JSON.parse(raw) as unknown
  if (!isPlainObject(parsed)) {
    throw new Error(`Config at ${file} is not a JSON object — refusing to auto-write.`)
  }
  return parsed
}

export function atomicWriteJson(file: string, body: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp.${process.pid}`
  writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function mergeExternalConfig(
  home: Record<string, unknown>,
  external: Record<string, unknown>,
  snapshot: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...home }
  const keys = new Set([...Object.keys(external), ...Object.keys(snapshot)])

  for (const key of keys) {
    const extHas = Object.prototype.hasOwnProperty.call(external, key)
    const snapHas = Object.prototype.hasOwnProperty.call(snapshot, key)
    const extVal = external[key]
    const snapVal = snapshot[key]
    const homeVal = result[key]

    if (extHas && isPlainObject(extVal)) {
      const base = isPlainObject(homeVal) ? homeVal : {}
      const snap = isPlainObject(snapVal) ? snapVal : {}
      result[key] = mergeExternalConfig(base, extVal, snap)
      continue
    }

    if (extHas) {
      result[key] = extVal
      continue
    }

    if (snapHas) {
      if (isPlainObject(snapVal) && isPlainObject(homeVal)) {
        const sub = mergeExternalConfig(homeVal, {}, snapVal)
        if (Object.keys(sub).length === 0) {
          delete result[key]
        } else {
          result[key] = sub
        }
      } else {
        delete result[key]
      }
    }
  }

  return result
}
