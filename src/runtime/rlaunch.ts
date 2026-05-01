import path from 'node:path'

import type {
  ExecInput,
  ExecResult,
  GlobOptions,
  Runtime,
  RuntimeAvailability,
  RuntimeFs,
  RuntimeStat,
} from './types.js'
import { runProcess, shellQuote } from './process.js'
import { formatRlaunchError, translateRlaunchError } from './rlaunch-errors.js'
import {
  deleteWorkerRecord,
  lookupWorkerRecord,
  writeWorkerRecord,
} from './rlaunch-state.js'
import { WorkerReadinessTracker } from './worker-readiness.js'

export type RlaunchRuntimeConfig = {
  canonicalUser: string
  deploymentHash: string
  image: string
  chargedGroup: string
  namespace: string
  cpu: number
  memoryMb: number
  gpu: number
  privateMachine: 'group' | 'yes' | 'no' | 'project' | 'tenant'
  positiveTags: readonly string[]
  workerGcTimeHours: number
  imagePullPolicy: 'IfNotPresent' | 'Always' | 'Never'
  maxWaitDuration: string
  predictBeforeStart: boolean
  workspaceHostPath: string
  workspaceGpfsMount: string
  workspaceContainerPath: string
  helperContainerPath: string
  /** Env injected at worker creation via `rlaunch -e KEY=VALUE`. */
  env: Readonly<Record<string, string>>
}

type ProcessState =
  | 'absent'
  | 'running'
  | 'starting'
  | 'pending'
  | 'stopped'
  | 'failed'
  | 'unknown'

const DEFAULT_TIMEOUT_MS = 30_000
const START_TIMEOUT_MS = 180_000
const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024

export class RlaunchRuntime implements Runtime {
  readonly kind = 'rlaunch' as const
  readonly isolated = true
  readonly workspaceRoot: string
  readonly helperRoot: string
  readonly canonicalUser: string

  lastActivityMs = Date.now()

  private readonly cfg: RlaunchRuntimeConfig
  private readonly tracker: WorkerReadinessTracker
  private readonly mountTable: Array<[string, string]>
  private workerName: string | null = null
  private lastKnownState: ProcessState = 'unknown'
  private inflightStart: Promise<void> | null = null

  constructor(config: RlaunchRuntimeConfig, tracker: WorkerReadinessTracker) {
    this.cfg = config
    this.tracker = tracker
    this.canonicalUser = config.canonicalUser
    this.workspaceRoot = config.workspaceContainerPath
    this.helperRoot = config.helperContainerPath
    this.mountTable = [[path.resolve(config.workspaceHostPath), config.workspaceContainerPath]]
  }

  get name(): string | null {
    return this.workerName
  }

  async start(): Promise<void> {
    // Dedup concurrent callers (preheat-on-startup, preheat-on-approval,
    // ensureRunning, health checker restart) so they don't each spawn a
    // duplicate cluster worker and orphan the older ones.
    if (this.inflightStart) {
      return this.inflightStart
    }
    this.inflightStart = this._startOnce().finally(() => {
      this.inflightStart = null
    })
    return this.inflightStart
  }

  private async _startOnce(): Promise<void> {
    const record = lookupWorkerRecord(this.cfg.canonicalUser)
    if (record && record.deploymentHash === this.cfg.deploymentHash) {
      const phase = await this.processPhase(record.name)
      // 'unknown' = transient brainctl-get failure (API blip / unknown column).
      // The worker is most likely still alive — attaching is safer than
      // discarding the record and orphaning a running worker on the cluster.
      if (
        phase === 'running' ||
        phase === 'starting' ||
        phase === 'pending' ||
        phase === 'unknown'
      ) {
        this.workerName = record.name
        if (phase === 'running') {
          this.tracker.markReady()
        } else {
          this.tracker.startSchedule(this.cfg.image)
        }
        return
      }
      await deleteWorkerRecord(this.cfg.canonicalUser)
    } else if (record) {
      await this.stopWorker(record.name).catch(() => {})
      await deleteWorkerRecord(this.cfg.canonicalUser)
    }

    this.tracker.startSchedule(this.cfg.image)
    if (this.cfg.predictBeforeStart) {
      await this.runPredict()
    }

    const newName = await this.spawnWorker()
    this.workerName = newName
    await writeWorkerRecord(this.cfg.canonicalUser, {
      name: newName,
      namespace: this.cfg.namespace,
      chargedGroup: this.cfg.chargedGroup,
      image: this.cfg.image,
      deploymentHash: this.cfg.deploymentHash,
      createdAt: Date.now(),
    })
  }

  async isAvailable(): Promise<RuntimeAvailability> {
    if (this.workerName) {
      const phase = await this.processPhase(this.workerName)
      if (phase === 'running') {
        this.tracker.markReady()
        return { ok: true }
      }
      if (phase === 'failed' || phase === 'stopped' || phase === 'absent') {
        this.tracker.markFailed(`worker ${this.workerName} is ${phase}`)
      }
    }

    const snap = this.tracker.snapshot()
    if (snap.state === 'ready') return { ok: true }
    if (snap.state === 'scheduling' || snap.state === 'not-attempted') {
      const elapsed = snap.scheduleDurationMs ? Math.round(snap.scheduleDurationMs / 1000) : 0
      return {
        ok: false,
        reason: 'worker-scheduling',
        userMessage:
          `集群正在准备你的工作环境（已 ${elapsed} 秒）。我现在不能执行命令、读写文件或抓取网页，` +
          '但可以继续聊天。',
        adminMessage:
          `RlaunchRuntime worker scheduling for ${this.cfg.canonicalUser} ` +
          `(image=${snap.image ?? this.cfg.image}, elapsed=${elapsed}s)`,
      }
    }
    if (snap.state === 'quota-denied') {
      return {
        ok: false,
        reason: 'worker-quota-denied',
        userMessage: '集群资源暂时不足，当前不能使用工具。已记录给管理员排查。',
        adminMessage: snap.lastError ??
          `RlaunchRuntime quota denied for ${this.cfg.canonicalUser}`,
      }
    }
    return {
      ok: false,
      reason: 'worker-failed',
      userMessage: '集群工作环境未就绪。已记录给管理员排查，目前我只能处理聊天类话题。',
      adminMessage: snap.lastError ?? `RlaunchRuntime worker failed for ${this.cfg.canonicalUser}`,
    }
  }

  async stop(): Promise<void> {
    if (!this.workerName) {
      const record = lookupWorkerRecord(this.cfg.canonicalUser)
      this.workerName = record?.deploymentHash === this.cfg.deploymentHash ? record.name : null
    }
    if (!this.workerName) {
      return
    }
    await this.stopWorker(this.workerName)
    this.lastKnownState = 'stopped'
  }

  async remove(): Promise<void> {
    await this.stop().catch(() => {})
    await deleteWorkerRecord(this.cfg.canonicalUser)
    this.workerName = null
  }

  isRunning(): boolean {
    return this.lastKnownState === 'running'
  }

  async exec(input: ExecInput): Promise<ExecResult> {
    this.lastActivityMs = Date.now()
    await this.ensureRunning()
    const result = await this.runBrainctlExec(input)
    if (!this.isWorkerLostError(result)) {
      return result
    }

    await deleteWorkerRecord(this.cfg.canonicalUser)
    this.workerName = null
    await this.start()
    await this.waitUntilRunning()
    const retry = await this.runBrainctlExec(input)
    return {
      ...retry,
      stderr: `[runtime] worker restarted, container-local /tmp etc. lost\n${retry.stderr}`,
    }
  }

  fs: RuntimeFs = {
    readFile: async pathname => {
      const containerPath = this.toContainerPath(pathname)
      const result = await this.exec({
        command: `base64 -w 0 ${shellQuote(containerPath)}`,
      })
      if (result.exitCode !== 0) {
        throw new Error(`readFile ${pathname}: ${result.stderr.trim() || result.stdout.trim()}`)
      }
      return Buffer.from(result.stdout.trim(), 'base64')
    },
    writeFile: async (pathname, content) => {
      const containerPath = this.toContainerPath(pathname)
      const buffer = typeof content === 'string' ? Buffer.from(content) : content
      const command =
        `mkdir -p "$(dirname ${shellQuote(containerPath)})" && base64 -d > ${shellQuote(containerPath)}`
      const result = await this.exec({
        command,
        stdin: buffer.toString('base64'),
        maxBufferBytes: DEFAULT_MAX_BUFFER_BYTES,
      })
      if (result.exitCode !== 0) {
        throw new Error(`writeFile ${pathname}: ${result.stderr.trim() || result.stdout.trim()}`)
      }
    },
    stat: async (pathname): Promise<RuntimeStat> => {
      const containerPath = this.toContainerPath(pathname)
      const result = await this.exec({
        command: `stat -c '%s|%F|%Y' ${shellQuote(containerPath)}`,
      })
      if (result.exitCode !== 0) {
        throw new Error(`stat ${pathname}: ${result.stderr.trim() || result.stdout.trim()}`)
      }
      const [size, kind, mtime] = result.stdout.trim().split('|')
      return {
        size: Number(size),
        isFile: kind === 'regular file',
        isDirectory: kind === 'directory',
        mtimeMs: Number(mtime) * 1000,
      }
    },
    glob: async (pattern, options: GlobOptions = {}) => {
      const cwd = options.cwd ? this.toContainerPath(options.cwd) : this.workspaceRoot
      const result = await this.exec({
        command: `python3 ${shellQuote(path.posix.join(this.helperRoot, 'glob.py'))}`,
        stdin: JSON.stringify({
          pattern,
          cwd,
          ignore: options.ignore ?? [],
          onlyFiles: options.onlyFiles ?? true,
          dot: options.dot ?? false,
        }),
      })
      if (result.exitCode !== 0) {
        throw new Error(`glob: ${result.stderr.trim() || result.stdout.trim()}`)
      }
      return result.stdout.split('\n').filter(Boolean)
    },
    readdir: async pathname => {
      const containerPath = this.toContainerPath(pathname)
      const result = await this.exec({ command: `ls -A1 ${shellQuote(containerPath)}` })
      if (result.exitCode !== 0) {
        throw new Error(`readdir ${pathname}: ${result.stderr.trim() || result.stdout.trim()}`)
      }
      return result.stdout.split('\n').filter(Boolean)
    },
  }

  async peekProcessPhase(): Promise<ProcessState> {
    if (!this.workerName) {
      const record = lookupWorkerRecord(this.cfg.canonicalUser)
      if (!record || record.deploymentHash !== this.cfg.deploymentHash) {
        return 'absent'
      }
      this.workerName = record.name
    }
    return this.processPhase(this.workerName)
  }

  async restartUnhealthy(): Promise<void> {
    // Stop the old worker before forgetting it. Without this, every health
    // tick that triggers a restart leaves the previous worker alive on the
    // cluster (workerGcTimeHours collects it, but that may be hours away),
    // so a flapping worker accumulates orphans under the same canonicalUser.
    const oldName =
      this.workerName ?? lookupWorkerRecord(this.cfg.canonicalUser)?.name ?? null
    if (oldName) {
      await this.stopWorker(oldName).catch(() => {})
    }
    await deleteWorkerRecord(this.cfg.canonicalUser)
    this.workerName = null
    await this.start()
  }

  private async ensureRunning(): Promise<void> {
    if (!this.workerName) {
      await this.start()
    }
    await this.waitUntilRunning()
  }

  private async waitUntilRunning(): Promise<void> {
    const deadline = Date.now() + START_TIMEOUT_MS
    while (Date.now() < deadline) {
      const name = this.workerName
      if (!name) {
        await this.start()
        continue
      }
      const phase = await this.processPhase(name)
      if (phase === 'running') {
        this.tracker.markReady()
        return
      }
      if (phase === 'failed' || phase === 'stopped' || phase === 'absent') {
        this.tracker.markFailed(`worker ${name} is ${phase}`)
        throw new Error(`RlaunchRuntime worker ${name} is ${phase}`)
      }
      await delay(3000)
    }
    throw new Error(`RlaunchRuntime worker ${this.workerName ?? '<unknown>'} did not become Running in time.`)
  }

  private async runBrainctlExec(input: ExecInput): Promise<ExecResult> {
    if (!this.workerName) {
      throw new Error('RlaunchRuntime worker is not started.')
    }
    // Pass -i only when there is actual stdin to relay. brainctl exec -i with
    // an immediately-closed stdin pipe drops the child's stdout entirely (the
    // exec wrapper appears to race the close against stream attachment), so
    // commands like `echo hello` come back with exitCode=0 and empty stdout.
    // Without -i, stdout streams back normally; when stdin is present we still
    // need -i so the child can read the piped bytes (fs.writeFile / base64 -d).
    const args = [
      '-n', this.cfg.namespace,
      'exec', `process/${this.workerName}`,
    ]
    if (input.stdin !== undefined) {
      args.push('-i')
    }
    args.push('--', 'bash', '-c', this.wrapCommand(input))
    return runProcess('brainctl', args, {
      abortSignal: input.abortSignal,
      stdin: input.stdin,
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBufferBytes: input.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES,
      limitMessage: 'rlaunch worker exec terminated',
    })
  }

  private wrapCommand(input: ExecInput): string {
    const cwd = input.cwd ? this.toContainerPath(input.cwd) : this.workspaceRoot
    const envPart = input.env
      ? `${Object.entries(input.env)
        .map(([key, value]) => `export ${key}=${shellQuote(value)};`)
        .join(' ')} `
      : ''
    return `${envPart}cd ${shellQuote(cwd)} && ${input.command}`
  }

  private async spawnWorker(): Promise<string> {
    const args = this.launchArgs({ detach: true, predictOnly: false })
    const result = await runProcess('rlaunch', args, {
      timeoutMs: START_TIMEOUT_MS,
      maxBufferBytes: DEFAULT_MAX_BUFFER_BYTES,
      limitMessage: 'rlaunch worker launch terminated',
    })
    if (result.exitCode !== 0) {
      const formatted = formatRlaunchError(`${result.stderr}\n${result.stdout}`, this.cfg)
      this.tracker.markFailed(formatted)
      throw new Error(`rlaunch failed: ${formatted}`)
    }
    const name = parseWorkerName(`${result.stdout}\n${result.stderr}`)
    if (!name) {
      const detail = `cannot parse worker name from rlaunch output:\n${result.stdout}\n${result.stderr}`
      this.tracker.markFailed(detail)
      throw new Error(detail)
    }
    return name
  }

  private async runPredict(): Promise<void> {
    const result = await runProcess('rlaunch', this.launchArgs({
      detach: false,
      predictOnly: true,
    }), {
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxBufferBytes: DEFAULT_MAX_BUFFER_BYTES,
      limitMessage: 'rlaunch predict terminated',
    })
    if (result.exitCode !== 0) {
      const formatted = formatRlaunchError(`${result.stderr}\n${result.stdout}`, this.cfg)
      if (isQuotaLike(`${result.stderr}\n${result.stdout}`)) {
        this.tracker.markQuotaDenied(formatted)
      } else {
        this.tracker.markFailed(formatted)
      }
      throw new Error(`rlaunch predict failed: ${formatted}`)
    }
  }

  private launchArgs(input: { detach: boolean; predictOnly: boolean }): string[] {
    return buildLaunchArgs(this.cfg, input)
  }

  private async processPhase(name: string): Promise<ProcessState> {
    const result = await runProcess('brainctl', [
      '-n',
      this.cfg.namespace,
      'get',
      'process',
      name,
      '--no-headers',
    ], {
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxBufferBytes: DEFAULT_MAX_BUFFER_BYTES,
      limitMessage: 'brainctl process inspect terminated',
    })
    if (result.exitCode !== 0) {
      this.lastKnownState = this.isNotFoundOrForbidden(result) ? 'absent' : 'unknown'
      return this.lastKnownState
    }
    const columns = result.stdout.trim().split(/\s+/)
    const status = columns[4]?.toLowerCase()
    this.lastKnownState = normalizeProcessState(status)
    return this.lastKnownState
  }

  private async stopWorker(name: string): Promise<void> {
    const result = await runProcess('brainctl', [
      '-n',
      this.cfg.namespace,
      'stop',
      `process/${name}`,
    ], {
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxBufferBytes: DEFAULT_MAX_BUFFER_BYTES,
      limitMessage: 'brainctl stop process terminated',
    })
    if (result.exitCode !== 0 && !/current phase is Stopped|not found/i.test(`${result.stderr}\n${result.stdout}`)) {
      throw new Error(`brainctl stop process/${name} failed: ${result.stderr.trim() || result.stdout.trim()}`)
    }
  }

  private isWorkerLostError(result: ExecResult): boolean {
    if (result.exitCode === 0) return false
    const msg = `${result.stderr}\n${result.stdout}`.toLowerCase()
    return (
      msg.includes('not found') ||
      msg.includes('connection refused') ||
      msg.includes('unable to upgrade connection') ||
      msg.includes('unavailable process') ||
      msg.includes('cannot exec into a container')
    )
  }

  private isNotFoundOrForbidden(result: ExecResult): boolean {
    const msg = `${result.stderr}\n${result.stdout}`.toLowerCase()
    return msg.includes('notfound') ||
      msg.includes('not found') ||
      msg.includes('forbidden')
  }

  private toContainerPath(pathname: string): string {
    const normalizedContainerPath = path.posix.normalize(pathname)
    if (normalizedContainerPath === this.workspaceRoot ||
      normalizedContainerPath.startsWith(`${this.workspaceRoot}/`)) {
      return normalizedContainerPath
    }

    const resolved = path.resolve(pathname)
    for (const [hostPrefix, containerPrefix] of this.mountTable) {
      if (resolved === hostPrefix || resolved.startsWith(`${hostPrefix}${path.sep}`)) {
        return path.posix.join(containerPrefix, resolved.slice(hostPrefix.length))
      }
    }

    throw new Error(`Path is not within RlaunchRuntime workspace: ${pathname}`)
  }
}

export function buildLaunchArgs(
  cfg: RlaunchRuntimeConfig,
  input: { detach: boolean; predictOnly: boolean },
): string[] {
  const args = [
    '--gpu',
    String(cfg.gpu),
    '--cpu',
    String(cfg.cpu),
    '--memory',
    String(cfg.memoryMb),
    '--namespace',
    cfg.namespace,
    '--charged-group',
    cfg.chargedGroup,
    `--image=${cfg.image}`,
    `--private-machine=${cfg.privateMachine}`,
    `--image-pull-policy=${cfg.imagePullPolicy}`,
    `--max-wait-duration=${cfg.maxWaitDuration}`,
    `--worker-garbage-collection-time=${formatGcDuration(cfg.workerGcTimeHours)}`,
    `--mount=${cfg.workspaceGpfsMount}`,
  ]
  for (const tag of cfg.positiveTags) {
    args.push(`--positive-tags=${tag}`)
  }
  // env injection happens before predictOnly fast-return so predict and
  // detached spawn share identical args (predict surfaces env-related
  // failures fail-fast before the real worker burns scheduling time).
  for (const [key, value] of Object.entries(cfg.env)) {
    args.push('-e', `${key}=${value}`)
  }
  if (input.predictOnly) {
    args.push('--predict-only=true', '--', 'bash')
    return args
  }
  if (input.detach) {
    args.unshift('-d')
  }
  args.push(
    `--comment=lightclaw-runtime-${cfg.canonicalUser}-${cfg.deploymentHash}`,
    '--',
    'bash',
    '-c',
    'sleep infinity',
  )
  return args
}

export function parseWorkerName(output: string): string | null {
  const lines = output
    .split('\n')
    .map(line => line.trim().replace(/\x1b\[[0-9;]*m/g, ''))
    .filter(Boolean)
  for (const line of lines.reverse()) {
    if (/^ws-[a-z0-9-]+-worker-[a-z0-9]+$/.test(line) || /^worker-[a-z0-9-]+$/.test(line)) {
      return line
    }
  }
  return null
}

function normalizeProcessState(status: string | undefined): ProcessState {
  switch (status) {
    case 'running':
      return 'running'
    case 'starting':
    case 'containercreating':
      return 'starting'
    case 'pending':
    case 'queued':
      return 'pending'
    case 'stopped':
      return 'stopped'
    case 'failed':
    case 'error':
      return 'failed'
    default:
      return 'unknown'
  }
}

function isQuotaLike(raw: string): boolean {
  const text = raw.toLowerCase()
  return text.includes('quota') ||
    text.includes('资源不足') ||
    text.includes('无可用机器') ||
    text.includes('no machine is available')
}

function formatGcDuration(hours: number): string {
  if (hours < 1) {
    return `${Math.max(15, Math.round(hours * 60))}m`
  }
  return Number.isInteger(hours) ? `${hours}h` : `${Math.round(hours * 60)}m`
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
