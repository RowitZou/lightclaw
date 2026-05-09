import { truncate } from './common.js'
import type { ArtifactExtractionInput, ArtifactExtractionResult, ArtifactExtractor } from './types.js'

/** python-pptx based extraction. Walks slides in order, emits "=== Slide N ==="
 *  separators, then text from every shape with a text frame (titles, bullets,
 *  table cells), then optional speaker notes prefixed with "[Notes:".
 *  Failure modes:
 *    127 → python missing
 *    1   → python-pptx missing
 *    2   → file not a valid OOXML zip */
const PPTX_SCRIPT = String.raw`
import json
import os
import sys

path = os.environ["LIGHTCLAW_EXTRACT_PATH"]

try:
    from pptx import Presentation
except ImportError:
    sys.stderr.write("python-pptx is not installed in this runtime. Install with: pip install python-pptx")
    sys.exit(1)

try:
    prs = Presentation(path)
except Exception as exc:
    sys.stderr.write(f"PPTX file is not a valid OOXML archive: {exc}")
    sys.exit(2)

lines = []
slide_count = 0
shape_count = 0
table_count = 0
image_count = 0

def shape_text(shape):
    """Return text content from a shape, or empty string."""
    parts = []
    if shape.has_text_frame:
        for paragraph in shape.text_frame.paragraphs:
            text = "".join(run.text for run in paragraph.runs).strip()
            if text:
                parts.append(text)
    return "\n".join(parts)

for slide_idx, slide in enumerate(prs.slides, start=1):
    slide_count += 1
    title = ""
    if slide.shapes.title is not None:
        title = (slide.shapes.title.text or "").strip()
    header = f"=== Slide {slide_idx}"
    if title and title not in (s.text.strip() for s in slide.shapes if s.has_text_frame and s != slide.shapes.title):
        header += f": {title}"
    header += " ==="
    lines.append(header)

    for shape in slide.shapes:
        shape_count += 1
        if shape == slide.shapes.title:
            continue
        if shape.shape_type == 13:  # MSO_SHAPE_TYPE.PICTURE
            image_count += 1
            continue
        if shape.has_table:
            table_count += 1
            tbl = shape.table
            rows = []
            for row in tbl.rows:
                row_cells = []
                for cell in row.cells:
                    cell_text = (cell.text or "").strip().replace("\n", " ").replace("|", "\\|")
                    row_cells.append(cell_text)
                rows.append(row_cells)
            if rows:
                col_count = max(len(r) for r in rows)
                rows = [r + [""] * (col_count - len(r)) for r in rows]
                lines.append("| " + " | ".join(rows[0]) + " |")
                lines.append("| " + " | ".join(["---"] * col_count) + " |")
                for r in rows[1:]:
                    lines.append("| " + " | ".join(r) + " |")
            continue
        text = shape_text(shape)
        if text:
            lines.append(text)

    # Speaker notes (best-effort)
    if slide.has_notes_slide:
        notes = (slide.notes_slide.notes_text_frame.text or "").strip()
        if notes:
            lines.append(f"[Notes: {notes}]")

    lines.append("")  # blank line between slides

sys.stdout.write(json.dumps({
    "text": "\n".join(lines).rstrip() + "\n",
    "slideCount": slide_count,
    "shapeCount": shape_count,
    "tableCount": table_count,
    "imageCount": image_count,
}, ensure_ascii=False))
`

export const pptxExtractor: ArtifactExtractor = {
  format: 'pptx',
  async extract(input: ArtifactExtractionInput): Promise<ArtifactExtractionResult> {
    if (!input.exec) {
      return unsupportedPptx('PPTX extraction requires a runtime command executor.')
    }
    const result = await input.exec({
      command: 'python3 -c "$LIGHTCLAW_EXTRACT_SCRIPT"',
      env: {
        LIGHTCLAW_EXTRACT_PATH: input.filePath,
        LIGHTCLAW_EXTRACT_SCRIPT: PPTX_SCRIPT,
      },
      timeoutMs: 30_000,
      maxBufferBytes: Math.max(input.maxChars * 4, 64 * 1024),
    })
    if (result.exitCode === 127) {
      return unsupportedPptx('python3 is not installed in this runtime.')
    }
    if (result.exitCode === 1) {
      return unsupportedPptx(
        result.stderr.trim() || 'python-pptx is not installed in this runtime. Install with: pip install python-pptx',
      )
    }
    if (result.exitCode === 2) {
      return unsupportedPptx(
        result.stderr.trim() ||
          'File is not a valid .pptx (OOXML zip). Legacy .ppt files must be saved as .pptx first.',
      )
    }
    if (result.exitCode !== 0) {
      return unsupportedPptx(result.stderr.trim() || 'PPTX extraction failed.')
    }
    try {
      const parsed = JSON.parse(result.stdout) as {
        text?: string
        slideCount?: number
        shapeCount?: number
        tableCount?: number
        imageCount?: number
      }
      const { value, truncated } = truncate(parsed.text ?? '', input.maxChars)
      return {
        format: 'pptx',
        text: value,
        truncated,
        warnings: parsed.text ? [] : ['PPTX extraction returned no slide text.'],
        metadata: {
          extractor: 'python-pptx',
          slideCount: parsed.slideCount,
          shapeCount: parsed.shapeCount,
          tableCount: parsed.tableCount,
          imageCount: parsed.imageCount,
        },
      }
    } catch {
      return unsupportedPptx('PPTX extraction returned invalid JSON.')
    }
  },
}

function unsupportedPptx(reason: string): ArtifactExtractionResult {
  return {
    format: 'pptx',
    text: '',
    truncated: false,
    warnings: [reason],
  }
}
