import { z } from 'zod'

import { getConfig } from '../config.js'
import { getPermissionApprover, getPermissionMode } from '../state.js'
import { buildGpfsMountStringFromRules } from '../runtime/gpfs-mount-rules.js'
import { buildTool, type Tool, type ToolCallContext } from '../tool.js'

const COMMAND_PREFIX = 'source /etc/profile.d/ssh-init.sh >/dev/null 2>&1 || true; '
const MAX_TEXT_CHARS = 30_000
const CAPACITY_RETRIES = 5
const MIN_QUEUE_JSON_BYTES = 200

const capacityInput = z.object({
  operation: z.literal('capacity'),
  group: z.string().min(1).optional().describe(
    'Cluster group to inspect. Omit for the current user group; set only when the user explicitly asks about another group.',
  ),
})

const listInput = z.object({
  operation: z.literal('list'),
  name: z.string().min(1).optional().describe('Optional human job name filter.'),
  jobs: z.array(z.string().min(1)).optional().describe('Optional exact job ids to list.'),
})

const getInput = z.object({
  operation: z.literal('get'),
  job: z.string().min(1),
})

const logsInput = z.object({
  operation: z.literal('logs'),
  job: z.string().min(1),
  tailLines: z.number().int().min(1).max(1000).optional().describe('Bounded tail line count. Default 200.'),
})

const eventsInput = z.object({
  operation: z.literal('events'),
  job: z.string().min(1),
  replica: z.boolean().optional().describe('Set when the target is a replica name rather than a job name.'),
})

const submitInput = z.object({
  operation: z.literal('submit'),
  name: z.string().min(1).describe('Human-readable job name.'),
  image: z.string().min(1).describe('Container image to run.'),
  command: z.string().min(1).describe('Command to run inside the job. Multi-step commands are wrapped with bash -lc.'),
  taskType: z.enum(['normal', 'idle']).optional().describe('Task lane. Defaults to normal.'),
  gpu: z.number().int().min(0).optional(),
  cpu: z.number().int().min(1).optional(),
  memoryMB: z.number().int().min(1).optional().describe('Memory in MiB.'),
  replicas: z.number().int().min(1).optional(),
  gangStart: z.boolean().optional(),
  hostNetwork: z.boolean().optional(),
  customResources: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  env: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  shareHostShm: z.boolean().optional().describe('Defaults to true.'),
  autoRestart: z.string().min(1).optional().describe('Go duration such as 24h or 720h.'),
  enableSelfHealth: z.boolean().optional(),
  priority: z.number().int().optional(),
  predictOnly: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  privateMachine: z.boolean().optional().describe('Normal lane defaults to group-private scheduling. Set false only when explicitly requested.'),
  extraArgs: z.array(z.string().min(1)).optional().describe('Last-resort pass-through for flags not yet modeled by this tool.'),
})

const stopInput = z.object({
  operation: z.literal('stop'),
  job: z.string().min(1),
})

const deleteInput = z.object({
  operation: z.literal('delete'),
  job: z.string().min(1),
})

const inputSchema = z.discriminatedUnion('operation', [
  capacityInput,
  submitInput,
  listInput,
  getInput,
  logsInput,
  eventsInput,
  stopInput,
  deleteInput,
])

type ClusterJobInput = z.infer<typeof inputSchema>

type ResourceAmount = {
  cap: number
  alloc: number
  free: number
}

type MemoryAmount = ResourceAmount & {
  unit: 'MiB'
}

type CapacityQueue = {
  name: string
  gpu: ResourceAmount
  cpu: ResourceAmount
  mem: MemoryAmount
}

export type CapacityOutput = {
  operation: 'capacity'
  group: string
  lane: CapacityQueue | null
  queues: CapacityQueue[]
}

type TextOutput = {
  operation: 'submit' | 'list' | 'get' | 'logs' | 'events' | 'stop' | 'delete'
  command: string
  stdout: string
  stderr: string
  exitCode: number
  truncated: boolean
  jobs?: string[]
  phase?: string
  status?: string
  target?: string
  name?: string
  image?: string
  namespace?: string
  group?: string
  taskLane?: 'normal' | 'idle'
  mounts?: { autoWorkspace: string }
  resources?: {
    gpu?: number
    cpu?: number
    memoryMB?: number
    replicas?: number
    custom?: Record<string, string | number>
  }
}

export type ClusterJobOutput = CapacityOutput | TextOutput

export const brainppClusterTool = buildTool<ClusterJobInput, ClusterJobOutput>({
  name: 'BrainppCluster',
  whenToUse: 'Check cluster capacity, list jobs, inspect job status, read bounded logs, or inspect scheduling events.',
  shouldDefer: true,
  requiresDriver: 'brainpp',
  description: [
    'Submit and manage batch jobs on the cluster, and check cluster GPU / CPU / memory',
    'availability — operations: capacity, submit, list, get, logs, events, stop, delete.',
    'Your sandbox /workspace is automatically mounted into every job at the same /workspace',
    'path, so anything you prepare there (code, a conda env, data) is available to the job',
    'without re-uploading. Capacity is reported for your own group by default.',
  ].join(' '),
  domain: 'environment',
  riskLevel: 'safe',
  inputSchema,
  suggestPermissionRules(input) {
    if (input.operation === 'delete') {
      return [{ toolName: 'BrainppClusterDeleteConfirm' }]
    }
    return [{ toolName: 'BrainppCluster', ruleContent: `operation:${input.operation}` }]
  },
  async call(input, context) {
    switch (input.operation) {
      case 'capacity':
        return { output: await getCapacity(input, context) }
      case 'submit': {
        const output = await runSubmit(input, context)
        return { output, isError: output.exitCode !== 0 }
      }
      case 'list': {
        const output = await runList(input, context)
        return { output, isError: output.exitCode !== 0 }
      }
      case 'get': {
        const output = await runGet(input, context)
        return { output, isError: output.exitCode !== 0 }
      }
      case 'logs': {
        const output = await runLogs(input, context)
        return { output, isError: output.exitCode !== 0 }
      }
      case 'events': {
        const output = await runEvents(input, context)
        return { output, isError: output.exitCode !== 0 }
      }
      case 'stop': {
        const output = await runStop(input, context)
        return { output, isError: output.exitCode !== 0 }
      }
      case 'delete': {
        const permission = await requireDeleteConfirmation(input, context)
        if (permission) {
          return {
            output: {
              operation: 'delete',
              command: 'cluster delete',
              stdout: '',
              stderr: permission,
              exitCode: 1,
              truncated: false,
              target: input.job,
            },
            isError: true,
          }
        }
        const output = await runDelete(input, context)
        return { output, isError: output.exitCode !== 0 }
      }
    }
  },
  formatResult(output, toolUseId, isError) {
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: formatClusterJobOutput(output),
      ...(isError ? { is_error: true } : {}),
    }
  },
})

const brainppClusterDeleteConfirmTool: Tool = {
  name: 'BrainppClusterDeleteConfirm',
  description: 'Confirm deleting a cluster job. This virtual confirmation is one-shot and must not be persisted.',
  source: 'builtin',
  domain: 'environment',
  riskLevel: 'write',
  inputSchema: deleteInput,
  async call() {
    throw new Error('BrainppClusterDeleteConfirm is a virtual permission tool.')
  },
  formatResult() {
    throw new Error('BrainppClusterDeleteConfirm is a virtual permission tool.')
  },
}

async function getCapacity(
  input: Extract<ClusterJobInput, { operation: 'capacity' }>,
  context: ToolCallContext,
): Promise<CapacityOutput> {
  const group = resolveCapacityGroup(input.group, context)
  let lastError = ''
  for (let attempt = 1; attempt <= CAPACITY_RETRIES; attempt += 1) {
    const result = await execClusterCommand('brainctl get queues -o json', context, {
      timeoutMs: 60_000,
      maxBufferBytes: 4 * 1024 * 1024,
    })
    if (result.exitCode !== 0) {
      lastError = formatCommandFailure(result)
      continue
    }
    if (Buffer.byteLength(result.stdout, 'utf8') < MIN_QUEUE_JSON_BYTES) {
      lastError = `queue JSON was too short on attempt ${attempt}`
      continue
    }
    try {
      return parseCapacity(result.stdout, group)
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
  }
  throw new Error(`Unable to read cluster capacity after ${CAPACITY_RETRIES} attempts: ${lastError}`)
}

/**
 * Resolve which group's queues to report. The cluster namespace is a
 * deployment-declared value (`runtime.clusterSettings.namespace`), NOT the
 * daemon's ambient `process.env` — the daemon and the worker that runs the
 * query can have different environments, and a silent fallback that matches no
 * queue would return an empty (wrong) capacity. Resolution order: explicit
 * argument → config namespace → ambient env (valid only for the local backend,
 * where the daemon shell is the same shell the command runs in) → fail loud.
 */
function resolveCapacityGroup(explicit: string | undefined, context: ToolCallContext): string {
  if (explicit) {
    return explicit
  }
  const config = context.config ?? getConfig()
  const fromConfig = config.runtime.clusterSettings?.namespace?.trim()
  if (fromConfig) {
    return fromConfig
  }
  const fromEnv = process.env.KUBEBRAIN_NAMESPACE?.trim()
  if (fromEnv) {
    return fromEnv
  }
  throw new Error(
    'Cannot determine your cluster group: no group argument, runtime.clusterSettings.namespace, ' +
    'or KUBEBRAIN_NAMESPACE is set. Pass the group explicitly.',
  )
}

async function runSubmit(
  input: Extract<ClusterJobInput, { operation: 'submit' }>,
  context: ToolCallContext,
): Promise<TextOutput> {
  const autoWorkspaceMount = buildAutoWorkspaceMount(context)
  const command = buildSubmitCommand(input, autoWorkspaceMount)
  const result = await execClusterCommand(command, context, {
    timeoutMs: 60_000,
    maxBufferBytes: 2 * 1024 * 1024,
  })
  const text = presentText(result.stdout)
  const clusterSettings = (context.config ?? getConfig()).runtime.clusterSettings
  return {
    operation: 'submit',
    // Redact the resolved gpfs workspace path: the agent never sees /workspace's
    // real host/gpfs location (that is the whole point of auto-mount), and seeing
    // it would let it construct sibling paths for an out-of-bounds mount.
    command: redactInternalCommand(command.replaceAll(autoWorkspaceMount, '<your /workspace, auto-mounted>')),
    stdout: text.text,
    stderr: presentText(result.stderr).text,
    exitCode: result.exitCode,
    truncated: text.truncated,
    name: input.name,
    image: input.image,
    namespace: clusterSettings?.namespace,
    group: clusterSettings?.chargedGroup,
    taskLane: input.taskType ?? 'normal',
    mounts: { autoWorkspace: autoWorkspaceMount },
    resources: {
      ...(input.gpu !== undefined ? { gpu: input.gpu } : {}),
      ...(input.cpu !== undefined ? { cpu: input.cpu } : {}),
      ...(input.memoryMB !== undefined ? { memoryMB: input.memoryMB } : {}),
      ...(input.replicas !== undefined ? { replicas: input.replicas } : {}),
      ...(input.customResources ? { custom: input.customResources } : {}),
    },
  }
}

async function runList(
  input: Extract<ClusterJobInput, { operation: 'list' }>,
  context: ToolCallContext,
): Promise<TextOutput> {
  const parts = ['rjob list']
  for (const job of input.jobs ?? []) {
    parts.push(shellQuote(job))
  }
  if (input.name) {
    parts.push('--name', shellQuote(input.name))
  }
  const command = parts.join(' ')
  const result = await execClusterCommand(command, context)
  const text = presentText(result.stdout)
  return {
    operation: 'list',
    command: redactInternalCommand(command),
    stdout: text.text,
    stderr: presentText(result.stderr).text,
    exitCode: result.exitCode,
    truncated: text.truncated,
    jobs: parseListJobs(result.stdout),
  }
}

async function runGet(
  input: Extract<ClusterJobInput, { operation: 'get' }>,
  context: ToolCallContext,
): Promise<TextOutput> {
  const command = `rjob get ${shellQuote(input.job)}`
  const result = await execClusterCommand(command, context)
  const text = presentText(result.stdout)
  return {
    operation: 'get',
    command: redactInternalCommand(command),
    stdout: text.text,
    stderr: presentText(result.stderr).text,
    exitCode: result.exitCode,
    truncated: text.truncated,
    phase: parseJobPhase(result.stdout),
    target: input.job,
  }
}

async function runLogs(
  input: Extract<ClusterJobInput, { operation: 'logs' }>,
  context: ToolCallContext,
): Promise<TextOutput> {
  const get = await execClusterCommand(`rjob get ${shellQuote(input.job)}`, context)
  const phase = parseJobPhase(get.stdout)
  if (phase && isStartingPhase(phase)) {
    return {
      operation: 'logs',
      command: 'cluster logs',
      stdout: '',
      stderr: '',
      exitCode: 0,
      truncated: false,
      phase,
      status: 'still_starting',
      target: input.job,
    }
  }

  const tailLines = input.tailLines ?? 200
  const command = `rjob logs job ${shellQuote(input.job)} -n ${tailLines}`
  const result = await execClusterCommand(command, context, {
    maxBufferBytes: 2 * 1024 * 1024,
  })
  const text = presentText(result.stdout)
  return {
    operation: 'logs',
    command: redactInternalCommand(command),
    stdout: text.text,
    stderr: presentText(result.stderr).text,
    exitCode: result.exitCode,
    truncated: text.truncated,
    phase,
    target: input.job,
  }
}

async function runEvents(
  input: Extract<ClusterJobInput, { operation: 'events' }>,
  context: ToolCallContext,
): Promise<TextOutput> {
  const command = [
    'rjob events',
    shellQuote(input.job),
    input.replica ? '--replica' : '',
  ].filter(Boolean).join(' ')
  const result = await execClusterCommand(command, context)
  const text = presentText(result.stdout)
  return {
    operation: 'events',
    command: redactInternalCommand(command),
    stdout: text.text,
    stderr: presentText(result.stderr).text,
    exitCode: result.exitCode,
    truncated: text.truncated,
    target: input.job,
  }
}

async function runStop(
  input: Extract<ClusterJobInput, { operation: 'stop' }>,
  context: ToolCallContext,
): Promise<TextOutput> {
  const command = `rjob stop ${shellQuote(input.job)}`
  const result = await execClusterCommand(command, context)
  const text = presentText(result.stdout)
  return {
    operation: 'stop',
    command: redactInternalCommand(command),
    stdout: text.text,
    stderr: presentText(result.stderr).text,
    exitCode: result.exitCode,
    truncated: text.truncated,
    target: input.job,
  }
}

async function runDelete(
  input: Extract<ClusterJobInput, { operation: 'delete' }>,
  context: ToolCallContext,
): Promise<TextOutput> {
  const command = `rjob delete ${shellQuote(input.job)}`
  const result = await execClusterCommand(command, context)
  const text = presentText(result.stdout)
  return {
    operation: 'delete',
    command: redactInternalCommand(command),
    stdout: text.text,
    stderr: presentText(result.stderr).text,
    exitCode: result.exitCode,
    truncated: text.truncated,
    target: input.job,
  }
}

async function execClusterCommand(
  command: string,
  context: ToolCallContext,
  options: { timeoutMs?: number; maxBufferBytes?: number } = {},
) {
  return await context.runtime.exec({
    command: `${COMMAND_PREFIX}${command}`,
    cwd: context.runtime.workspaceRoot,
    timeoutMs: options.timeoutMs ?? 30_000,
    maxBufferBytes: options.maxBufferBytes ?? 1024 * 1024,
    abortSignal: context.abortSignal,
  })
}

function buildSubmitCommand(
  input: Extract<ClusterJobInput, { operation: 'submit' }>,
  autoWorkspaceMount: string,
): string {
  const lane = input.taskType ?? 'normal'
  const parts = ['rjob submit']
  pushFlagValue(parts, '--name', input.name)
  pushFlagValue(parts, '--image', input.image)
  if (lane === 'idle') {
    pushFlagValue(parts, '--task-type', 'idle')
  }
  if (lane === 'normal' && input.privateMachine !== false) {
    parts.push('--private-machine=group')
  }
  pushFlagValue(parts, '--cpu', input.cpu)
  pushFlagValue(parts, '--memory', input.memoryMB)
  pushFlagValue(parts, '--gpu', input.gpu)
  if (input.replicas !== undefined) {
    pushFlagValue(parts, '-P', input.replicas)
  }
  if (input.gangStart) {
    parts.push('--gang-start')
  }
  if (input.hostNetwork) {
    parts.push('--host-network')
  }
  for (const [name, value] of Object.entries(input.customResources ?? {})) {
    pushFlagValue(parts, '--custom-resources', `${name}=${value}`)
  }
  for (const [name, value] of Object.entries(input.env ?? {})) {
    pushFlagValue(parts, '-e', `${name}=${value}`)
  }
  if (input.shareHostShm !== false) {
    parts.push('--share-host-shm', 'True')
  }
  pushFlagValue(parts, '--auto-restart', input.autoRestart)
  if (input.enableSelfHealth) {
    parts.push('--enable-self-health', 'true')
  }
  if (lane === 'normal') {
    pushFlagValue(parts, '--priority', input.priority)
  }
  if (input.predictOnly) {
    parts.push('--predict-only', 'true')
  }
  if (input.dryRun) {
    parts.push('--dry-run', 'true')
  }
  parts.push(`--mount=${shellQuote(autoWorkspaceMount)}`)
  assertSafeExtraArgs(input.extraArgs ?? [])
  for (const arg of input.extraArgs ?? []) {
    parts.push(shellQuote(arg))
  }
  parts.push('--', 'bash', '-lc', shellQuote(input.command))
  return parts.join(' ')
}

/**
 * extraArgs is a pass-through for flags the tool does not model — NOT a way to
 * override the flags the tool owns for safety. Mounts (auto `/workspace` only),
 * namespace, and charged group are tool-controlled; letting extraArgs carry
 * `--mount=gpfs://<any path>` would re-open the arbitrary-gpfs-mount boundary
 * that auto-mount closes (e.g. mounting another group's data or the secrets
 * tree into a job). Reject those flags up front.
 */
const BLOCKED_EXTRA_ARG_FLAGS = new Set([
  '--mount',
  '--namespace',
  '--charged-group',
  '--group',
])

function assertSafeExtraArgs(extraArgs: readonly string[]): void {
  for (const arg of extraArgs) {
    const flag = arg.split('=', 1)[0].trim()
    if (BLOCKED_EXTRA_ARG_FLAGS.has(flag)) {
      throw new Error(
        `extraArgs may not set ${flag}. Mounts, namespace, and charged group are controlled by the tool; ` +
        `/workspace is auto-mounted and other paths are out of scope.`,
      )
    }
  }
}

function pushFlagValue(
  parts: string[],
  flag: string,
  value: string | number | undefined,
): void {
  if (value === undefined) {
    return
  }
  parts.push(flag, typeof value === 'number' ? String(value) : shellQuote(value))
}

function buildAutoWorkspaceMount(context: ToolCallContext): string {
  const clusterSettings = (context.config ?? getConfig()).runtime.clusterSettings
  if (!clusterSettings) {
    throw new Error('runtime.clusterSettings.gpfsMounts is required for BrainppCluster submit auto-mount.')
  }
  const workspaceHostPath =
    context.runtime.paths.toHostPath('/workspace') ??
    context.runtime.paths.toHostPath(context.runtime.workspaceRoot)
  if (!workspaceHostPath) {
    throw new Error('Unable to resolve runtime /workspace to a host path for BrainppCluster submit auto-mount.')
  }
  return buildGpfsMountStringFromRules(workspaceHostPath, '/workspace', clusterSettings)
}

async function requireDeleteConfirmation(
  input: Extract<ClusterJobInput, { operation: 'delete' }>,
  context: ToolCallContext,
): Promise<string | null> {
  const askBody = { operation: input.operation, job: input.job }
  const approver = safePermissionApprover()
  if (approver) {
    const decision = await approver.ask({
      toolName: 'BrainppClusterDeleteConfirm',
      riskLevel: 'write',
      input: askBody,
      inputPreview: JSON.stringify(askBody, null, 2),
      mode: safePermissionMode(),
      signal: context.abortSignal,
      suggestedRules: [{ toolName: 'BrainppClusterDeleteConfirm' }],
    })
    return decision.behavior === 'allow'
      ? null
      : `BrainppCluster delete denied: ${decision.reason}`
  }

  if (context.canUseTool) {
    const decision = await context.canUseTool(brainppClusterDeleteConfirmTool, askBody)
    return decision.behavior === 'allow'
      ? null
      : `BrainppCluster delete denied: ${decision.reason}`
  }

  return 'BrainppCluster delete confirmation is unavailable in this session.'
}

function safePermissionApprover() {
  try {
    return getPermissionApprover()
  } catch {
    return undefined
  }
}

function safePermissionMode() {
  try {
    return getPermissionMode()
  } catch {
    return 'default'
  }
}

export function parseCapacity(stdout: string, group: string): CapacityOutput {
  const payload = JSON.parse(stdout) as {
    items?: Array<{
      metadata?: { name?: unknown }
      spec?: { capability?: Record<string, unknown> }
      status?: { allocated?: Record<string, unknown> }
    }>
  }
  const queues = (payload.items ?? [])
    .map(item => {
      const name = String(item.metadata?.name ?? '')
      if (!name.startsWith(group)) {
        return null
      }
      const cap = item.spec?.capability ?? {}
      const alloc = item.status?.allocated ?? {}
      return {
        name,
        gpu: resource(cap['nvidia.com/gpu'], alloc['nvidia.com/gpu']),
        cpu: resource(cap.cpu, alloc.cpu),
        mem: memoryResource(cap.memory, alloc.memory),
      }
    })
    .filter((item): item is CapacityQueue => item !== null)

  return {
    operation: 'capacity',
    group,
    lane: pickCapacityLane(queues),
    queues,
  }
}

function pickCapacityLane(queues: CapacityQueue[]): CapacityQueue | null {
  const allocatedGpuLane = queues.find(queue => queue.gpu.alloc > 0)
  if (allocatedGpuLane) {
    return allocatedGpuLane
  }
  const namedGpuLane = queues.find(queue => /gpu/i.test(queue.name) && queue.gpu.cap > 0)
  if (namedGpuLane) {
    return namedGpuLane
  }
  return queues.find(queue => queue.cpu.alloc > 0 || queue.mem.alloc > 0) ?? queues[0] ?? null
}

/**
 * Whether a queue actually schedules GPUs. CPU / aggregate queues carry a GPU
 * `cap` ceiling with zero alloc (a "phantom" ceiling); presenting their
 * `cap - alloc` as free GPUs invites the model to sum them and over-report. A
 * real GPU lane has GPUs allocated, or is named for GPUs with GPU capacity.
 */
function isGpuLaneQueue(queue: CapacityQueue): boolean {
  return queue.gpu.alloc > 0 || (/gpu/i.test(queue.name) && queue.gpu.cap > 0)
}

function resource(cap: unknown, alloc: unknown): ResourceAmount {
  const safeCap = parseCountQuantity(cap)
  const safeAlloc = parseCountQuantity(alloc)
  return {
    cap: safeCap,
    alloc: safeAlloc,
    free: Math.max(0, safeCap - safeAlloc),
  }
}

/**
 * Parse a k8s count quantity (gpu / cpu). Bare integers are whole units
 * (`"96"` gpu, `"2304"` cpu cores); a trailing `m` is millicores
 * (`"500m"` → 0.5 cores). Without this, `Number("500m")` is NaN and a
 * millicore-expressed cpu queue would silently read as 0.
 */
function parseCountQuantity(value: unknown): number {
  const raw = String(value ?? '0').trim()
  const milli = raw.match(/^([0-9]+(?:\.[0-9]+)?)m$/)
  if (milli) {
    const n = Number(milli[1])
    return Number.isFinite(n) ? n / 1000 : 0
  }
  const n = Number(raw)
  return Number.isFinite(n) ? n : 0
}

function memoryResource(cap: unknown, alloc: unknown): MemoryAmount {
  const capMiB = parseMemoryMiB(cap)
  const allocMiB = parseMemoryMiB(alloc)
  return {
    cap: capMiB,
    alloc: allocMiB,
    free: Math.max(0, capMiB - allocMiB),
    unit: 'MiB',
  }
}

function parseMemoryMiB(value: unknown): number {
  const raw = String(value ?? '0').trim()
  const match = raw.match(/^([0-9]+(?:\.[0-9]+)?)([KMGT]i?|[kmgt]i?)?$/)
  if (!match) {
    return 0
  }
  const amount = Number(match[1])
  if (!Number.isFinite(amount)) {
    return 0
  }
  const unit = (match[2] ?? '').toLowerCase()
  switch (unit) {
    case 'ki':
    case 'k':
      return Math.round(amount / 1024)
    case 'mi':
    case 'm':
      return Math.round(amount)
    case 'gi':
    case 'g':
      return Math.round(amount * 1024)
    case 'ti':
    case 't':
      return Math.round(amount * 1024 * 1024)
    default:
      return Math.round(amount / (1024 * 1024))
  }
}

function parseListJobs(stdout: string): string[] {
  const jobs: string[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || /^[-+\s|]+$/.test(trimmed) || /^NAME\s+/i.test(trimmed)) {
      continue
    }
    const first = trimmed.split(/\s+/)[0]
    if (first && !jobs.includes(first)) {
      jobs.push(first)
    }
  }
  return jobs
}

function parseJobPhase(stdout: string): string | undefined {
  const phaseLine = stdout.match(/\b(?:phase|status)\s*[:=]\s*([A-Za-z_ -]+)/i)?.[1]
  if (phaseLine) {
    return normalizePhase(phaseLine)
  }
  const known = stdout.match(/\b(RUNNING|STARTING|PENDING|SCHEDULING|CREATING|SUCCEEDED|SUCCESS|FAILED|STOPPED|DELETED)\b/i)?.[1]
  return known ? normalizePhase(known) : undefined
}

function normalizePhase(value: string): string {
  return value.trim().split(/\s+/)[0].toUpperCase()
}

function isStartingPhase(phase: string): boolean {
  return ['STARTING', 'PENDING', 'SCHEDULING', 'CREATING'].includes(phase.toUpperCase())
}

function truncateText(value: string): { text: string; truncated: boolean } {
  if (value.length <= MAX_TEXT_CHARS) {
    return { text: value, truncated: false }
  }
  return {
    text: `${value.slice(0, MAX_TEXT_CHARS)}\n\n[output truncated]`,
    truncated: true,
  }
}

/**
 * Redact the underlying CLI names from any text shown to the model. The tool is
 * the only sanctioned cluster interface; agents are not told `rjob` / `brainctl`
 * exist, but a command's own error output (`rjob: error: ...`) would otherwise
 * leak them. Redact then truncate, so the truncation boundary lands on cleaned
 * text. The raw result is still used for parsing (phase / jobs / queue JSON)
 * before this runs.
 */
export function redactCli(value: string): string {
  return value.replace(/\brjob\b/gi, 'cluster').replace(/\bbrainctl\b/gi, 'cluster')
}

function presentText(value: string): { text: string; truncated: boolean } {
  return truncateText(redactCli(value))
}

function formatCommandFailure(result: { stdout: string; stderr: string; exitCode: number }): string {
  return `exit ${result.exitCode}; stdout=${result.stdout.slice(0, 200)}; stderr=${result.stderr.slice(0, 200)}`
}

function redactInternalCommand(command: string): string {
  if (command.startsWith('rjob ')) {
    return `cluster ${command.slice('rjob '.length)}`
  }
  return 'cluster command'
}

export function formatClusterJobOutput(output: ClusterJobOutput): string {
  if (output.operation === 'capacity') {
    const lines = [`Cluster capacity for group: ${output.group}`]
    if (output.lane) {
      lines.push(
        `GPU lane: ${output.lane.name} — ${output.lane.gpu.free}/${output.lane.gpu.cap} GPU free, ` +
        `${output.lane.cpu.free}/${output.lane.cpu.cap} CPU free, ` +
        `${output.lane.mem.free}/${output.lane.mem.cap} MiB free`,
      )
    } else {
      lines.push('GPU lane: none found for this group')
    }
    lines.push(
      '',
      'Queues (GPU shown only for actual GPU lanes; CPU/aggregate queues carry a GPU ceiling they cannot schedule, so it is omitted):',
    )
    for (const queue of output.queues) {
      const gpuPart = isGpuLaneQueue(queue) ? `gpu ${queue.gpu.free}/${queue.gpu.cap} free, ` : ''
      lines.push(
        `- ${queue.name}: ${gpuPart}` +
        `cpu ${queue.cpu.free}/${queue.cpu.cap} free, ` +
        `mem ${queue.mem.free}/${queue.mem.cap} MiB free`,
      )
    }
    return lines.join('\n')
  }

  const lines = [
    `Operation: ${output.operation}`,
    `Command: ${output.command}`,
    `Exit code: ${output.exitCode}`,
  ]
  if (output.name) lines.push(`Name: ${output.name}`)
  if (output.image) lines.push(`Image: ${output.image}`)
  if (output.namespace) lines.push(`Namespace: ${output.namespace}`)
  if (output.group) lines.push(`Group: ${output.group}`)
  if (output.taskLane) lines.push(`Task lane: ${output.taskLane}`)
  if (output.mounts?.autoWorkspace) {
    lines.push('Auto workspace mount: your /workspace is mounted into the job at /workspace')
  }
  if (output.resources) {
    const resources = [
      output.resources.gpu !== undefined ? `gpu=${output.resources.gpu}` : '',
      output.resources.cpu !== undefined ? `cpu=${output.resources.cpu}` : '',
      output.resources.memoryMB !== undefined ? `memoryMB=${output.resources.memoryMB}` : '',
      output.resources.replicas !== undefined ? `replicas=${output.resources.replicas}` : '',
    ].filter(Boolean)
    if (output.resources.custom) {
      for (const [name, value] of Object.entries(output.resources.custom)) {
        resources.push(`${name}=${value}`)
      }
    }
    if (resources.length > 0) {
      lines.push(`Resources: ${resources.join(', ')}`)
    }
  }
  if (output.operation === 'submit') {
    lines.push('Config-library hint: after a successful job, record the image, resources, mounts, and command recipe for reuse.')
  }
  if (output.target) lines.push(`Target: ${output.target}`)
  if (output.phase) lines.push(`Phase: ${output.phase}`)
  if (output.status === 'still_starting') {
    lines.push('Status: still starting; logs are not available yet. Try get/events first or retry logs after the job is running.')
  }
  if (output.jobs && output.jobs.length > 0) {
    lines.push(`Jobs: ${output.jobs.join(', ')}`)
  }
  if (output.stdout.trim()) {
    lines.push('', 'stdout:', output.stdout.trimEnd())
  }
  if (output.stderr.trim()) {
    lines.push('', 'stderr:', output.stderr.trimEnd())
  }
  if (output.truncated) {
    lines.push('', '[output truncated]')
  }
  return lines.join('\n')
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}
