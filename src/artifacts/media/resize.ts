import { randomUUID } from 'node:crypto'
import path from 'node:path'

import type { RuntimeFs } from '../../runtime/types.js'

const DEFAULT_TARGET_BYTES = 5 * 1024 * 1024
const MIN_DIMENSION = 64

const RESIZE_SCRIPT = String.raw`
import os
import sys

target_bytes = int(os.environ["LIGHTCLAW_RESIZE_TARGET_BYTES"])
in_path = os.environ["LIGHTCLAW_RESIZE_IN"]
out_path = os.environ["LIGHTCLAW_RESIZE_OUT"]

try:
    from PIL import Image
except ImportError:
    sys.stderr.write("Pillow is not installed in this runtime.")
    sys.exit(127)

img = Image.open(in_path)
if img.mode in ("RGBA", "P", "LA"):
    img = img.convert("RGB")

best_size = None
best_path = None
qualities = (85, 70, 50)

# Strategy: at each scale step (1.0, 0.5, 0.25, 0.125, 0.0625), try descending
# JPEG quality. Stop as soon as the encoded size fits target_bytes. Same shape
# as Hermes vision_tools._resize_image_for_vision but written for OOMing on
# huge inputs is OK — the caller already has a 100MB cap upstream.

for attempt in range(5):
    if attempt == 0:
        candidate = img
    else:
        scale = 0.5 ** attempt
        new_w = max(int(img.width * scale), 64)
        new_h = max(int(img.height * scale), 64)
        if new_w == ${MIN_DIMENSION} and img.width > 0:
            new_h = max(int(img.height * (${MIN_DIMENSION} / img.width)), 64)
        elif new_h == ${MIN_DIMENSION} and img.height > 0:
            new_w = max(int(img.width * (${MIN_DIMENSION} / img.height)), 64)
        candidate = img.resize((new_w, new_h), Image.LANCZOS)

    for quality in qualities:
        candidate.save(out_path, format="JPEG", quality=quality, optimize=True)
        size = os.path.getsize(out_path)
        if best_size is None or size < best_size:
            best_size = size
        if size <= target_bytes:
            sys.stdout.write(
                f"{candidate.width}x{candidate.height}@q{quality}={size}"
            )
            sys.exit(0)

# Fall through: best effort still over budget. Caller decides whether to
# accept or fail.
sys.stdout.write(f"{candidate.width}x{candidate.height}@q50={best_size}")
sys.exit(2)
`

export type ResizeResult = {
  buffer: Buffer
  mimeType: string
  resized: boolean
  finalSizeBytes: number
  warnings: string[]
}

/** Reactive resize for vision-API submission. Pass the sandbox-side input
 *  path; if the file is already under target_bytes, the original buffer is
 *  returned unchanged. Otherwise sandbox python with Pillow performs a
 *  Hermes-style halve-dim + quality 85→70→50 search, writes the smallest
 *  acceptable JPEG to a temporary path, the runtime reads it back, and the
 *  caller cleans up. Pillow missing surfaces as a clear "install Pillow"
 *  warning rather than a generic exec failure. */
export async function resizeImageForVision(input: {
  filePath: string
  fs: RuntimeFs
  workspaceRoot: string
  exec: (params: {
    command: string
    env?: Record<string, string>
    timeoutMs?: number
    maxBufferBytes?: number
  }) => Promise<{ stdout: string; stderr: string; exitCode: number }>
  targetBytes?: number
}): Promise<ResizeResult> {
  const targetBytes = input.targetBytes ?? DEFAULT_TARGET_BYTES
  const stat = await input.fs.stat(input.filePath)
  if (stat.size <= targetBytes) {
    const buffer = await input.fs.readFile(input.filePath)
    return {
      buffer,
      mimeType: detectMimeFromExtension(input.filePath),
      resized: false,
      finalSizeBytes: buffer.length,
      warnings: [],
    }
  }

  const outPath = path.posix.join(
    input.workspaceRoot,
    '.lightclaw',
    'tmp',
    'resize',
    `${randomUUID()}.jpg`,
  )

  try {
    const result = await input.exec({
      command:
        'mkdir -p "$(dirname "$LIGHTCLAW_RESIZE_OUT")" && ' +
        'python3 -c "$LIGHTCLAW_RESIZE_SCRIPT"',
      env: {
        LIGHTCLAW_RESIZE_IN: input.filePath,
        LIGHTCLAW_RESIZE_OUT: outPath,
        LIGHTCLAW_RESIZE_TARGET_BYTES: String(targetBytes),
        LIGHTCLAW_RESIZE_SCRIPT: RESIZE_SCRIPT,
      },
      timeoutMs: 60_000,
      maxBufferBytes: 64 * 1024,
    })

    if (result.exitCode === 127) {
      // Pillow missing — return original buffer with a warning so the caller
      // can still attempt vision submission (provider may accept it even at
      // full size).
      const buffer = await input.fs.readFile(input.filePath)
      return {
        buffer,
        mimeType: detectMimeFromExtension(input.filePath),
        resized: false,
        finalSizeBytes: buffer.length,
        warnings: [
          'Pillow is not installed in this runtime; submitting full-size image to the vision provider. ' +
            'Install Pillow (pip install Pillow) to enable auto-resize.',
        ],
      }
    }

    const reachedTarget = result.exitCode === 0
    if (!reachedTarget && result.exitCode !== 2) {
      const buffer = await input.fs.readFile(input.filePath)
      return {
        buffer,
        mimeType: detectMimeFromExtension(input.filePath),
        resized: false,
        finalSizeBytes: buffer.length,
        warnings: [
          `Pillow resize failed (exit ${result.exitCode}); submitting full-size image. ${result.stderr.trim()}`.trim(),
        ],
      }
    }

    const resizedBuffer = await input.fs.readFile(outPath)
    return {
      buffer: resizedBuffer,
      mimeType: 'image/jpeg',
      resized: true,
      finalSizeBytes: resizedBuffer.length,
      warnings: reachedTarget
        ? []
        : [
            `Pillow resize could not fit under ${targetBytes} bytes; submitting best-effort ${resizedBuffer.length}-byte JPEG.`,
          ],
    }
  } finally {
    // Best-effort cleanup; the inbox-aging sweep will pick up stragglers.
    await input.exec({
      command: 'rm -f "$LIGHTCLAW_RESIZE_OUT"',
      env: { LIGHTCLAW_RESIZE_OUT: outPath },
      timeoutMs: 5_000,
      maxBufferBytes: 1024,
    }).catch(() => undefined)
  }
}

function detectMimeFromExtension(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.webp') return 'image/webp'
  return 'image/jpeg'
}
