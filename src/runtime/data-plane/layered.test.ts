import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { DataPlane, GlobOptions, RuntimeStat } from '../types.js'
import { MountTablePathPolicy } from '../path-policy/mount-table.js'
import { DataPlaneNotApplicableError, LayeredDataPlane } from './layered.js'

function fakePlane(input: {
  kind: DataPlane['kind']
  readFile?: (path: string) => Promise<Buffer>
  stat?: (path: string) => Promise<RuntimeStat>
}): DataPlane {
  return {
    kind: input.kind,
    independentFromControl: input.kind !== 'exec-relay',
    reliability: input.kind === 'exec-relay' ? 'depends-on-control-plane' : 'fs-semantic',
    readFile: input.readFile ?? (async () => Buffer.from('ok')),
    writeFile: async () => {},
    stat: input.stat ?? (async () => ({
      size: 2,
      isFile: true,
      isDirectory: false,
      mtimeMs: 1,
    })),
    glob: async (_pattern: string | string[], _options?: GlobOptions) => ['a.txt'],
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
