import { randomUUID } from 'node:crypto'

import type { Runtime } from '../runtime/index.js'
import {
  buildLauncherScript,
  ERR_FILE,
  jobDirFor,
  jobFile,
  META_FILE,
  OUT_FILE,
  serializeMeta,
  shellQuote,
} from './jobdir.js'
import { getBackgroundJobRegistry, type BackgroundJobRegistry } from './registry.js'
import type { BackgroundJobMeta } from './types.js'

export const LAUNCH_EXEC_BUDGET_MS = 15_000

export type LaunchBackgroundJobParams = {
  runtime: Runtime
  command: string
  cwd: string
  canonicalUser: string
  sessionId: string
  roleId?: string
  jobId?: string
  now?: number
  registry?: BackgroundJobRegistry
}

export async function launchBackgroundJob(params: LaunchBackgroundJobParams): Promise<BackgroundJobMeta> {
  const registry = params.registry ?? getBackgroundJobRegistry()
  registry.ensureCanRegister(params.sessionId)

  const jobId = params.jobId ?? `bg-${randomUUID().slice(0, 8)}`
  const jobDir = jobDirFor(params.runtime.workspaceRoot, jobId)
  const outFile = jobFile(jobDir, OUT_FILE)
  const errFile = jobFile(jobDir, ERR_FILE)

  const mkdir = await params.runtime.exec({
    command: `mkdir -p ${shellQuote(jobDir)}`,
    cwd: params.runtime.workspaceRoot,
    timeoutMs: LAUNCH_EXEC_BUDGET_MS,
    maxBufferBytes: 16 * 1024,
  })
  if (mkdir.exitCode !== 0) {
    throw new Error(`Failed to create background Bash job directory: ${mkdir.stderr || mkdir.stdout}`)
  }

  const launch = await params.runtime.exec({
    command: buildLauncherScript({ command: params.command, cwd: params.cwd }, jobDir),
    cwd: params.runtime.workspaceRoot,
    timeoutMs: LAUNCH_EXEC_BUDGET_MS,
    maxBufferBytes: 64 * 1024,
  })

  if (launch.exitCode !== 0) {
    await cleanupJobDir(params.runtime, jobDir)
    throw new Error(`Failed to launch background Bash job: ${launch.stderr || launch.stdout}`)
  }

  const match = launch.stdout.match(/LIGHTCLAW_BG_PGID:(\d+)/)
  if (!match) {
    await cleanupJobDir(params.runtime, jobDir)
    throw new Error(`Failed to launch background Bash job: launcher did not report a pgid.`)
  }

  const pgid = Number.parseInt(match[1], 10)
  const meta: BackgroundJobMeta = {
    jobId,
    command: params.command,
    cwd: params.cwd,
    canonicalUser: params.canonicalUser,
    sessionId: params.sessionId,
    roleId: params.roleId,
    pgid,
    startedAt: params.now ?? Date.now(),
    outFile,
    errFile,
  }

  await params.runtime.fs.writeFile(jobFile(jobDir, META_FILE), serializeMeta(meta))
  registry.register(meta, params.runtime)
  return meta
}

async function cleanupJobDir(runtime: Runtime, jobDir: string): Promise<void> {
  await runtime.exec({
    command: `rm -rf ${shellQuote(jobDir)}`,
    cwd: runtime.workspaceRoot,
    timeoutMs: LAUNCH_EXEC_BUDGET_MS,
    maxBufferBytes: 16 * 1024,
  }).catch(() => undefined)
}
