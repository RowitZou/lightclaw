/**
 * Tool input-schema normalization, shared by every provider's tool-conversion
 * boundary (`anthropic.ts` → `input_schema`, `openai-auth.ts` → `parameters`).
 *
 * Both wire contracts want a tool's top-level schema to be a plain JSON Schema
 * `type: "object"`. Zod `discriminatedUnion` / `union` / `intersection` schemas
 * serialize (via `zod/v4`'s `toJSONSchema`, in `tool.ts`'s `toolToAPISchema`)
 * to a top-level `oneOf` / `anyOf` / `allOf` with NO top-level `type`, and
 * strict endpoints reject that shape before inference:
 *   - OpenAI Responses: `invalid_function_parameters: ... schema must be a JSON
 *     Schema of 'type: "object"', got 'type: "None"'` (2026-06-07 `official`
 *     outage — `BrainppCluster` poisoned every codex turn once ToolSearch
 *     loaded it).
 *   - Bedrock-fronted Anthropic: first `input_schema.type: Field required`
 *     (2026-06-27), answered then by stamping `type` and KEEPING the `oneOf`;
 *     then, once Bedrock tightened validation, `input_schema does not support
 *     oneOf, allOf, or anyOf at the top level` (2026-09-29 — every
 *     Bedrock-routed worker turn 400'd, zero steps run). The type-stamp was a
 *     per-message patch; the only shape both families accept is a flat object,
 *     so one normalizer now serves both.
 * Native Anthropic `/v1/messages` tolerates a bare union, which is why the
 * shape slipped through until a stricter relay sat in front of it.
 *
 * The real per-branch validation still happens locally: query.ts re-validates
 * the model's returned arguments against the tool's own Zod schema before
 * dispatch. The wire schema is therefore advisory — flattening a top-level
 * combinator of object branches into a single object with the merged property
 * set loses no server-side guarantee while making the schema API-legal.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function constOrEnumValues(schema: Record<string, unknown>): unknown[] {
  if ('const' in schema) return [schema.const]
  if (Array.isArray(schema.enum)) return schema.enum
  return []
}

/**
 * Merge one branch property into the accumulated property map. The common case
 * is the discriminator (`operation: const 'capacity' | 'submit' | …`): differing
 * `const` / `enum` values collapse into a unified `enum` so the model still
 * sees the valid operation set. Any other same-named collision keeps the first
 * definition (the wire schema is advisory; Zod re-validates server-side).
 */
function mergeProperty(
  target: Record<string, unknown>,
  key: string,
  incoming: unknown,
): void {
  const existing = target[key]
  if (existing === undefined) {
    target[key] = incoming
    return
  }
  if (isRecord(existing) && isRecord(incoming)) {
    const values = [...constOrEnumValues(existing), ...constOrEnumValues(incoming)]
    if (values.length > 0) {
      const deduped = [...new Set(values)]
      const { const: _const, enum: _enum, ...rest } = existing
      target[key] = deduped.length === 1
        ? { ...rest, const: deduped[0] }
        : { ...rest, enum: deduped }
    }
  }
}

/**
 * Return a provider-legal tool input schema: a no-op for schemas already at
 * `type: "object"` with no top-level combinator, a flattened single object for
 * a top-level `oneOf` / `anyOf` / `allOf` of object branches, and a permissive
 * object fallback for any other non-object top level (so the request never
 * 400s on schema shape).
 */
export function normalizeToolInputSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const combinator = Array.isArray(schema.oneOf)
    ? 'oneOf'
    : Array.isArray(schema.anyOf)
      ? 'anyOf'
      : Array.isArray(schema.allOf)
        ? 'allOf'
        : null

  if (schema.type === 'object' && !combinator) {
    return schema
  }

  if (!combinator) {
    // Some other non-object top level (rare). Fall back to a permissive object
    // so the request is at least API-legal; Zod still validates the real input.
    return { type: 'object', properties: {}, additionalProperties: true }
  }

  const branches = schema[combinator] as unknown[]
  const properties: Record<string, unknown> = {}
  const requiredSets: string[][] = []
  if (isRecord(schema.properties)) {
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      mergeProperty(properties, key, propSchema)
    }
  }
  for (const branch of branches) {
    if (!isRecord(branch)) continue
    const props = isRecord(branch.properties) ? branch.properties : {}
    for (const [key, propSchema] of Object.entries(props)) {
      mergeProperty(properties, key, propSchema)
    }
    if (Array.isArray(branch.required)) {
      requiredSets.push(
        branch.required.filter((entry): entry is string => typeof entry === 'string'),
      )
    }
  }

  // A union (`oneOf` / `anyOf`) keeps only fields required by EVERY branch
  // (typically just the discriminator); an intersection (`allOf`) requires
  // everything any part requires.
  // Fields the root itself requires (sibling of the combinator) always stay.
  const branchRequired = requiredSets.length === 0
    ? []
    : combinator === 'allOf'
      ? requiredSets.flat()
      : requiredSets.reduce((acc, set) => acc.filter(key => set.includes(key)))
  const rootRequired = Array.isArray(schema.required)
    ? schema.required.filter((entry): entry is string => typeof entry === 'string')
    : []
  const required = [...new Set([...rootRequired, ...branchRequired])]

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  }
}
