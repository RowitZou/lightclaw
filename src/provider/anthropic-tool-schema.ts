/**
 * Anthropic tool `input_schema` normalization.
 *
 * Anthropic's wire contract expects a tool's `input_schema` to be a JSON Schema
 * object whose top level declares `type: "object"`. Zod `discriminatedUnion` /
 * `union` schemas serialize (via `zod/v4`'s `toJSONSchema`, in `tool.ts`'s
 * `toolToAPISchema`) to a top-level `oneOf` / `anyOf` with NO top-level `type`.
 *
 * The native Anthropic `/v1/messages` endpoint tolerates that shape, so the
 * raw union flowed to the wire unchanged — see the (now-corrected) note in
 * `openai-tool-schema.ts` that originally scoped union normalization to the
 * OpenAI family only. But a Bedrock-fronted endpoint speaking the same
 * `input_schema` dialect is strict and rejects it:
 *   `ValidationException: tools.N.custom.input_schema.type: Field required`
 * (the 2026-06-27 `official`-deployment incident: `BrainppCluster`'s
 * `discriminatedUnion('operation', …)` poisoned every Bedrock-routed turn the
 * moment its schema entered the tools array — the request 400'd before
 * inference, so the worker produced zero steps and the task was marked failed,
 * independent of what the task actually asked for).
 *
 * Unlike the OpenAI Responses API — which rejects a top-level `oneOf` outright
 * and forces a lossy flatten into one merged object — Bedrock only requires the
 * root `type`. So this normalization is deliberately gentler: it adds
 * `type: "object"` while PRESERVING the `oneOf` branches, keeping the
 * discriminated-union guidance the model sees intact. Per-branch validation
 * still happens locally (query.ts re-validates the model's returned arguments
 * against the tool's own Zod schema before dispatch), so the wire schema is
 * advisory either way.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Return an Anthropic-legal `input_schema`: a no-op for schemas already at
 * `type: "object"`, a `type`-stamped copy (oneOf/anyOf branches preserved) for
 * a top-level union, and a permissive object fallback for any other non-object
 * top level (so the request never 400s on schema shape).
 */
export function normalizeToolInputSchemaForAnthropic(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (schema.type === 'object') {
    return schema
  }

  if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) {
    // Keep the union (model-facing discriminator stays precise); only add the
    // root `type` Bedrock requires. Native Anthropic accepts `type` + `oneOf`.
    return { ...schema, type: 'object' }
  }

  // Some other non-object top level (rare). Fall back to a permissive object so
  // the request is at least API-legal; Zod still validates the real input.
  return { type: 'object', properties: {}, additionalProperties: true }
}
