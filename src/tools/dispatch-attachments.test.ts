import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import type { LightClawConfig } from '../config.js'
import type { Role } from '../agents/types.js'
import type { Runtime, RuntimeStat } from '../runtime/types.js'
import {
  DispatchAttachmentError,
  prepareDispatchAttachments,
} from './dispatch-attachments.js'

// Default fakeRuntime backs runtime.fs.stat with host fs.stat so existing
// "use a tmpdir + real file" tests still see the file. Tests that need to
// exercise sandbox-aware paths (host-invisible /workspace/... resolved via
// shared-cluster-fs) pass an explicit fs stub instead.
function fakeRuntime(
  workspaceRoot: string,
  fsOverride?: { stat: (p: string) => Promise<RuntimeStat> },
): Runtime {
  return {
    workspaceRoot,
    fs:
      fsOverride ??
      {
        stat: async (p: string): Promise<RuntimeStat> => {
          const s = await fsp.stat(p)
          return {
            size: s.size,
            isFile: s.isFile(),
            isDirectory: s.isDirectory(),
            mtimeMs: s.mtimeMs,
          }
        },
      },
  } as unknown as Runtime
}

function fakeRole(): Role {
  return {
    agentType: 'test-role',
    kind: 'worker',
    whenToUse: 'test',
    systemPrompt: '',
    tools: [],
  }
}

function fakeConfig(): LightClawConfig {
  return {} as unknown as LightClawConfig
}

test('empty attachments list is a no-op', async () => {
  const result = await prepareDispatchAttachments({
    attachments: [],
    runtime: fakeRuntime('/tmp/ws'),
    config: fakeConfig(),
    calleeRole: fakeRole(),
  })

  assert.deepEqual(result, { inlineBlocks: [], breadcrumb: '' })
})

test('relative path is rejected', async () => {
  await assert.rejects(
    prepareDispatchAttachments({
      attachments: ['./relative.jpg'],
      runtime: fakeRuntime('/tmp/ws'),
      config: fakeConfig(),
      calleeRole: fakeRole(),
    }),
    (err: unknown) =>
      err instanceof DispatchAttachmentError && /must be absolute/.test(err.message),
  )
})

test('absolute path outside workspaceRoot is rejected', async () => {
  await assert.rejects(
    prepareDispatchAttachments({
      attachments: ['/etc/passwd'],
      runtime: fakeRuntime('/tmp/ws'),
      config: fakeConfig(),
      calleeRole: fakeRole(),
    }),
    (err: unknown) =>
      err instanceof DispatchAttachmentError && /outside workspaceRoot/.test(err.message),
  )
})

test('traversal that resolves outside workspaceRoot is rejected', async () => {
  await assert.rejects(
    prepareDispatchAttachments({
      attachments: ['/tmp/ws/../../etc/passwd'],
      runtime: fakeRuntime('/tmp/ws'),
      config: fakeConfig(),
      calleeRole: fakeRole(),
    }),
    (err: unknown) =>
      err instanceof DispatchAttachmentError && /outside workspaceRoot/.test(err.message),
  )
})

test('nonexistent path is rejected', async () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), 'dispatch-att-ws-'))
  try {
    await assert.rejects(
      prepareDispatchAttachments({
        attachments: [path.join(ws, 'missing.jpg')],
        runtime: fakeRuntime(ws),
        config: fakeConfig(),
        calleeRole: fakeRole(),
      }),
      (err: unknown) =>
        err instanceof DispatchAttachmentError && /not accessible/.test(err.message),
    )
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('directory inside workspace is rejected as not a regular file', async () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), 'dispatch-att-ws-'))
  try {
    const sub = path.join(ws, 'subdir')
    mkdirSync(sub)
    await assert.rejects(
      prepareDispatchAttachments({
        attachments: [sub],
        runtime: fakeRuntime(ws),
        config: fakeConfig(),
        calleeRole: fakeRole(),
      }),
      (err: unknown) =>
        err instanceof DispatchAttachmentError && /not a regular file/.test(err.message),
    )
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('mixed valid + invalid: first invalid surfaces a DispatchAttachmentError', async () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), 'dispatch-att-ws-'))
  try {
    const valid = path.join(ws, 'ok.jpg')
    writeFileSync(valid, 'dummy')
    await assert.rejects(
      prepareDispatchAttachments({
        attachments: [valid, '/etc/passwd'],
        runtime: fakeRuntime(ws),
        config: fakeConfig(),
        calleeRole: fakeRole(),
      }),
      (err: unknown) =>
        err instanceof DispatchAttachmentError && /outside workspaceRoot/.test(err.message),
    )
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

// Regression: 2026-05-26 dogfood. RlaunchRuntime exposes container paths
// (`/workspace/...`) to tools; the daemon process cannot fs.stat those
// directly because /workspace lives only in the worker pod. Attachment
// validation MUST consult runtime.fs.stat so PathPolicy + shared-cluster-fs
// translate the container-view path to the host gpfs path. Pre-fix the code
// used node:fs.stat and reported ENOENT for files that physically existed
// (Dispatch feishuSecretary failed 2x on real images before the model
// abandoned the attachments field and went path-only).
test('in-mount path host-invisible to daemon passes via runtime.fs.stat', async () => {
  let statCalls: string[] = []
  const runtime = fakeRuntime('/workspace', {
    stat: async (p: string): Promise<RuntimeStat> => {
      statCalls.push(p)
      // Simulate shared-cluster-fs: file exists in worker mount, but daemon
      // node:fs.stat on '/workspace/...' would ENOENT.
      return { size: 1024, isFile: true, isDirectory: false, mtimeMs: 0 }
    },
  })
  await assert.rejects(
    prepareDispatchAttachments({
      attachments: ['/workspace/paper_reading/assets/pid-01.png'],
      runtime,
      config: fakeConfig(),
      calleeRole: fakeRole(),
    }),
    (err: unknown) => {
      // Validation must NOT surface an ENOENT/not-accessible
      // DispatchAttachmentError for an in-mount path that runtime.fs sees.
      // Anything else (provider/encoder errors from fakeConfig) is fine and
      // proves validation passed.
      if (err instanceof DispatchAttachmentError && /not accessible/.test(err.message)) {
        return false
      }
      return true
    },
  )
  assert.equal(statCalls.length, 1, 'runtime.fs.stat must be the stat source')
  assert.equal(statCalls[0], '/workspace/paper_reading/assets/pid-01.png')
})

test('directory in-mount is rejected via runtime.fs.stat (isFile:false)', async () => {
  const runtime = fakeRuntime('/workspace', {
    stat: async (): Promise<RuntimeStat> => ({
      size: 0,
      isFile: false,
      isDirectory: true,
      mtimeMs: 0,
    }),
  })
  await assert.rejects(
    prepareDispatchAttachments({
      attachments: ['/workspace/some-dir'],
      runtime,
      config: fakeConfig(),
      calleeRole: fakeRole(),
    }),
    (err: unknown) =>
      err instanceof DispatchAttachmentError && /not a regular file/.test(err.message),
  )
})
