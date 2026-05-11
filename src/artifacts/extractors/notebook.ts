import { stripUtf8Bom, truncate } from './common.js'
import type {
  ArtifactExtractionInput,
  ArtifactExtractionResult,
  ArtifactExtractor,
} from './types.js'

/**
 * Jupyter notebook (.ipynb) extractor — flatten cells into structured text
 * the model can read directly.
 *
 * Before this extractor existed (added in 2026-05-11 Read refactor), .ipynb
 * files fell into the generic `text` path and the agent saw raw JSON
 * (`{"cells": [{"cell_type": "code", ...}], "metadata": {...}}`). That's
 * legible to a determined model but wastes tokens on JSON framing and the
 * agent often gets confused about which "source" is markdown vs code vs
 * output. Claude Code's `FileReadTool` ships a similar flattening; this is
 * the lightclaw port.
 *
 * Output shape:
 *
 *   [Cell 1, code]
 *   import pandas as pd
 *
 *   [Cell 1 output, stream]
 *   Hello
 *
 *   [Cell 2, markdown]
 *   ## Analysis
 *
 *   [Cell 3, code]
 *   df.head()
 *
 *   [Cell 3 output, image/png]
 *   (image output, 4321 bytes — not rendered inline; use Read pages= with a
 *   PDF export if you need to see it)
 *
 * Image / display_data outputs are intentionally NOT inlined as image blocks
 * — the visual path is reserved for PDF / image files, and notebooks
 * commonly carry many figure outputs whose value to the agent is usually
 * the surrounding code, not the rendered pixels. Mark the presence as a
 * placeholder line so the model has the signal if it needs to ask.
 */
export const notebookExtractor: ArtifactExtractor = {
  format: 'notebook',
  extract(input: ArtifactExtractionInput): ArtifactExtractionResult {
    const raw = stripUtf8Bom(input.buffer.toString('utf8'))
    const warnings: string[] = []

    let parsed: NotebookJson
    try {
      parsed = JSON.parse(raw) as NotebookJson
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      warnings.push(`Notebook JSON parse failed (${detail}); returning raw text.`)
      const { value, truncated } = truncate(raw, input.maxChars)
      return {
        format: 'notebook',
        text: value,
        truncated,
        warnings,
      }
    }

    const cells = Array.isArray(parsed.cells) ? parsed.cells : []
    if (cells.length === 0) {
      warnings.push('Notebook has no cells.')
      return {
        format: 'notebook',
        text: '',
        truncated: false,
        warnings,
        metadata: {
          extractor: 'notebook',
          cellCount: 0,
          ...(parsed.metadata?.kernelspec?.name
            ? { kernel: parsed.metadata.kernelspec.name }
            : {}),
        },
      }
    }

    const parts: string[] = []
    for (const [idx, cell] of cells.entries()) {
      const cellNum = idx + 1
      const kind = cell.cell_type ?? 'unknown'
      const sourceText = joinSource(cell.source)

      parts.push(`[Cell ${cellNum}, ${kind}]`)
      parts.push(sourceText.length > 0 ? sourceText : '(empty)')

      if (kind === 'code' && Array.isArray(cell.outputs) && cell.outputs.length > 0) {
        for (const output of cell.outputs) {
          parts.push(formatOutput(cellNum, output))
        }
      }

      parts.push('')
    }

    const text = parts.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()
    const { value, truncated } = truncate(text, input.maxChars)
    return {
      format: 'notebook',
      text: value,
      truncated,
      warnings,
      metadata: {
        extractor: 'notebook',
        cellCount: cells.length,
        ...(parsed.metadata?.kernelspec?.name
          ? { kernel: parsed.metadata.kernelspec.name }
          : {}),
      },
    }
  },
}

function joinSource(source: unknown): string {
  if (typeof source === 'string') return source
  if (Array.isArray(source)) {
    return source.map(line => (typeof line === 'string' ? line : '')).join('')
  }
  return ''
}

function formatOutput(cellNum: number, output: NotebookOutput): string {
  const type = output.output_type ?? 'unknown'

  if (type === 'stream') {
    const text = joinSource(output.text)
    return [`[Cell ${cellNum} output, stream]`, text].join('\n')
  }

  if (type === 'execute_result' || type === 'display_data') {
    const data = output.data ?? {}
    // Prefer text/plain when present — that's what jupyter shows under
    // dataframes, function reprs, etc.
    if (typeof data['text/plain'] !== 'undefined') {
      const text = joinSource(data['text/plain'])
      return [`[Cell ${cellNum} output, ${type}]`, text].join('\n')
    }
    // No text fallback — the output is purely visual (image/svg/html). Note
    // it as a placeholder so the model knows there's content it can't see
    // and can decide whether to ask.
    const visualMime = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/gif']
      .find(mt => typeof data[mt] !== 'undefined')
    if (visualMime) {
      const len = String(data[visualMime] ?? '').length
      return [
        `[Cell ${cellNum} output, ${visualMime}]`,
        `(visual output, ~${len} base64 chars — not rendered inline)`,
      ].join('\n')
    }
    // Unknown shape — list available mime types.
    const keys = Object.keys(data)
    return [
      `[Cell ${cellNum} output, ${type}]`,
      `(no text/plain; available mime types: ${keys.join(', ') || 'none'})`,
    ].join('\n')
  }

  if (type === 'error') {
    const name = String(output.ename ?? 'error')
    const value = String(output.evalue ?? '')
    const traceback = Array.isArray(output.traceback)
      ? output.traceback.join('\n')
      : ''
    return [
      `[Cell ${cellNum} output, error: ${name}]`,
      value,
      ...(traceback ? [traceback] : []),
    ].join('\n')
  }

  return `[Cell ${cellNum} output, ${type}] (unrecognized output shape)`
}

interface NotebookJson {
  cells?: NotebookCell[]
  metadata?: {
    kernelspec?: { name?: string }
  }
}

interface NotebookCell {
  cell_type?: string
  source?: unknown
  outputs?: NotebookOutput[]
}

interface NotebookOutput {
  output_type?: string
  text?: unknown
  data?: Record<string, unknown>
  ename?: unknown
  evalue?: unknown
  traceback?: unknown
}
