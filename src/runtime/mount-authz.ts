import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { rlaunchMountApprovalsPath } from '../identity/paths.js'
import { shellQuote } from './process.js'

export type ObservedMountMode = 'none' | 'ro' | 'rw'
export type RequestedMountMode = 'ro' | 'rw'

export type MountRwApproval = {
  fileset: string
  mode: 'rw'
}

export type PendingMountRwApproval = {
  fileset: string
  path: string
  requestedAt: string
}

type MountApprovalFile = {
  version?: number
  approved?: unknown
  pending?: unknown
}

export function observePuyuclawMode(procMounts: string, workerPath: string): ObservedMountMode {
  const normalized = path.posix.normalize(workerPath)
  for (const line of procMounts.split('\n')) {
    const fields = line.trim().split(/\s+/)
    if (decodeProcMountField(fields[1] ?? '') !== normalized) continue
    const options = new Set((fields[3] ?? '').split(','))
    if (options.has('ro')) return 'ro'
    if (options.has('rw')) return 'rw'
  }
  return 'none'
}

export function resolveGrantedMode(
  requestedMode: RequestedMountMode,
  puyuclawMode: ObservedMountMode,
  adminApproved: boolean,
): RequestedMountMode {
  if (puyuclawMode === 'none') {
    throw new Error('runtime mount is not mounted for the daemon service identity')
  }
  if (requestedMode === 'ro') return 'ro'
  if (!adminApproved) {
    throw new Error('read-write runtime mount requires admin approval')
  }
  if (puyuclawMode !== 'rw') {
    throw new Error('read-write runtime mount was approved, but the service identity mount is read-only')
  }
  return 'rw'
}

export function buildReadOnlyRemountCommand(workerPath: string): string {
  const quoted = shellQuote(path.posix.normalize(workerPath))
  return `mount --bind ${quoted} ${quoted} && mount -o remount,ro,bind ${quoted}`
}

export function filesetKeyFromGpfsMount(gpfsMount: string): string {
  const source = gpfsMount.slice(0, gpfsMount.lastIndexOf(':'))
  const match = /^(gpfs:\/\/[^/]+\/[^/]+)/.exec(source)
  if (!match?.[1]) throw new Error(`Cannot determine GPFS fileset from mount: ${gpfsMount}`)
  return match[1]
}

export function loadMountRwApprovals(canonicalUser: string): {
  approved: MountRwApproval[]
  pending: PendingMountRwApproval[]
} {
  const target = rlaunchMountApprovalsPath(canonicalUser)
  if (!existsSync(target)) return { approved: [], pending: [] }
  let parsed: MountApprovalFile
  try {
    parsed = JSON.parse(readFileSync(target, 'utf8')) as MountApprovalFile
  } catch {
    return { approved: [], pending: [] }
  }
  const approved = Array.isArray(parsed.approved)
    ? parsed.approved.flatMap(entry => {
        const record = asRecord(entry)
        return typeof record?.fileset === 'string'
          ? [{ fileset: record.fileset, mode: 'rw' as const }]
          : []
      })
    : []
  const pending = Array.isArray(parsed.pending)
    ? parsed.pending.flatMap(entry => {
        const record = asRecord(entry)
        return typeof record?.fileset === 'string' && typeof record.path === 'string'
          ? [{
              fileset: record.fileset,
              path: record.path,
              requestedAt: typeof record.requestedAt === 'string'
                ? record.requestedAt
                : new Date(0).toISOString(),
            }]
          : []
      })
    : []
  return {
    approved: dedupeApproved(approved),
    pending: dedupePending(pending),
  }
}

export function isMountRwApproved(canonicalUser: string, fileset: string): boolean {
  return loadMountRwApprovals(canonicalUser).approved.some(entry => entry.fileset === fileset)
}

export function requestMountRwApproval(canonicalUser: string, fileset: string, mountPath: string): void {
  const state = loadMountRwApprovals(canonicalUser)
  if (state.approved.some(entry => entry.fileset === fileset)) return
  saveApprovalState(canonicalUser, {
    approved: state.approved,
    pending: dedupePending([
      ...state.pending,
      { fileset, path: mountPath, requestedAt: new Date().toISOString() },
    ]),
  })
}

export function approveMountRw(canonicalUser: string, fileset: string): void {
  const state = loadMountRwApprovals(canonicalUser)
  saveApprovalState(canonicalUser, {
    approved: dedupeApproved([...state.approved, { fileset, mode: 'rw' }]),
    pending: state.pending.filter(entry => entry.fileset !== fileset),
  })
}

export function revokeMountRw(canonicalUser: string, fileset: string): void {
  const state = loadMountRwApprovals(canonicalUser)
  saveApprovalState(canonicalUser, {
    approved: state.approved.filter(entry => entry.fileset !== fileset),
    pending: state.pending.filter(entry => entry.fileset !== fileset),
  })
}

function saveApprovalState(
  canonicalUser: string,
  state: { approved: MountRwApproval[]; pending: PendingMountRwApproval[] },
): void {
  const target = rlaunchMountApprovalsPath(canonicalUser)
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  writeFileSync(target, `${JSON.stringify({ version: 1, ...state }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
}

function decodeProcMountField(value: string): string {
  return value.replace(/\\040/g, ' ').replace(/\\011/g, '\t').replace(/\\134/g, '\\')
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null
}

function dedupeApproved(entries: MountRwApproval[]): MountRwApproval[] {
  return [...new Set(entries.map(entry => entry.fileset))]
    .sort()
    .map(fileset => ({ fileset, mode: 'rw' }))
}

function dedupePending(entries: PendingMountRwApproval[]): PendingMountRwApproval[] {
  const byFileset = new Map(entries.map(entry => [entry.fileset, entry]))
  return [...byFileset.values()].sort((a, b) => a.fileset.localeCompare(b.fileset))
}
