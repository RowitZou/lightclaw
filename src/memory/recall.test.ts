import assert from 'node:assert/strict'
import test from 'node:test'

import type { LightClawConfig } from '../config.js'
import type { Role } from '../agents/types.js'
import { selectRelevantMemories } from './recall.js'

test('selectRelevantMemories hard-blocks internal roles', async () => {
  const result = await selectRelevantMemories(
    'what should I remember?',
    '/tmp/lightclaw-memory',
    {} as LightClawConfig,
    { topN: 3 },
    role({ agentType: 'memoryExtractor', kind: 'internal' }),
  )

  assert.deepEqual(result, [])
})

function role(overrides: Partial<Role>): Role {
  return {
    agentType: 'test-role',
    whenToUse: 'test',
    tools: ['MemoryRead'],
    systemPrompt: 'system',
    ...overrides,
  }
}
