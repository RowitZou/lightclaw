import { describeImagesAdaptive, joinSegmentsForLLM } from './describe-adaptive.js'
import { readCachedCapability } from './capability-cache.js'
import type { LightClawConfig } from '../config.js'
import type {
  ApiMessage,
  AttachmentCapability,
  DescribeImageInput,
  Provider,
  Schema,
} from './types.js'
import type {
  ToolResultContentBlock,
  ToolResultTextBlock,
  UserToolResultBlock,
} from '../types.js'

/** Decide whether the destination provider accepts inline image blocks
 *  inside `tool_result.content`. Anthropic's Messages API natively
 *  supports text + image blocks in a tool_result content array. OpenAI
 *  Chat Completions tool messages and the Responses function_call_output
 *  shape are both string-only, so any image blocks we keep would be
 *  silently dropped or cause a 400 at request validation. For those
 *  providers we always replace image blocks via the sub-LLM describe
 *  path regardless of capability cache state. */
function providerSupportsImageInToolResult(schema: Schema): boolean {
  return schema === 'anthropic'
}

type FinalizationContext = {
  provider: Provider
  endpoint: string
  upstreamModel: string
  config: LightClawConfig
  /** describeImage adapter — closure over (provider, endpoint, upstreamModel)
   *  for the SUB-LLM endpoint (typically `routing.extract`), which may be
   *  different from the main endpoint. Caller resolves this via api.ts
   *  `resolveDescribeRoute` and threads it in so multimodal-finalization
   *  doesn't reach back into config / provider resolution. */
  describeAdapter: (params: {
    images: DescribeImageInput[]
  }) => Promise<{ text: string; model?: string }>
  /** Endpoint × upstreamModel of the SUB-LLM (describe) call, for batch-size
   *  cache keying. NOT the main endpoint. */
  describeEndpoint: string
  describeUpstreamModel: string
  /** Optional abort signal threaded into describeImage retries. */
  signal?: AbortSignal
}

/** Walk every message and finalize image blocks inside `tool_result.content`
 *  arrays so the destination provider can accept the request:
 *
 *    - Anthropic + image cache !== false → keep image blocks unchanged
 *      (Anthropic accepts image inside tool_result and Claude vision
 *      handles them directly).
 *    - Anthropic + image cache === false → replace via describeImagesAdaptive
 *      (sub-LLM describes, image blocks become text blocks).
 *    - OpenAI / OpenAI-auth (any cache state) → replace via
 *      describeImagesAdaptive (provider doesn't accept multimodal in tool
 *      messages).
 *
 *  Top-level image blocks in user messages (user-attached attachments
 *  from a channel) are NOT touched here — the channel runner's
 *  encode-attachments-for-inline path already gates those upstream. The
 *  finalization here is strictly tool_result.content scope.
 *
 *  Returns a NEW messages array (does not mutate the input). */
export async function finalizeToolResultImageBlocks(
  messages: ApiMessage[],
  ctx: FinalizationContext,
): Promise<ApiMessage[]> {
  // Fast-path: scan once to see if any image blocks exist inside any
  // tool_result.content array. Skip the work otherwise.
  const hasAny = messages.some(message => {
    if (message.role !== 'user' || !Array.isArray(message.content)) return false
    return message.content.some(
      (block: unknown) =>
        isToolResultBlock(block)
        && Array.isArray(block.content)
        && block.content.some(inner => isImageBlock(inner)),
    )
  })
  if (!hasAny) {
    return messages
  }

  const supportsImageInTr = providerSupportsImageInToolResult(ctx.provider.name)
  let cacheVerdict: AttachmentCapability | null = null
  if (supportsImageInTr) {
    const declared = ctx.provider.capabilities.attachments.image
    cacheVerdict = readCachedCapability({
      endpoint: ctx.endpoint,
      upstreamModel: ctx.upstreamModel,
      kind: 'image',
      declared,
    })
  }
  const shouldReplace = !supportsImageInTr || cacheVerdict === false
  if (!shouldReplace) {
    return messages
  }

  // Build a copy of messages with image blocks replaced. Each tool_result
  // is processed independently — we do NOT batch images across separate
  // tool_results, since each tool_result represents a distinct tool call
  // and merging descriptions across them would lose attribution.
  const out: ApiMessage[] = []
  for (const message of messages) {
    if (message.role !== 'user' || !Array.isArray(message.content)) {
      out.push(message)
      continue
    }
    const newContent: unknown[] = []
    let mutated = false
    for (const block of message.content) {
      if (!isToolResultBlock(block) || !Array.isArray(block.content)) {
        newContent.push(block)
        continue
      }
      const innerImages = block.content.filter(isImageBlock)
      if (innerImages.length === 0) {
        newContent.push(block)
        continue
      }
      mutated = true
      const replacedInner = await replaceImageBlocksWithDescribeText(
        block.content,
        ctx,
      )
      const newBlock: UserToolResultBlock = {
        ...block,
        content: replacedInner,
      }
      newContent.push(newBlock)
    }
    if (mutated) {
      out.push({ ...message, content: newContent })
    } else {
      out.push(message)
    }
  }
  return out
}

async function replaceImageBlocksWithDescribeText(
  blocks: ToolResultContentBlock[],
  ctx: FinalizationContext,
): Promise<ToolResultContentBlock[]> {
  // Group consecutive image blocks for batched describeImagesAdaptive
  // calls. Mixed sequences like [text, image, image, text, image] split
  // into two adjacent describe calls (one for [image, image], one for
  // [image]); the resulting text replaces the image segments in-place.
  const out: ToolResultContentBlock[] = []
  let pending: Array<{ block: ToolResultContentBlock & { type: 'image' }; idx: number }> = []

  async function flushPending() {
    if (pending.length === 0) return
    const images: DescribeImageInput[] = pending.map(p => ({
      buffer: Buffer.from(p.block.source.data, 'base64'),
      mimeType: p.block.source.mediaType,
    }))
    try {
      const result = await describeImagesAdaptive({
        images,
        endpoint: ctx.describeEndpoint,
        upstreamModel: ctx.describeUpstreamModel,
        call: ({ images: batch }) =>
          ctx.describeAdapter({ images: batch }),
      })
      const joined = joinSegmentsForLLM(result.segments, {
        sourceLabel: 'tool image',
      })
      const replacement: ToolResultTextBlock = {
        type: 'text',
        text: joined.length > 0
          ? `[Vision sub-LLM description, ${pending.length} image${pending.length === 1 ? '' : 's'}]\n${joined}`
          : `[Vision sub-LLM produced no description for ${pending.length} image${pending.length === 1 ? '' : 's'}]`,
      }
      out.push(replacement)
      if (result.trace.length > 0) {
        for (const line of result.trace) {
          process.stderr.write(`${line}\n`)
        }
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      out.push({
        type: 'text',
        text: `[Vision sub-LLM describe failed for ${pending.length} image${pending.length === 1 ? '' : 's'}: ${detail}]`,
      })
    }
    pending = []
  }

  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i]
    if (isImageBlock(block)) {
      pending.push({ block, idx: i })
      continue
    }
    await flushPending()
    out.push(block)
  }
  await flushPending()
  return out
}

function isImageBlock(
  block: unknown,
): block is ToolResultContentBlock & { type: 'image' } {
  if (!block || typeof block !== 'object') return false
  const rec = block as Record<string, unknown>
  if (rec.type !== 'image') return false
  const source = rec.source as Record<string, unknown> | undefined
  if (!source || source.type !== 'base64') return false
  return typeof source.mediaType === 'string' && typeof source.data === 'string'
}

function isToolResultBlock(block: unknown): block is UserToolResultBlock {
  if (!block || typeof block !== 'object') return false
  const rec = block as Record<string, unknown>
  return rec.type === 'tool_result'
}
