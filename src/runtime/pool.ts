import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

import type { LightClawConfig } from '../config.js'
import { adminPath, sanitizePathSegment, workspaceFor } from '../identity/paths.js'

import { createRuntime, DockerRuntime, type DockerRuntimeConfig } from './index.js'
import { dockerCmdRaw } from './docker.js'
import type { Runtime } from './types.js'

const REAPER_INTERVAL_MS = 60_000
const DEFAULT_IMAGE_OWNER = 'rowitzou'
const SANDBOX_PREFIX = 'lightclaw-sandbox-'

export class RuntimePool {
  private readonly runtimes = new Map<string, Runtime>()
  private reaperTimer: NodeJS.Timeout | null = null
  private deploymentHash = computeDeploymentHash()
  private idleTimeoutMs = 1_800_000

  acquire(userId: string, config: LightClawConfig, workspaceHostPath?: string): Runtime {
    this.idleTimeoutMs = config.runtime.docker.idleTimeoutMs
    const key = runtimeKey(userId, workspaceHostPath)
    const existing = this.runtimes.get(key)
    if (existing?.kind === config.runtime.backend) {
      return existing
    }

    const runtime = this.create(userId, config, workspaceHostPath)
    this.runtimes.set(key, runtime)
    return runtime
  }

  async release(userId: string, workspaceHostPath?: string): Promise<void> {
    const key = runtimeKey(userId, workspaceHostPath)
    const runtime = this.runtimes.get(key)
    if (runtime) {
      await runtime.stop()
    }
  }

  async remove(
    userId: string,
    workspaceHostPath?: string,
  ): Promise<{ containerName?: string; image?: string }> {
    const key = runtimeKey(userId, workspaceHostPath)
    const runtime = this.runtimes.get(key)
    if (!runtime) {
      return {}
    }
    const result = runtime instanceof DockerRuntime
      ? { containerName: runtime.containerName, image: runtime.image }
      : {}
    await runtime.stop().catch(() => {})
    if (runtime instanceof DockerRuntime) {
      await runtime.remove()
    }
    this.runtimes.delete(key)
    return result
  }

  async releaseAll(): Promise<void> {
    await Promise.allSettled([...this.runtimes.values()].map(runtime => runtime.stop()))
  }

  startReaper(): void {
    if (this.reaperTimer) {
      return
    }
    this.reaperTimer = setInterval(() => {
      void this.sweepIdle()
    }, REAPER_INTERVAL_MS)
    this.reaperTimer.unref?.()
  }

  stopReaper(): void {
    if (!this.reaperTimer) {
      return
    }
    clearInterval(this.reaperTimer)
    this.reaperTimer = null
  }

  async sweepOrphans(config: LightClawConfig): Promise<void> {
    if (config.runtime.backend !== 'docker') {
      return
    }
    const expectedImage = resolveDockerImage(config)
    const result = await dockerCmdRaw([
      'ps',
      '-a',
      '--filter',
      `name=${SANDBOX_PREFIX}`,
      '--format',
      '{{.Names}}|{{.Image}}|{{.Status}}',
    ])
    if (result.exitCode !== 0) {
      throw new Error(`docker ps failed: ${result.stderr.trim() || result.stdout.trim()}`)
    }

    for (const line of result.stdout.split('\n').filter(Boolean)) {
      const [name, image, status] = line.split('|')
      if (!name?.startsWith(SANDBOX_PREFIX)) {
        continue
      }
      const hash = name.split('-').at(-1)
      const statusLower = (status ?? '').toLowerCase()
      const shouldRemove =
        hash !== this.deploymentHash ||
        image !== expectedImage ||
        statusLower.startsWith('dead') ||
        statusLower.startsWith('removing')
      if (shouldRemove) {
        await dockerCmdRaw(['rm', '-f', name])
      }
    }
  }

  private async sweepIdle(): Promise<void> {
    const now = Date.now()
    for (const runtime of this.runtimes.values()) {
      if (!(runtime instanceof DockerRuntime) || !runtime.isRunning()) {
        continue
      }
      if (now - runtime.lastActivityMs <= this.idleTimeoutMs) {
        continue
      }
      if (Date.now() - runtime.lastActivityMs > this.idleTimeoutMs) {
        await runtime.stop().catch(() => {})
      }
    }
  }

  private create(userId: string, config: LightClawConfig, workspaceRoot?: string): Runtime {
    const workspaceHostPath = path.resolve(workspaceRoot ?? workspaceFor(userId))
    if (config.runtime.backend === 'local') {
      return createRuntime({ kind: 'local', workspaceRoot: workspaceHostPath })
    }
    if (config.runtime.backend === 'docker') {
      return createRuntime({
        kind: 'docker',
        config: buildDockerRuntimeConfig(userId, workspaceHostPath, config, this.deploymentHash),
      })
    }
    return createRuntime({ kind: 'rjob' })
  }
}

function runtimeKey(userId: string, workspaceHostPath?: string): string {
  return userId === '__terminal__' && workspaceHostPath
    ? `${userId}:${path.resolve(workspaceHostPath)}`
    : userId
}

export function resolveDockerImage(config: LightClawConfig): string {
  return config.runtime.docker.imageOverride ??
    config.runtime.docker.image ??
    defaultImageRef()
}

export function buildDockerRuntimeConfig(
  userId: string,
  workspaceHostPath: string,
  config: LightClawConfig,
  deploymentHash = computeDeploymentHash(),
): DockerRuntimeConfig {
  const docker = config.runtime.docker
  return {
    image: resolveDockerImage(config),
    workspaceHostPath,
    containerName: `${SANDBOX_PREFIX}${sanitizeDockerName(userId)}-${deploymentHash}`,
    helperContainerPath: '/opt/lightclaw/sandbox-helpers',
    workspaceContainerPath: '/workspace',
    mounts: docker.mounts,
    tmpfs: docker.tmpfs,
    env: docker.env,
    memoryLimit: docker.memoryLimit,
    cpuLimit: docker.cpuLimit,
    network: docker.network,
    autoPull: docker.autoPull,
  }
}

function computeDeploymentHash(): string {
  const target = adminPath()
  if (!existsSync(target)) {
    return 'noadmin0'
  }
  return createHash('sha256')
    .update(readFileSync(target))
    .digest('hex')
    .slice(0, 8)
}

function sanitizeDockerName(userId: string): string {
  return sanitizePathSegment(userId)
    .toLowerCase()
    .replace(/_/g, '-')
    .replace(/^-+|-+$/g, '') || 'user'
}

function defaultImageRef(): string {
  const version = readPackageVersion()
  const owner = (process.env.LIGHTCLAW_DOCKER_OWNER ?? DEFAULT_IMAGE_OWNER).toLowerCase()
  return `ghcr.io/${owner}/lightclaw-sandbox:${version}`
}

function readPackageVersion(): string {
  const dirname = fileDirname()
  const candidates = [
    path.resolve(dirname, '../../package.json'),
    path.resolve(dirname, '../package.json'),
    path.resolve(process.cwd(), 'package.json'),
    path.resolve(homedir(), 'workspace/lightclaw/package.json'),
  ]
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue
    }
    const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: string }
    if (parsed.version) {
      return parsed.version
    }
  }
  return '0.1.0'
}

function fileDirname(): string {
  return path.dirname(new URL(import.meta.url).pathname)
}
