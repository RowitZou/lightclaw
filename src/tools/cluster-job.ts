import { z } from 'zod'

import { buildTool, type ToolCallContext } from '../tool.js'

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

const inputSchema = z.discriminatedUnion('operation', [
  capacityInput,
  listInput,
  getInput,
  logsInput,
  eventsInput,
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

type CapacityOutput = {
  operation: 'capacity'
  group: string
  lane: CapacityQueue | null
  queues: CapacityQueue[]
}

type TextOutput = {
  operation: 'list' | 'get' | 'logs' | 'events'
  command: string
  stdout: string
  stderr: string
  exitCode: number
  truncated: boolean
  jobs?: string[]
  phase?: string
  status?: string
  target?: string
}

export type ClusterJobOutput = CapacityOutput | TextOutput

export const brainppClusterTool = buildTool<ClusterJobInput, ClusterJobOutput>({
  name: 'BrainppCluster',
  whenToUse: 'Check cluster capacity, list jobs, inspect job status, read bounded logs, or inspect scheduling events.',
  shouldDefer: true,
  requiresDriver: 'brainpp',
  description: [
    'Inspect batch jobs on the cluster and check cluster GPU / CPU / memory availability.',
    'Read-only operations in this version: capacity, list, get, logs, events.',
    'Capacity is reported for your own group by default.',
  ].join(' '),
  domain: 'environment',
  riskLevel: 'safe',
  inputSchema,
  async call(input, context) {
    switch (input.operation) {
      case 'capacity':
        return { output: await getCapacity(input, context) }
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

async function getCapacity(
  input: Extract<ClusterJobInput, { operation: 'capacity' }>,
  context: ToolCallContext,
): Promise<CapacityOutput> {
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
      return parseCapacity(result.stdout, input.group ?? process.env.KUBEBRAIN_NAMESPACE ?? 'current')
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
  }
  throw new Error(`Unable to read cluster capacity after ${CAPACITY_RETRIES} attempts: ${lastError}`)
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
  const text = truncateText(result.stdout)
  return {
    operation: 'list',
    command: redactInternalCommand(command),
    stdout: text.text,
    stderr: truncateText(result.stderr).text,
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
  const text = truncateText(result.stdout)
  return {
    operation: 'get',
    command: redactInternalCommand(command),
    stdout: text.text,
    stderr: truncateText(result.stderr).text,
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
  const text = truncateText(result.stdout)
  return {
    operation: 'logs',
    command: redactInternalCommand(command),
    stdout: text.text,
    stderr: truncateText(result.stderr).text,
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
  const text = truncateText(result.stdout)
  return {
    operation: 'events',
    command: redactInternalCommand(command),
    stdout: text.text,
    stderr: truncateText(result.stderr).text,
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

function resource(cap: unknown, alloc: unknown): ResourceAmount {
  const capValue = Number(String(cap ?? '0'))
  const allocValue = Number(String(alloc ?? '0'))
  const safeCap = Number.isFinite(capValue) ? capValue : 0
  const safeAlloc = Number.isFinite(allocValue) ? allocValue : 0
  return {
    cap: safeCap,
    alloc: safeAlloc,
    free: Math.max(0, safeCap - safeAlloc),
  }
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

function formatCommandFailure(result: { stdout: string; stderr: string; exitCode: number }): string {
  return `exit ${result.exitCode}; stdout=${result.stdout.slice(0, 200)}; stderr=${result.stderr.slice(0, 200)}`
}

function redactInternalCommand(command: string): string {
  if (command.startsWith('rjob ')) {
    return `cluster ${command.slice('rjob '.length)}`
  }
  return 'cluster command'
}

function formatClusterJobOutput(output: ClusterJobOutput): string {
  if (output.operation === 'capacity') {
    const lines = [
      `Cluster capacity for group: ${output.group}`,
      output.lane
        ? `Selected lane: ${output.lane.name}`
        : 'Selected lane: none',
      '',
      'Queues:',
    ]
    for (const queue of output.queues) {
      lines.push(
        `- ${queue.name}: gpu ${queue.gpu.free}/${queue.gpu.cap} free, ` +
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
