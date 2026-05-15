import {
  isBatchTooBigError,
  readBatchCeiling,
  recordBatchCeiling,
} from './batch-size-cache.js'
import type {
  DescribeImageInput,
  DescribeImageParams,
  DescribeImageResult,
} from './types.js'

/** Per-image describe outcome. `text` carries the sub-LLM description
 *  for the page range; `pageStart` / `pageEnd` are 1-based indices into
 *  the original `images[]` input passed to `describeImagesAdaptive`. The
 *  `failed` flag is set when adaptive shrinking reduced batch size to 1
 *  and that single image still failed — the caller decides whether to
 *  surface the failure marker to the agent or fail the whole tool. */
export type DescribeAdaptiveSegment = {
  pageStart: number
  pageEnd: number
  text: string
  failed?: true
}

export type DescribeAdaptiveResult = {
  segments: DescribeAdaptiveSegment[]
  /** Stderr breadcrumbs ("[describe] batch 15 failed → halve to [8, 7]")
   *  collected during adaptive shrinking. The api-logs layer doesn't see
   *  these because the inner describeImage calls already log themselves;
   *  this list exists for callers that want to surface adaptation history
   *  to the user / dogfood operator. */
  trace: string[]
}

type Adapter = (params: {
  images: DescribeImageInput[]
}) => Promise<DescribeImageResult>

/** Adaptive describeImage wrapper that recursively halves the batch on
 *  size-class errors (413 / 400 image_count_exceeded / context window
 *  full / prompt too long), with an idempotent per-endpoint cache of the
 *  highest known successful batch size.
 *
 *  Behavior:
 *    1. Read cached ceiling for (endpoint × upstreamModel × kind).
 *    2. Initial chunk size = min(images.length, ceiling ?? images.length).
 *    3. Split images into chunks of that size; describeImage each chunk
 *       concurrently (Promise.all). Successes update the ceiling.
 *    4. If a chunk fails with isBatchTooBigError, recursively halve and
 *       retry the two halves (concurrent).
 *    5. If a halving reaches a single image that still fails, mark that
 *       segment with `failed: true` and emit a placeholder describe text
 *       — sibling images keep their successful descriptions. */
export async function describeImagesAdaptive(input: {
  images: DescribeImageInput[]
  endpoint: string
  baseUrl: string | undefined
  upstreamModel: string
  call: (params: { images: DescribeImageInput[] }) => Promise<DescribeImageResult>
}): Promise<DescribeAdaptiveResult> {
  const { images, endpoint, baseUrl, upstreamModel } = input
  if (images.length === 0) {
    return { segments: [], trace: [] }
  }

  const trace: string[] = []
  const segments: DescribeAdaptiveSegment[] = []

  const cachedCeiling = readBatchCeiling({
    endpoint,
    baseUrl,
    upstreamModel,
    kind: 'image',
  })
  const initialBatch = Math.min(
    images.length,
    cachedCeiling && cachedCeiling > 0 ? cachedCeiling : images.length,
  )

  // First pass: split into chunks of `initialBatch` size.
  const chunks: Array<{ start: number; images: DescribeImageInput[] }> = []
  for (let i = 0; i < images.length; i += initialBatch) {
    chunks.push({ start: i, images: images.slice(i, i + initialBatch) })
  }

  // Only record a new ceiling when we LEARNED something from this call —
  // i.e. halving was triggered. A first-try success on N images doesn't
  // tell us anything about the true endpoint cap (we never tried bigger),
  // so silently caching N would cause subsequent N+1 batches to split
  // unnecessarily. The recordBatchCeiling call is monotonic, so existing
  // ceilings are never lowered by a smaller success.
  const observation = { halvedAtLeastOnce: false }

  await Promise.all(
    chunks.map(async chunk => {
      const result = await runChunkWithHalving({
        chunk: chunk.images,
        startIndex: chunk.start,
        adapter: input.call,
        trace,
        observation,
      })
      segments.push(...result)
    }),
  )

  // Order segments by pageStart for deterministic output.
  segments.sort((a, b) => a.pageStart - b.pageStart)

  if (observation.halvedAtLeastOnce) {
    const maxSuccessfulSpan = segments
      .filter(seg => !seg.failed)
      .reduce(
        (max, seg) => Math.max(max, seg.pageEnd - seg.pageStart + 1),
        0,
      )
    if (maxSuccessfulSpan > 0) {
      recordBatchCeiling({
        endpoint,
        baseUrl,
        upstreamModel,
        kind: 'image',
        size: maxSuccessfulSpan,
      })
    }
  }

  return { segments, trace }
}

async function runChunkWithHalving(args: {
  chunk: DescribeImageInput[]
  startIndex: number   // 0-based offset of chunk[0] within original images[]
  adapter: Adapter
  trace: string[]
  observation: { halvedAtLeastOnce: boolean }
}): Promise<DescribeAdaptiveSegment[]> {
  const { chunk, startIndex, adapter, trace, observation } = args
  if (chunk.length === 0) return []

  try {
    const result = await adapter({ images: chunk })
    return [
      {
        pageStart: startIndex + 1,
        pageEnd: startIndex + chunk.length,
        text: result.text,
      },
    ]
  } catch (error) {
    if (!isBatchTooBigError(error)) {
      // Non-size-class failure: propagate so the caller can decide
      // (transient retry / surface to agent / abort).
      throw error
    }
    if (chunk.length === 1) {
      // Single image still rejected with a size signal — likely the image
      // itself is unsupported / too high resolution. Emit a placeholder
      // and let the caller decide whether to fail the whole tool.
      const detail = error instanceof Error ? error.message : String(error)
      trace.push(
        `[describe] single-image batch ${startIndex + 1} failed: ${detail}`,
      )
      return [
        {
          pageStart: startIndex + 1,
          pageEnd: startIndex + 1,
          text: `[Image ${startIndex + 1} description failed: ${detail}]`,
          failed: true,
        },
      ]
    }

    // Halve and retry. Floor / ceil split keeps both halves non-empty
    // even at length 2 (→ [1, 1]).
    observation.halvedAtLeastOnce = true
    const mid = Math.ceil(chunk.length / 2)
    const left = chunk.slice(0, mid)
    const right = chunk.slice(mid)
    trace.push(
      `[describe] batch size ${chunk.length} (offset ${startIndex}) failed → halve to [${left.length}, ${right.length}]`,
    )
    const [leftResult, rightResult] = await Promise.all([
      runChunkWithHalving({
        chunk: left,
        startIndex,
        adapter,
        trace,
        observation,
      }),
      runChunkWithHalving({
        chunk: right,
        startIndex: startIndex + mid,
        adapter,
        trace,
        observation,
      }),
    ])
    return [...leftResult, ...rightResult]
  }
}

/** Convenience: collapse multiple describe segments into a single text
 *  block for tools that want one combined description (e.g. PDF page
 *  range). Multi-batch calls render with explicit page-range markers so
 *  the consumer model can map descriptions back to source pages. */
export function joinSegmentsForLLM(
  segments: DescribeAdaptiveSegment[],
  options?: { sourceLabel?: string },
): string {
  if (segments.length === 0) return ''
  if (segments.length === 1) return segments[0].text
  const label = options?.sourceLabel
  return segments
    .map(seg => {
      const range = seg.pageStart === seg.pageEnd
        ? `image ${seg.pageStart}`
        : `images ${seg.pageStart}-${seg.pageEnd}`
      const header = label
        ? `[${label}, ${range}]`
        : `[${range}]`
      return `${header}\n${seg.text}`
    })
    .join('\n\n')
}

/** Adapter helper: build a `DescribeImageParams` shape from per-call
 *  context plus the chunk-time `images` list. Used by the multimodal
 *  finalization pass. */
export type DescribeAdaptiveCallContext = Omit<DescribeImageParams, 'images' | 'image'>
