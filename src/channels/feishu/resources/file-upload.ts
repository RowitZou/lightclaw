import type { FeishuClient } from '../client.js'
import { withFileUploadTimeout } from '../client.js'
import { callFeishu, type FeishuEnvelope } from './api.js'
import { logFeishuRetry } from './errors.js'
import { withFeishuRetry } from './retry.js'

// Feishu drive `upload_all` accepts files up to 20 MB; bigger files must use
// the chunked upload trio (`upload_prepare` → `upload_part` × N → `upload_finish`).
// Per the SDK docstring (and Feishu open platform docs):
//   - upload_all: ≤ 20 MB single-shot.
//   - chunked:   block size fixed at 4 MB per upload_prepare's response.
// We hold the single-shot ceiling at 19 MB for safety margin (multipart
// envelope overhead + retry headroom). SendFile's IM path already covers
// ≤ 30 MB via `im.v1.files.create`, so the >30 MB fallback always lands in
// the chunked branch — uploadAll here is dead code in the current call site
// but kept for future callers that might land in the 1–19 MB window.
const UPLOAD_ALL_MAX_BYTES = 19 * 1024 * 1024

// First-attempt budget for the entire chunked upload pipeline. Each retry
// re-enters withFileUploadTimeout via `withFeishuRetry`. A 50 MB PDF over a
// flaky proxy with 5 chunks at 4 MB each typically completes well within 5
// minutes; matching the IM upload first-attempt budget keeps the operator
// mental model "≈5 min then fail-fast on retries" uniform.
const UPLOAD_FIRST_ATTEMPT_TIMEOUT_MS = 5 * 60_000
const UPLOAD_RETRY_TIMEOUT_MS = 30_000

export type UploadDriveFileInput = {
  client: FeishuClient
  parentFolderToken: string
  name: string
  content: Buffer
}

export type UploadDriveFileResult = {
  fileToken: string
  size: number
  chunks: number
}

export async function uploadDriveFile(input: UploadDriveFileInput): Promise<UploadDriveFileResult> {
  const size = input.content.byteLength
  if (size <= 0) {
    throw new Error('uploadDriveFile refused an empty buffer.')
  }
  if (size <= UPLOAD_ALL_MAX_BYTES) {
    const token = await uploadSingleShot(input, size)
    return { fileToken: token, size, chunks: 1 }
  }
  return uploadChunked(input, size)
}

async function uploadSingleShot(input: UploadDriveFileInput, size: number): Promise<string> {
  const client = input.client as unknown as FeishuFileClient
  const response = await retryWithUploadBudget('file.uploadAll', () => callFeishu(() => client.drive.v1.file.uploadAll({
    data: {
      file_name: input.name,
      parent_type: 'explorer',
      parent_node: input.parentFolderToken,
      size,
      file: input.content,
    },
  })))
  const fileToken = readNestedString(response.data, ['file_token'])
  if (!fileToken) {
    throw new Error('Feishu file.uploadAll response did not include file_token.')
  }
  return fileToken
}

async function uploadChunked(input: UploadDriveFileInput, size: number): Promise<UploadDriveFileResult> {
  const client = input.client as unknown as FeishuFileClient
  const prepared = await retryWithUploadBudget('file.uploadPrepare', () => callFeishu(() => client.drive.v1.file.uploadPrepare({
    data: {
      file_name: input.name,
      parent_type: 'explorer',
      parent_node: input.parentFolderToken,
      size,
    },
  })))
  const uploadId = readNestedString(prepared.data, ['upload_id'])
  const blockSize = readNumber(prepared.data, ['block_size'])
  const blockNum = readNumber(prepared.data, ['block_num'])
  if (!uploadId || !blockSize || !blockNum) {
    throw new Error(
      `Feishu file.uploadPrepare response missing upload_id/block_size/block_num (got ${JSON.stringify(prepared.data)}).`,
    )
  }
  // Sanity: blockNum * blockSize covers size, last chunk can be short.
  for (let seq = 0; seq < blockNum; seq += 1) {
    const start = seq * blockSize
    const end = Math.min(start + blockSize, size)
    const chunk = input.content.subarray(start, end)
    await retryWithUploadBudget(`file.uploadPart#${seq}`, () => callFeishu(() => client.drive.v1.file.uploadPart({
      data: {
        upload_id: uploadId,
        seq,
        size: chunk.byteLength,
        file: chunk,
      },
    })))
  }
  const finished = await retryWithUploadBudget('file.uploadFinish', () => callFeishu(() => client.drive.v1.file.uploadFinish({
    data: {
      upload_id: uploadId,
      block_num: blockNum,
    },
  })))
  const fileToken = readNestedString(finished.data, ['file_token'])
  if (!fileToken) {
    throw new Error('Feishu file.uploadFinish response did not include file_token.')
  }
  return { fileToken, size, chunks: blockNum }
}

// Retry budget mirrors sender.uploadFile (IM attachments): first attempt
// gets the long 5-minute window, retries fail-fast within 30 s — by the time
// we're retrying, we already know the link is degraded and a second long
// stall is wasted wall time. `withFeishuRetry` doesn't pass attempt to the
// callable, so we track it via a closure-mutable counter.
async function retryWithUploadBudget<T extends FeishuEnvelope>(
  label: string,
  call: () => Promise<T>,
): Promise<T> {
  let attempt = 0
  return withFeishuRetry(() => {
    attempt += 1
    const budget = attempt === 1 ? UPLOAD_FIRST_ATTEMPT_TIMEOUT_MS : UPLOAD_RETRY_TIMEOUT_MS
    return withFileUploadTimeout(budget, call)
  }, { onRetry: (c, n, delayMs) => logFeishuRetry(c, n, delayMs, label) })
}

function readNestedString(input: unknown, path: string[]): string | undefined {
  let cur = input
  for (const key of path) {
    if (!cur || typeof cur !== 'object' || !(key in cur)) {
      return undefined
    }
    cur = (cur as Record<string, unknown>)[key]
  }
  return typeof cur === 'string' && cur.length > 0 ? cur : undefined
}

function readNumber(input: unknown, path: string[]): number | undefined {
  let cur = input
  for (const key of path) {
    if (!cur || typeof cur !== 'object' || !(key in cur)) {
      return undefined
    }
    cur = (cur as Record<string, unknown>)[key]
  }
  if (typeof cur === 'number' && Number.isFinite(cur)) return cur
  if (typeof cur === 'string') {
    const n = Number.parseInt(cur, 10)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

type FeishuFileClient = {
  drive: {
    v1: {
      file: {
        uploadAll(input: unknown): Promise<FeishuEnvelope>
        uploadPrepare(input: unknown): Promise<FeishuEnvelope>
        uploadPart(input: unknown): Promise<FeishuEnvelope>
        uploadFinish(input: unknown): Promise<FeishuEnvelope>
      }
    }
  }
}
