import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { toJSONSchema } from 'zod/v4'

import { normalizeToolInputSchema } from './tool-input-schema.js'
import { toolToAPISchema } from '../tool.js'
import { brainppClusterTool } from '../tools/cluster-job.js'

describe('provider/tool-input-schema: normalizeToolInputSchema', () => {
  it('passes through a schema already at type:object unchanged', () => {
    const schema = {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    }
    // identity, not just deep-equal — no needless copy on the common path
    assert.equal(normalizeToolInputSchema(schema), schema)
  })

  it('flattens a zod discriminatedUnion (toJSONSchema → top-level oneOf, no type) into a single object', () => {
    // Faithful reproduction of BrainppCluster's real serialization path:
    // tool.ts builds input_schema via toJSONSchema(tool.inputSchema), and a
    // discriminatedUnion lands as a top-level `oneOf` with NO top-level `type`,
    // which OpenAI Responses rejects as `type: "None"` and Bedrock rejects as
    // `input_schema does not support oneOf, allOf, or anyOf at the top level`.
    const inputSchema = z.discriminatedUnion('operation', [
      z.object({ operation: z.literal('capacity'), group: z.string().optional() }),
      z.object({ operation: z.literal('submit'), name: z.string(), gpu: z.number().optional() }),
      z.object({ operation: z.literal('get'), job: z.string() }),
    ])
    const serialized = toJSONSchema(inputSchema) as Record<string, unknown>
    // Precondition: this is exactly the shape that broke codex and Bedrock.
    assert.equal(serialized.type, undefined)
    assert.ok(Array.isArray(serialized.oneOf))

    const out = normalizeToolInputSchema(serialized)

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
    const out = normalizeToolInputSchema({ type: 'string' })
    assert.deepEqual(out, {
      type: 'object',
      properties: {},
      additionalProperties: true,
    })
  })

  // Regression (2026-09-29): the 06-27 Anthropic normalizer answered Bedrock's
  // `input_schema.type: Field required` by stamping `type:"object"` while
  // KEEPING the `oneOf`. Bedrock then tightened to reject any top-level
  // combinator, so a `type` + `oneOf` root must be flattened too, not passed
  // through as "already an object".
  it('flattens a type-stamped root that still carries a top-level oneOf', () => {
    const out = normalizeToolInputSchema({
      type: 'object',
      oneOf: [
        { type: 'object', properties: { operation: { const: 'get' }, job: { type: 'string' } }, required: ['operation', 'job'] },
        { type: 'object', properties: { operation: { const: 'list' } }, required: ['operation'] },
      ],
    })
    assert.equal(out.oneOf, undefined)
    assert.equal(out.type, 'object')
    assert.deepEqual(Object.keys(out.properties as object).sort(), ['job', 'operation'])
    assert.deepEqual(out.required, ['operation'])
  })

  it('flattens a zod intersection (top-level allOf) requiring every part\'s fields', () => {
    const serialized = toJSONSchema(
      z.intersection(z.object({ a: z.string() }), z.object({ b: z.number(), c: z.boolean().optional() })),
    ) as Record<string, unknown>
    assert.ok(Array.isArray(serialized.allOf))

    const out = normalizeToolInputSchema(serialized)

    assert.equal(out.type, 'object')
    assert.equal(out.allOf, undefined)
    assert.deepEqual(Object.keys(out.properties as object).sort(), ['a', 'b', 'c'])
    assert.deepEqual(out.required, ['a', 'b'])
  })

  it('makes the real BrainppCluster input_schema free of top-level combinators', () => {
    const inputSchema = toolToAPISchema(brainppClusterTool).input_schema as Record<string, unknown>
    // Precondition: the tool still serializes to the shape Bedrock rejects.
    assert.ok(Array.isArray(inputSchema.oneOf))

    const out = normalizeToolInputSchema(inputSchema)

    assert.equal(out.type, 'object')
    for (const key of ['oneOf', 'anyOf', 'allOf']) {
      assert.equal(out[key], undefined, `top-level ${key} must be gone`)
    }
    assert.ok(Array.isArray((out.properties as { operation: { enum: unknown[] } }).operation.enum))
  })
})
