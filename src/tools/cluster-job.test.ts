import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { LightClawConfig } from '../config.js'
import type { ExecInput, ExecResult, Runtime } from '../runtime/index.js'
import { matchToolContent } from '../permission/matchers.js'
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

describe('BrainppCluster submit', () => {
  it('builds a submit command with first-line flags, inferred distributed flags, and mounts', async () => {
    const commands: string[] = []
    const result = await brainppClusterTool.call({
      operation: 'submit',
      name: 'demo-train',
      image: 'registry.example.com/demo:latest',
      command: 'echo hi && python train.py',
      namespace: 'ailab-exp',
      chargedGroup: 'hs_gpu',
      mounts: ['/mnt/shared-storage-user/ailab-hs/user/datasets'],
      gpu: 1,
      cpu: 8,
      memoryMB: 32768,
      replicas: 2,
      env: { WANDB_MODE: 'offline' },
      predictOnly: true,
      dryRun: true,
      priority: 3,
      extraArgs: ['--restart-policy=restartjobonfailure'],
    } as any, {
      cwd: '/workspace',
      abortSignal: new AbortController().signal,
      runtime: fakeRuntime(async input => {
        commands.push(input.command)
        return { stdout: 'job/demo-train created\n', stderr: '', exitCode: 0 }
      }, '/mnt/shared-storage-user/ailab-hs/user/lightclaw'),
      config: fakeConfig(),
    })

    assert.equal(commands.length, 1)
    const command = commands[0]
    assert.match(command, /rjob submit/)
    assert.match(command, /--name 'demo-train'/)
    assert.match(command, /--image 'registry\.example\.com\/demo:latest'/)
    assert.match(command, /--namespace 'ailab-exp'/)
    assert.match(command, /--charged-group 'hs_gpu'/)
    assert.match(command, /--gpu 1/)
    assert.match(command, /--cpu 8/)
    assert.match(command, /--memory 32768/)
    assert.match(command, /-P 2/)
    assert.match(command, /--gang-start(?:\s|$)/)
    assert.doesNotMatch(command, /--gang-start true/)
    assert.match(command, /--host-network(?:\s|$)/)
    assert.match(command, /--share-host-shm True/)
    assert.match(command, /--private-machine=group/)
    assert.match(command, /--custom-resources 'rdma\/mlnx_shared=8'/)
    assert.match(command, /--custom-resources 'mellanox\.com\/mlnx_rdma=1'/)
    assert.match(command, /-e 'WANDB_MODE=offline'/)
    assert.match(command, /--priority 3/)
    assert.match(command, /--predict-only true/)
    assert.match(command, /--dry-run true/)
    assert.match(command, /--mount='gpfs:\/\/gpfs1\/ailab-hs\/user\/lightclaw:\/workspace'/)
    assert.match(command, /--mount='gpfs:\/\/gpfs1\/ailab-hs\/user\/datasets:\/mnt\/shared-storage-user\/ailab-hs\/user\/datasets'/)
    assert.match(command, /--restart-policy=restartjobonfailure/)
    assert.match(command, /-- bash -lc 'echo hi && python train\.py'/)

    const output = result.output as any
    assert.equal(output.operation, 'submit')
    assert.equal(output.name, 'demo-train')
    assert.equal(output.image, 'registry.example.com/demo:latest')
    assert.equal(output.namespace, 'ailab-exp')
    assert.equal(output.group, 'hs_gpu')
    assert.equal(output.mounts.autoWorkspace, true)
    assert.deepEqual(output.mounts.extra, ['/mnt/shared-storage-user/ailab-hs/user/datasets'])
    assert.equal(output.resources.gpu, 1)
    assert.equal(output.resources.priority, 3)
    assert.deepEqual(output.resources.custom, {
      'rdma/mlnx_shared': 8,
      'mellanox.com/mlnx_rdma': 1,
    })
    assert.equal(output.taskLane, 'normal')
  })

  it('does not infer distributed flags for single-replica jobs and defaults normal priority to 1', async () => {
    const commands: string[] = []
    const result = await brainppClusterTool.call({
      operation: 'submit',
      name: 'demo-single',
      image: 'image:tag',
      command: 'echo hi',
      replicas: 1,
    } as any, {
      cwd: '/workspace',
      abortSignal: new AbortController().signal,
      runtime: fakeRuntime(async input => {
        commands.push(input.command)
        return { stdout: 'created\n', stderr: '', exitCode: 0 }
      }),
      config: fakeConfig(),
    })

    assert.equal(commands.length, 1)
    assert.doesNotMatch(commands[0], /--gang-start/)
    assert.doesNotMatch(commands[0], /--host-network/)
    assert.doesNotMatch(commands[0], /--custom-resources/)
    assert.match(commands[0], /--priority 1/)
    const output = result.output as any
    assert.equal(output.resources.priority, 1)
    assert.equal(output.resources.custom, undefined)
  })

  it('does not pass priority for idle-lane jobs', async () => {
    const commands: string[] = []
    await brainppClusterTool.call({
      operation: 'submit',
      name: 'demo-idle',
      image: 'image:tag',
      command: 'echo hi',
      taskType: 'idle',
      priority: 9,
    } as any, {
      cwd: '/workspace',
      abortSignal: new AbortController().signal,
      runtime: fakeRuntime(async input => {
        commands.push(input.command)
        return { stdout: 'created\n', stderr: '', exitCode: 0 }
      }),
      config: fakeConfig(),
    })

    assert.equal(commands.length, 1)
    assert.match(commands[0], /--task-type 'idle'/)
    assert.doesNotMatch(commands[0], /--priority/)
    assert.doesNotMatch(commands[0], /--private-machine=group/)
  })

  it('does not emit namespace or charged group unless explicitly provided', async () => {
    const commands: string[] = []
    await brainppClusterTool.call({
      operation: 'submit',
      name: 'demo-defaults',
      image: 'image:tag',
      command: 'echo hi',
    } as any, {
      cwd: '/workspace',
      abortSignal: new AbortController().signal,
      runtime: fakeRuntime(async input => {
        commands.push(input.command)
        return { stdout: 'created\n', stderr: '', exitCode: 0 }
      }),
      config: fakeConfig(),
    })

    assert.equal(commands.length, 1)
    assert.doesNotMatch(commands[0], /--namespace/)
    assert.doesNotMatch(commands[0], /--charged-group/)
  })

  it('fails fast when /workspace cannot be translated to a configured GPFS mount', async () => {
    await assert.rejects(
      () => brainppClusterTool.call({
        operation: 'submit',
        name: 'demo-train',
        image: 'registry.example.com/demo:latest',
        command: 'python train.py',
      } as any, {
        cwd: '/workspace',
        abortSignal: new AbortController().signal,
        runtime: fakeRuntime(async () => ({ stdout: '', stderr: '', exitCode: 0 }), '/tmp/lightclaw'),
        config: fakeConfig(),
      }),
      /runtime\.clusterSettings\.gpfsMounts/,
    )
  })
})

describe('BrainppCluster delete', () => {
  it('requires a one-shot virtual confirmation before deleting a job', async () => {
    const commands: string[] = []
    const asks: Array<{ toolName: string; input: unknown }> = []
    const result = await brainppClusterTool.call({
      operation: 'delete',
      job: 'demo-123',
    } as any, {
      cwd: '/workspace',
      abortSignal: new AbortController().signal,
      runtime: fakeRuntime(async input => {
        commands.push(input.command)
        return { stdout: 'deleted demo-123\n', stderr: '', exitCode: 0 }
      }),
      canUseTool: async (tool, input) => {
        asks.push({ toolName: tool.name, input })
        return { behavior: 'allow' }
      },
    })

    assert.deepEqual(asks.map(item => item.toolName), ['BrainppClusterDeleteConfirm'])
    assert.deepEqual(asks[0]?.input, { operation: 'delete', job: 'demo-123' })
    assert.equal(commands.length, 1)
    assert.match(commands[0], /rjob delete 'demo-123'/)

    const output = result.output as any
    assert.equal(output.operation, 'delete')
    assert.equal(output.target, 'demo-123')
  })

  it('does not delete when the virtual confirmation is denied', async () => {
    const commands: string[] = []
    const result = await brainppClusterTool.call({
      operation: 'delete',
      job: 'demo-123',
    } as any, {
      cwd: '/workspace',
      abortSignal: new AbortController().signal,
      runtime: fakeRuntime(async input => {
        commands.push(input.command)
        return { stdout: '', stderr: '', exitCode: 0 }
      }),
      canUseTool: async () => ({ behavior: 'deny', reason: 'not today' }),
    })

    assert.equal(commands.length, 0)
    assert.equal(result.isError, true)
    assert.match((result.output as any).stderr, /not today/)
  })
})

describe('BrainppCluster stop', () => {
  it('stops a job with rjob stop', async () => {
    const commands: string[] = []
    const result = await brainppClusterTool.call({
      operation: 'stop',
      job: 'demo-123',
    } as any, {
      cwd: '/workspace',
      abortSignal: new AbortController().signal,
      runtime: fakeRuntime(async input => {
        commands.push(input.command)
        return { stdout: 'stopped demo-123\n', stderr: '', exitCode: 0 }
      }),
    })

    assert.equal(commands.length, 1)
    assert.match(commands[0], /rjob stop 'demo-123'/)
    const output = result.output as any
    assert.equal(output.operation, 'stop')
    assert.equal(output.target, 'demo-123')
  })
})

describe('BrainppCluster permission suggestions', () => {
  it('scopes grantable rules by operation', () => {
    const rules = brainppClusterTool.suggestPermissionRules?.({
      operation: 'submit',
      name: 'demo',
      image: 'image:tag',
      command: 'echo hi',
    } as any) ?? []

    assert.deepEqual(rules, [{ toolName: 'BrainppCluster', ruleContent: 'operation:submit' }])
    assert.equal(matchToolContent('BrainppCluster', 'operation:submit', { operation: 'submit' }), true)
    assert.equal(matchToolContent('BrainppCluster', 'operation:submit', { operation: 'delete' }), false)
  })
})

describe('BrainppCluster submit extraArgs guard', () => {
  it('rejects boundary-overriding flags (mount/namespace/group) in extraArgs', async () => {
    for (const evil of [
      '--mount=gpfs://gpfs1/ailab-hs/other/secret:/stolen',
      '--namespace=ailab-other',
      '--charged-group=other',
      '--group=other',
    ]) {
      await assert.rejects(
        () => brainppClusterTool.call({
          operation: 'submit',
          name: 'demo',
          image: 'image:tag',
          command: 'echo hi',
          extraArgs: [evil],
        } as any, {
          cwd: '/workspace',
          abortSignal: new AbortController().signal,
          runtime: fakeRuntime(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
          config: fakeConfig(),
        }),
        /extraArgs may not set/,
        `expected rejection for ${evil}`,
      )
    }
  })
})

describe('BrainppCluster submit mounts', () => {
  it('rejects extra mount paths outside configured GPFS prefixes', async () => {
    await assert.rejects(
      () => brainppClusterTool.call({
        operation: 'submit',
        name: 'demo',
        image: 'image:tag',
        command: 'echo hi',
        mounts: ['/not/shared/data'],
      } as any, {
        cwd: '/workspace',
        abortSignal: new AbortController().signal,
        runtime: fakeRuntime(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
        config: fakeConfig(),
      }),
      /runtime\.clusterSettings\.gpfsMounts/,
    )
  })
})

describe('BrainppCluster submit output redaction', () => {
  it('does not leak the resolved gpfs workspace path to the model', async () => {
    const result = await brainppClusterTool.call({
      operation: 'submit',
      name: 'demo',
      image: 'image:tag',
      command: 'echo hi',
    } as any, {
      cwd: '/workspace',
      abortSignal: new AbortController().signal,
      runtime: fakeRuntime(async () => ({ stdout: 'created\n', stderr: '', exitCode: 0 })),
      config: fakeConfig(),
    })

    const out = result.output as ClusterJobOutput
    if (out.operation === 'capacity') {
      assert.fail('expected a submit (text) output')
    }
    // Pre-fix the resolved gpfs path leaked via output.command's --mount and via
    // the rendered "Auto workspace mount:" line. The executed command still
    // carries the real mount (the job needs it) — only the model-facing surfaces redact.
    assert.doesNotMatch(out.command, /gpfs:\/\/gpfs1\/ailab-hs\/user/)
    assert.doesNotMatch(formatClusterJobOutput(out), /gpfs:\/\/gpfs1\/ailab-hs\/user/)
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

function fakeRuntime(
  exec: (input: ExecInput) => Promise<ExecResult>,
  hostWorkspace = '/mnt/shared-storage-user/ailab-hs/user/lightclaw',
): Runtime {
  return {
    kind: 'local',
    isolated: false,
    workspaceRoot: '/workspace',
    scratchRoot: '/scratch',
    securityProfile: 'host-trusted',
    control: null as never,
    data: null as never,
    paths: {
      mountTable: [{ host: hostWorkspace, worker: '/workspace', mode: 'rw' }],
      toHostPath: (workerPath: string) => workerPath === '/workspace' ? hostWorkspace : null,
      toWorkerPath: (hostPath: string) => hostPath === hostWorkspace ? '/workspace' : null,
      isShared: () => true,
      isAllowed: () => true,
    },
    fs: null as never,
    start: async () => {},
    stop: async () => {},
    isRunning: () => true,
    isAvailable: async () => ({ ok: true }),
    exec,
  }
}

function fakeConfig() {
  return {
    runtime: {
      clusterSettings: {
        namespace: 'ailab-hs',
        chargedGroup: 'hs_gpu',
        gpfsMounts: [
          {
            hostPrefix: '/mnt/shared-storage-user/ailab-hs/user',
            mountPrefix: 'gpfs://gpfs1/ailab-hs/user',
          },
        ],
        distributedRdmaResources: {
          'rdma/mlnx_shared': 8,
          'mellanox.com/mlnx_rdma': 1,
        },
      },
    },
  } as any
}
