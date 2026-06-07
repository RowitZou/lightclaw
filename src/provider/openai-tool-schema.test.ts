import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { toJSONSchema } from 'zod/v4'

import { normalizeToolParametersForOpenAI } from './openai-tool-schema.js'

describe('provider/openai-tool-schema: normalizeToolParametersForOpenAI', () => {
  it('passes through a schema already at type:object unchanged', () => {
    const schema = {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    }
    // identity, not just deep-equal — no needless copy on the common path
    assert.equal(normalizeToolParametersForOpenAI(schema), schema)
  })

  it('flattens a zod discriminatedUnion (toJSONSchema → top-level oneOf, no type) into a single object', () => {
    // Faithful reproduction of BrainppCluster's real serialization path:
    // tool.ts builds input_schema via toJSONSchema(tool.inputSchema), and a
    // discriminatedUnion lands as a top-level `oneOf` with NO top-level `type`,
    // which OpenAI Responses rejects as `type: "None"`.
    const inputSchema = z.discriminatedUnion('operation', [
      z.object({ operation: z.literal('capacity'), group: z.string().optional() }),
      z.object({ operation: z.literal('submit'), name: z.string(), gpu: z.number().optional() }),
      z.object({ operation: z.literal('get'), job: z.string() }),
    ])
    const serialized = toJSONSchema(inputSchema) as Record<string, unknown>
    // Precondition: this is exactly the shape that broke codex.
    assert.equal(serialized.type, undefined)
    assert.ok(Array.isArray(serialized.oneOf))

    const out = normalizeToolParametersForOpenAI(serialized)

    assert.equal(out.type, 'object')
    assert.equal(out.oneOf, undefined)
    assert.equal(out.anyOf, undefined)
    const props = out.properties as Record<string, unknown>
    // All branch properties are merged into one object.
    for (const key of ['operation', 'group', 'name', 'gpu', 'job']) {
      assert.ok(key in props, `expected merged property ${key}`)
    }
    // The discriminator collapses to an enum of every branch's literal.
    assert.deepEqual((props.operation as { enum: unknown[] }).enum, [
      'capacity',
      'submit',
      'get',
    ])
    // Only fields required by EVERY branch stay required — here just operation.
    assert.deepEqual(out.required, ['operation'])
  })

  it('falls back to a permissive object for a non-object, non-union top level', () => {
    const out = normalizeToolParametersForOpenAI({ type: 'string' })
    assert.deepEqual(out, {
      type: 'object',
      properties: {},
      additionalProperties: true,
    })
  })
})
