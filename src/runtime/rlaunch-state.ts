import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

import { lightclawHome } from '../paths.js'

export type RlaunchWorkerRecord = {
  name: string
  namespace: string
  chargedGroup: string
  image: string
  deploymentHash: string
  createdAt: number
}

export type RlaunchWorkerState = Record<string, RlaunchWorkerRecord>

export function rlaunchWorkerStatePath(): string {
  return path.join(lightclawHome(), 'state', 'rlaunch-workers.json')
}

export function readWorkerState(): RlaunchWorkerState {
  const target = rlaunchWorkerStatePath()
  if (!existsSync(target)) {
    return {}
  }
  const raw = readFileSync(target, 'utf8')
  return JSON.parse(raw) as RlaunchWorkerState
}

export function lookupWorkerRecord(canonicalUser: string): RlaunchWorkerRecord | undefined {
  return readWorkerState()[canonicalUser]
}

// Serialize read-modify-write so concurrent preheat/start across users doesn't
// drop entries (each writer reads its own copy of the state, last writer wins).
let writeQueue: Promise<unknown> = Promise.resolve()

function withStateLock<T>(action: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(action, action)
  writeQueue = next.catch(() => {})
  return next
}

export async function writeWorkerRecord(
  canonicalUser: string,
  record: RlaunchWorkerRecord,
): Promise<void> {
  await withStateLock(async () => {
    const state = readWorkerState()
    state[canonicalUser] = record
    await writeWorkerState(state)
  })
}

export async function deleteWorkerRecord(canonicalUser: string): Promise<void> {
  await withStateLock(async () => {
    const state = readWorkerState()
    if (!(canonicalUser in state)) {
      return
    }
    delete state[canonicalUser]
    await writeWorkerState(state)
  })
}

async function writeWorkerState(state: RlaunchWorkerState): Promise<void> {
  const target = rlaunchWorkerStatePath()
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  const tmp = `${target}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  renameSync(tmp, target)
}
