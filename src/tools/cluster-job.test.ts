import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { ExecInput, ExecResult, Runtime } from '../runtime/index.js'
import { brainppClusterTool, type ClusterJobOutput, parseCapacity } from './cluster-job.js'

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
