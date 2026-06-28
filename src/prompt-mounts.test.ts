import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'

import { setLightclawHomeOverride } from './paths.js'
import { buildSystemPromptTemplate, renderSystemPrompt } from './prompt.js'
import { saveUserRlaunchMounts } from './runtime/rlaunch-mounts.js'
import { createSessionContext, runWithSessionContext } from './session-context.js'
import type { Tool } from './tool.js'
import type { LightClawConfig } from './config.js'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'lc-mounts-'))
  setLightclawHomeOverride(path.join(tmpRoot, 'home'))
})

afterEach(() => {
  setLightclawHomeOverride(undefined)
  rmSync(tmpRoot, { recursive: true, force: true })
})

function fakeTool(name: string): Tool {
  return {
    name,
    description: `${name} description`,
    source: 'builtin',
    domain: 'host',
    riskLevel: 'safe',
    async call() {
      return { output: 'ok' }
    },
    formatResult(output, toolUseId) {
      return { type: 'tool_result', tool_use_id: toolUseId, content: String(output) }
    },
  }
}

function baseConfig(runtime: unknown): LightClawConfig {
  return {
    defaultModel: 'claude-sonnet-4-6',
    models: {
      'claude-sonnet-4-6': { endpoint: 'newapi', schema: 'anthropic', upstreamModel: 'claude-sonnet-4-6' },
    },
    endpoints: { newapi: { apiKey: 'sk-test', baseUrl: 'http://example.invalid' } },
    lane: {},
    paths: { sessions: path.join(tmpRoot, 'sessions') },
    memory: { recall: { enabled: false, topN: 3 }, session: { enabled: false } },
    runtime,
  } as unknown as LightClawConfig
}

async function renderEnv(config: LightClawConfig, currentUserId: string): Promise<string> {
  const ctx = createSessionContext({
    cwd: path.join(tmpRoot, 'workspace'),
    model: 'claude-sonnet-4-6',
    sessionsDir: path.join(tmpRoot, 'sessions'),
    memoryDir: path.join(tmpRoot, 'memory', currentUserId),
    currentUserId,
    sessionId: 'mounts-test',
  })
  return runWithSessionContext(ctx, async () => {
    const tools = ['Read', 'Write'].map(fakeTool)
    const template = await buildSystemPromptTemplate(tools, ctx.cwd, '/workspace', '/scratch', {
      autoMemory: false,
      config,
      sessionId: undefined,
    })
    return renderSystemPrompt(template, [], { tools })
  })
}

test('docker static bind mounts surface in the prompt with their ro/rw mode', async () => {
  const config = baseConfig({
    backend: 'docker',
    dockerSettings: {
      mounts: [
        { host: '/srv/imagenet', container: '/data/imagenet', mode: 'ro' },
        { host: '/srv/runs', container: '/data/runs', mode: 'rw' },
      ],
    },
  })
  const prompt = await renderEnv(config, 'alice')
  assert.match(prompt, /Mounted paths:/)
  assert.match(prompt, /^- \/data\/imagenet — read-only$/m)
  assert.match(prompt, /^- \/data\/runs — read-write$/m)
  assert.match(prompt, /A read-only path can be read but not written/)
})

test('cluster per-user mounts surface with their observed ro/rw mode', async () => {
  saveUserRlaunchMounts('bob', [
    { path: '/mnt/dataset', mode: 'ro' },
    { path: '/mnt/scratch', mode: 'rw' },
  ])
  const config = baseConfig({ backend: 'cluster', clusterSettings: { cpu: 8, memoryMb: 16384, gpu: 0 } })
  const prompt = await renderEnv(config, 'bob')
  assert.match(prompt, /Mounted paths:/)
  assert.match(prompt, /^- \/mnt\/dataset — read-only$/m)
  assert.match(prompt, /^- \/mnt\/scratch — read-write$/m)
})

test('no Mounted paths block when there are no extra mounts', async () => {
  const dockerEmpty = baseConfig({ backend: 'docker', dockerSettings: { mounts: [] } })
  assert.doesNotMatch(await renderEnv(dockerEmpty, 'alice'), /Mounted paths:/)

  const local = baseConfig({ backend: 'local' })
  assert.doesNotMatch(await renderEnv(local, 'alice'), /Mounted paths:/)

  const clusterNoMounts = baseConfig({ backend: 'cluster', clusterSettings: { cpu: 8, memoryMb: 16384, gpu: 0 } })
  assert.doesNotMatch(await renderEnv(clusterNoMounts, 'carol'), /Mounted paths:/)
})
