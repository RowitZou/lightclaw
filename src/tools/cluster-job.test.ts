import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { LightClawConfig } from '../config.js'
import type { ExecInput, ExecResult, Runtime } from '../runtime/index.js'
import {
  brainppClusterTool,
  type CapacityOutput,
  type ClusterJobOutput,
  formatClusterJobOutput,
  parseCapacity,
  redactCli,
} from './cluster-job.js'

describe('BrainppCluster capacity', () => {
  it('selects the allocated GPU lane and normalizes memory units', () => {
    const output = parseCapacity(JSON.stringify({
      items: [
        queue('ailab-hs-hs-gpu', {
          'nvidia.com/gpu': '96',
          cpu: '2304',
          memory: '25339934300Ki',
        }, {
          'nvidia.com/gpu': '56',
          cpu: '352',
          memory: '3785Gi',
        }),
        queue('ailab-hs-hs-cpu', {
          'nvidia.com/gpu': '88',
          cpu: '57888',
          memory: '10Ti',
        }, {}),
      ],
    }), 'ailab-hs')

    assert.equal(output.lane?.name, 'ailab-hs-hs-gpu')
    assert.deepEqual(output.lane?.gpu, { cap: 96, alloc: 56, free: 40 })
    assert.deepEqual(output.lane?.cpu, { cap: 2304, alloc: 352, free: 1952 })
    assert.equal(output.lane?.mem.alloc, 3_875_840)
    assert.equal(output.queues.length, 2)
  })
})

describe('BrainppCluster logs', () => {
  it('does not call logs while the job is still starting', async () => {
    const commands: string[] = []
    const result = await brainppClusterTool.call({
      operation: 'logs',
      job: 'demo-123',
      tailLines: 50,
    }, {
      cwd: '/workspace',
      abortSignal: new AbortController().signal,
      runtime: fakeRuntime(async input => {
        commands.push(input.command)
        assert.match(input.command, /rjob get 'demo-123'/)
        return { stdout: 'phase: STARTING\n', stderr: '', exitCode: 0 }
      }),
    })

    const output = result.output as ClusterJobOutput
    assert.equal(commands.length, 1)
    assert.equal(output.operation, 'logs')
    assert.equal(output.status, 'still_starting')
  })
})

describe('BrainppCluster capacity group resolution', () => {
  it('scopes to config clusterSettings.namespace, not ambient env or a silent default', async () => {
    const payload = JSON.stringify({
      items: [
        queue('ailab-test-test-gpu', { 'nvidia.com/gpu': '8', cpu: '64', memory: '100Gi' }, { 'nvidia.com/gpu': '2', cpu: '8', memory: '20Gi' }),
        queue('ailab-other-other-gpu', { 'nvidia.com/gpu': '8', cpu: '64', memory: '100Gi' }, { 'nvidia.com/gpu': '1', cpu: '4', memory: '10Gi' }),
      ],
    })
    const result = await brainppClusterTool.call({ operation: 'capacity' }, {
      cwd: '/workspace',
      abortSignal: new AbortController().signal,
      config: { runtime: { clusterSettings: { namespace: 'ailab-test' } } } as unknown as LightClawConfig,
      runtime: fakeRuntime(async () => ({ stdout: payload, stderr: '', exitCode: 0 })),
    })
    const out = result.output as CapacityOutput
    // Pre-fix this read process.env.KUBEBRAIN_NAMESPACE / 'current', ignoring config.
    assert.equal(out.group, 'ailab-test')
    assert.equal(out.queues.length, 1)
    assert.ok(out.queues.every(q => q.name.startsWith('ailab-test')))
    assert.equal(out.lane?.name, 'ailab-test-test-gpu')
  })
})

describe('BrainppCluster capacity formatting', () => {
  it('leads with the GPU lane and omits phantom GPU ceilings on non-gpu queues', () => {
    const gpuLane = {
      name: 'ailab-hs-hs-gpu',
      gpu: { cap: 96, alloc: 56, free: 40 },
      cpu: { cap: 2304, alloc: 352, free: 1952 },
      mem: { cap: 100, alloc: 10, free: 90, unit: 'MiB' as const },
    }
    const cpuQueue = {
      name: 'ailab-hs-hs-cpu',
      gpu: { cap: 88, alloc: 0, free: 88 },
      cpu: { cap: 57888, alloc: 0, free: 57888 },
      mem: { cap: 200, alloc: 0, free: 200, unit: 'MiB' as const },
    }
    const text = formatClusterJobOutput({
      operation: 'capacity', group: 'ailab-hs', lane: gpuLane, queues: [gpuLane, cpuQueue],
    })
    assert.match(text, /GPU lane: ailab-hs-hs-gpu — 40\/96 GPU free/)
    const cpuLine = text.split('\n').find(line => line.includes('ailab-hs-hs-cpu'))
    assert.ok(cpuLine)
    // Pre-fix the cpu queue's phantom "gpu 88/88 free" ceiling was printed here.
    assert.doesNotMatch(cpuLine!, /gpu/i)
  })
})

describe('BrainppCluster cpu millicores', () => {
  it('parses millicore cpu quantities instead of dropping them to 0', () => {
    const output = parseCapacity(JSON.stringify({
      items: [queue('ailab-hs-hs-gpu', { 'nvidia.com/gpu': '8', cpu: '64', memory: '100Gi' }, { 'nvidia.com/gpu': '1', cpu: '1500m', memory: '10Gi' })],
    }), 'ailab-hs')
    // Pre-fix Number("1500m") === NaN → alloc 0.
    assert.equal(output.lane?.cpu.alloc, 1.5)
    assert.equal(output.lane?.cpu.free, 62.5)
  })
})

describe('BrainppCluster output redaction', () => {
  it('redacts the underlying CLI name from passthrough output', async () => {
    const result = await brainppClusterTool.call({ operation: 'get', job: 'demo-1' }, {
      cwd: '/workspace',
      abortSignal: new AbortController().signal,
      runtime: fakeRuntime(async () => ({ stdout: '', stderr: 'rjob: error: job not found', exitCode: 1 })),
    })
    const out = result.output
    if (out.operation === 'capacity') {
      assert.fail('expected a text output for get')
    }
    assert.doesNotMatch(out.stderr, /rjob/i)
    assert.match(out.stderr, /cluster: error/)
  })
  it('redactCli replaces rjob and brainctl tokens', () => {
    assert.equal(redactCli('rjob get x; brainctl get queues'), 'cluster get x; cluster get queues')
  })
})

function queue(
  name: string,
  capability: Record<string, string>,
  allocated: Record<string, string>,
) {
  return {
    metadata: { name },
    spec: { capability },
    status: { allocated },
  }
}

function fakeRuntime(exec: (input: ExecInput) => Promise<ExecResult>): Runtime {
  return {
    kind: 'local',
    isolated: false,
    workspaceRoot: '/workspace',
    scratchRoot: '/scratch',
    securityProfile: 'host-trusted',
    control: null as never,
    data: null as never,
    paths: null as never,
    fs: null as never,
    start: async () => {},
    stop: async () => {},
    isRunning: () => true,
    isAvailable: async () => ({ ok: true }),
    exec,
  }
}
