import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import type { LightClawConfig } from '../config.js'
import type { Role } from '../agents/types.js'
import type { Runtime } from '../runtime/types.js'
import {
  DispatchAttachmentError,
  prepareDispatchAttachments,
} from './dispatch-attachments.js'

function fakeRuntime(workspaceRoot: string): Runtime {
  return { workspaceRoot } as unknown as Runtime
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
