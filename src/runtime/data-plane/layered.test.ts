import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { DataPlane, RuntimeStat } from '../types.js'
import { MountTablePathPolicy } from '../path-policy/mount-table.js'
import { DataPlaneNotApplicableError, LayeredDataPlane } from './layered.js'

function fakePlane(input: {
  kind: DataPlane['kind']
  readFile?: (path: string) => Promise<Buffer>
  chmod?: (path: string, mode: number) => Promise<void>
  stat?: (path: string) => Promise<RuntimeStat>
}): DataPlane {
  return {
    kind: input.kind,
    independentFromControl: input.kind !== 'exec-relay',
    reliability: input.kind === 'exec-relay' ? 'depends-on-control-plane' : 'fs-semantic',
    readFile: input.readFile ?? (async () => Buffer.from('ok')),
    writeFile: async () => {},
    ...(input.chmod ? { chmod: input.chmod } : {}),
    stat: input.stat ?? (async () => ({
      size: 2,
      isFile: true,
      isDirectory: false,
      mtimeMs: 1,
    })),
    readdir: async () => ['a.txt'],
  }
}

const policy = new MountTablePathPolicy([
  { host: '/host/workspace', worker: '/workspace', mode: 'rw' },
])

test('LayeredDataPlane returns the first applicable successful layer', async () => {
  const data = new LayeredDataPlane([
    fakePlane({ kind: 'bind-mount', readFile: async () => Buffer.from('fast') }),
    fakePlane({ kind: 'exec-relay', readFile: async () => Buffer.from('slow') }),
  ], policy)

  assert.equal((await data.readFile('/workspace/a.txt')).toString(), 'fast')
})

test('LayeredDataPlane routes daemon-invisible mounts through exec-relay', async () => {
  const workerOnlyPolicy = new MountTablePathPolicy([{
    host: '/host-not-mounted',
    worker: '/datasets/private',
    mode: 'rw',
    daemonVisible: false,
  } as import('../types.js').MountEntry])
  const calls: string[] = []
  const data = new LayeredDataPlane([
    fakePlane({
      kind: 'shared-cluster-fs',
      readFile: async () => {
        calls.push('shared')
        return Buffer.from('wrong')
      },
    }),
    fakePlane({
      kind: 'exec-relay',
      readFile: async () => {
        calls.push('relay')
        return Buffer.from('worker')
      },
    }),
  ], workerOnlyPolicy)

  assert.equal((await data.readFile('/datasets/private/file.txt')).toString(), 'worker')
  assert.deepEqual(calls, ['relay'])
})

test('LayeredDataPlane falls through on non-fatal not-applicable errors', async () => {
  const data = new LayeredDataPlane([
    fakePlane({
      kind: 'bind-mount',
      readFile: async () => {
        throw new DataPlaneNotApplicableError('disabled')
      },
    }),
    fakePlane({ kind: 'exec-relay', readFile: async () => Buffer.from('slow') }),
  ], policy)

  assert.equal((await data.readFile('/workspace/a.txt')).toString(), 'slow')
})

test('LayeredDataPlane does not fall through on fatal fs errors', async () => {
  const error = Object.assign(new Error('missing'), { code: 'ENOENT' })
  const data = new LayeredDataPlane([
    fakePlane({
      kind: 'bind-mount',
      readFile: async () => {
        throw error
      },
    }),
    fakePlane({ kind: 'exec-relay', readFile: async () => Buffer.from('slow') }),
  ], policy)

  await assert.rejects(() => data.readFile('/workspace/missing.txt'), /missing/)
})

test('LayeredDataPlane refuses large reads through exec-relay fallback', async () => {
  let readCalled = false
  const data = new LayeredDataPlane([
    fakePlane({
      kind: 'exec-relay',
      stat: async () => ({
        size: 5 * 1024 * 1024,
        isFile: true,
        isDirectory: false,
        mtimeMs: 1,
      }),
      readFile: async () => {
        readCalled = true
        return Buffer.from('truncated')
      },
    }),
  ], policy, { maxExecRelayBytes: 4 * 1024 * 1024 })

  await assert.rejects(
    () => data.readFile('/etc/large.pdf'),
    /refusing to read .* via exec-relay/,
  )
  assert.equal(readCalled, false)
})

test('LayeredDataPlane default relay cap accepts files above the legacy 4MB ceiling', async () => {
  let readCalled = false
  const data = new LayeredDataPlane([
    fakePlane({
      kind: 'exec-relay',
      stat: async () => ({
        size: 8 * 1024 * 1024,
        isFile: true,
        isDirectory: false,
        mtimeMs: 1,
      }),
      readFile: async () => {
        readCalled = true
        return Buffer.from('ok')
      },
    }),
  ], policy)

  assert.equal((await data.readFile('/etc/legacy-cap.bin')).toString(), 'ok')
  assert.equal(readCalled, true)
})

test('LayeredDataPlane honors an explicit maxExecRelayBytes override', async () => {
  let readCalled = false
  const data = new LayeredDataPlane([
    fakePlane({
      kind: 'exec-relay',
      stat: async () => ({
        size: 8 * 1024 * 1024,
        isFile: true,
        isDirectory: false,
        mtimeMs: 1,
      }),
      readFile: async () => {
        readCalled = true
        return Buffer.from('ok')
      },
    }),
  ], policy, { maxExecRelayBytes: 32 * 1024 * 1024 })

  assert.equal((await data.readFile('/etc/big.bin')).toString(), 'ok')
  assert.equal(readCalled, true)
})

test('LayeredDataPlane chmod uses the first chmod-capable applicable layer', async () => {
  const calls: Array<{ layer: string; path: string; mode: number }> = []
  const data = new LayeredDataPlane([
    fakePlane({ kind: 'bind-mount' }),
    fakePlane({
      kind: 'exec-relay',
      chmod: async (pathname, mode) => {
        calls.push({ layer: 'exec-relay', path: pathname, mode })
      },
    }),
  ], policy)

  await data.chmod('/workspace/bin/run.sh', 0o755)

  assert.deepEqual(calls, [
    { layer: 'exec-relay', path: '/workspace/bin/run.sh', mode: 0o755 },
  ])
})

test('LayeredDataPlane blocks chmod on read-only mounts before any layer runs', async () => {
  const roPolicy = new MountTablePathPolicy([
    { host: '/host/ro', worker: '/opt/ro', mode: 'ro' },
  ])
  let chmodCalled = false
  const data = new LayeredDataPlane([
    fakePlane({
      kind: 'bind-mount',
      chmod: async () => {
        chmodCalled = true
      },
    }),
  ], roPolicy)

  await assert.rejects(
    () => data.chmod('/opt/ro/foo.sh', 0o755),
    /Cannot chmod read-only mount/,
  )
  assert.equal(chmodCalled, false)
})

test('LayeredDataPlane blocks writes to read-only mounts before any layer runs', async () => {
  const roPolicy = new MountTablePathPolicy([
    { host: '/host/ro', worker: '/opt/ro', mode: 'ro' },
  ])
  let writeCalled = false
  const data = new LayeredDataPlane([
    {
      ...fakePlane({ kind: 'bind-mount' }),
      writeFile: async () => {
        writeCalled = true
      },
    },
  ], roPolicy)

  await assert.rejects(
    () => data.writeFile('/opt/ro/foo.txt', Buffer.from('x')),
    /Cannot write to read-only mount/,
  )
  assert.equal(writeCalled, false)
})

test('LayeredDataPlane propagates the last layer fatal error after earlier layers opt out', async () => {
  // When bind-mount (or shared-cluster-fs) signals "not applicable" and the
  // exec-relay layer hits a real fatal error (ENOENT, EACCES, …), the layered
  // wrapper must surface the fatal text verbatim — no swallowing, no
  // re-wrapping. Pre-Phase-33 this also covered the workspace-guard reject
  // text; that guard is now gone (toContainerPath accepts /tmp, /etc, …) but
  // the bubbling contract still matters for legitimate filesystem errors.
  const data = new LayeredDataPlane([
    fakePlane({
      kind: 'bind-mount',
      readFile: async () => {
        throw new DataPlaneNotApplicableError('out of mount')
      },
    }),
    fakePlane({
      kind: 'exec-relay',
      readFile: async () => {
        const err = new Error('readFile /tmp/missing: ENOENT') as NodeJS.ErrnoException
        err.code = 'ENOENT'
        throw err
      },
    }),
  ], policy)

  await assert.rejects(
    () => data.readFile('/tmp/missing'),
    /ENOENT/,
  )
})
