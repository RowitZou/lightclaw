import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { toJSONSchema } from 'zod/v4'

import { normalizeToolInputSchemaForAnthropic } from './anthropic-tool-schema.js'
import { toolToAPISchema } from '../tool.js'
import { brainppClusterTool } from '../tools/cluster-job.js'

describe('provider/anthropic-tool-schema: normalizeToolInputSchemaForAnthropic', () => {
  it('passes through a schema already at type:object unchanged (identity)', () => {
    const schema = {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    }
    // identity, not just deep-equal — no needless copy on the common path
    assert.equal(normalizeToolInputSchemaForAnthropic(schema), schema)
  })

  it('stamps type:object onto a zod discriminatedUnion while PRESERVING oneOf', () => {
    const inputSchema = z.discriminatedUnion('operation', [
      z.object({ operation: z.literal('capacity'), group: z.string().optional() }),
      z.object({ operation: z.literal('submit'), name: z.string(), gpu: z.number().optional() }),
      z.object({ operation: z.literal('get'), job: z.string() }),
    ])
    const serialized = toJSONSchema(inputSchema) as Record<string, unknown>
    // Precondition: this is exactly the shape Bedrock rejects.
    assert.equal(serialized.type, undefined)
    assert.ok(Array.isArray(serialized.oneOf))

    const out = normalizeToolInputSchemaForAnthropic(serialized)

    assert.equal(out.type, 'object')
    // Unlike the OpenAI flatten, the union branches are kept intact.
    assert.ok(Array.isArray(out.oneOf))
    assert.equal((out.oneOf as unknown[]).length, 3)
  })

  it('stamps type:object onto a top-level anyOf union', () => {
    const out = normalizeToolInputSchemaForAnthropic({
      anyOf: [
        { type: 'object', properties: { a: { type: 'string' } } },
        { type: 'object', properties: { b: { type: 'number' } } },
      ],
    })
    assert.equal(out.type, 'object')
    assert.ok(Array.isArray(out.anyOf))
  })

  it('falls back to a permissive object for any other non-object top level', () => {
    const out = normalizeToolInputSchemaForAnthropic({ type: 'string' })
    assert.deepEqual(out, {
      type: 'object',
      properties: {},
      additionalProperties: true,
    })
  })

  // Regression: the real BrainppCluster tool's wire schema. Before the fix,
  // toolToAPISchema(brainppClusterTool).input_schema had NO top-level `type`
  // (zod discriminatedUnion → bare `oneOf`), which a Bedrock-fronted Anthropic
  // endpoint 400s with `input_schema.type: Field required`. With it normalized,
  // the root carries `type:"object"`.
  it('makes the real BrainppCluster input_schema Bedrock-legal', () => {
    const wire = toolToAPISchema(brainppClusterTool)
    const inputSchema = wire.input_schema as Record<string, unknown>

    // Pre-fix precondition — the bug this PR closes.
    assert.equal(inputSchema.type, undefined)
    assert.ok(Array.isArray(inputSchema.oneOf))

    const out = normalizeToolInputSchemaForAnthropic(inputSchema)
    assert.equal(out.type, 'object')
    assert.ok(Array.isArray(out.oneOf))
  })
})
