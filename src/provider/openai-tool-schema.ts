/**
 * OpenAI tool-parameter schema normalization (shared by the `openai` Chat
 * Completions provider and the `openai-auth` Responses provider).
 *
 * The OpenAI function-calling APIs require a function tool's top-level
 * `parameters` to be a JSON Schema of `type: "object"`. Zod
 * `discriminatedUnion` / `union` schemas serialize (via `zod/v4`'s
 * `toJSONSchema`) to a top-level `oneOf` / `anyOf` with NO top-level `type`,
 * which the API rejects with
 *   `invalid_function_parameters: ... schema must be a JSON Schema of
 *    'type: "object"', got 'type: "None"'`.
 * (The 2026-06-07 `official`-deployment outage: `BrainppCluster`'s
 * `discriminatedUnion('operation', …)` poisoned every codex turn once
 * ToolSearch loaded it, and the deterministic 400 was retried as a transient
 * "upstream blip".)
 *
 * The real per-branch validation still happens locally: query.ts re-validates
 * the model's returned arguments against the tool's own Zod schema before
 * dispatch. The wire schema is therefore advisory — flattening a top-level
 * union of object branches into a single object with the merged property set
 * loses no server-side guarantee while making the schema API-legal. Anthropic
 * accepts the union shape natively, so this normalization is OpenAI-family
 * only and is applied at the provider tool-conversion boundary, not in
 * `toolToAPISchema`.
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
 * Return an OpenAI-legal `parameters` schema: a no-op for schemas already at
 * `type: "object"`, a flattened single object for a top-level union of object
 * branches, and a permissive object fallback for any other non-object top
 * level (so the request never 400s on schema shape).
 */
export function normalizeToolParametersForOpenAI(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (schema.type === 'object') {
    return schema
  }

  const branches = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : null

  if (!branches) {
    // Some other non-object top level (rare). Fall back to a permissive object
    // so the request is at least API-legal; Zod still validates the real input.
    return { type: 'object', properties: {}, additionalProperties: true }
  }

  const properties: Record<string, unknown> = {}
  const requiredSets: string[][] = []
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

  // Only fields required by EVERY branch are unconditionally required on the
  // flattened object (typically just the discriminator).
  const required = requiredSets.length > 0
    ? requiredSets.reduce((acc, set) => acc.filter(key => set.includes(key)))
    : []

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  }
}
