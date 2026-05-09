import { truncate } from './common.js'
import type { ArtifactExtractionInput, ArtifactExtractionResult, ArtifactExtractor } from './types.js'

/** python-docx based extraction. Captures paragraphs (with heading style),
 *  tables (rendered as markdown tables for LLM friendliness), and counts of
 *  images for context. Failure modes:
 *    127 → python missing
 *    1   → python-docx missing (re-emitted as "Install python-docx")
 *    2   → file not a valid OOXML zip (legacy .doc — caller fallback) */
const DOCX_SCRIPT = String.raw`
import json
import os
import sys

path = os.environ["LIGHTCLAW_EXTRACT_PATH"]

try:
    from docx import Document
except ImportError:
    sys.stderr.write("python-docx is not installed in this runtime. Install with: pip install python-docx")
    sys.exit(1)

try:
    doc = Document(path)
except Exception as exc:
    sys.stderr.write(f"DOCX file is not a valid OOXML archive: {exc}")
    sys.exit(2)

lines = []
table_count = 0
image_count = 0

# python-docx exposes block-level items in document order via doc.element.body
# but the public API splits them into paragraphs / tables flat lists. To keep
# document order, walk doc.element.body children and dispatch.
from docx.oxml.ns import qn

para_count = 0
for child in doc.element.body.iterchildren():
    if child.tag == qn("w:p"):
        para_count += 1
        # Find the python-docx Paragraph wrapper for this XML node
        para = next((p for p in doc.paragraphs if p._element is child), None)
        if para is None:
            continue
        text = para.text.strip()
        if not text:
            continue
        style = (para.style.name or "") if para.style else ""
        if style.startswith("Heading"):
            level = 1
            try:
                level = int(style.replace("Heading", "").strip() or "1")
            except ValueError:
                level = 1
            level = max(1, min(level, 6))
            lines.append("#" * level + " " + text)
        elif style == "Title":
            lines.append("# " + text)
        else:
            lines.append(text)
    elif child.tag == qn("w:tbl"):
        table_count += 1
        tbl = next((t for t in doc.tables if t._element is child), None)
        if tbl is None:
            continue
        rows = [
            ["" if cell.text is None else cell.text.strip().replace("\n", " ").replace("|", "\\|")
             for cell in row.cells]
            for row in tbl.rows
        ]
        if not rows:
            continue
        # Markdown table: header row + separator + body rows
        col_count = max(len(r) for r in rows)
        rows = [r + [""] * (col_count - len(r)) for r in rows]
        lines.append("| " + " | ".join(rows[0]) + " |")
        lines.append("| " + " | ".join(["---"] * col_count) + " |")
        for r in rows[1:]:
            lines.append("| " + " | ".join(r) + " |")
        lines.append("")

# Count inline images via doc.inline_shapes (best-effort metadata only).
try:
    image_count = len(doc.inline_shapes)
except Exception:
    pass

sys.stdout.write(json.dumps({
    "text": "\n".join(lines),
    "paragraphCount": para_count,
    "tableCount": table_count,
    "imageCount": image_count,
}, ensure_ascii=False))
`

export const docxExtractor: ArtifactExtractor = {
  format: 'docx',
  async extract(input: ArtifactExtractionInput): Promise<ArtifactExtractionResult> {
    if (!input.exec) {
      return unsupportedDocx('DOCX extraction requires a runtime command executor.')
    }
    const result = await input.exec({
      command: 'python3 -c "$LIGHTCLAW_EXTRACT_SCRIPT"',
      env: {
        LIGHTCLAW_EXTRACT_PATH: input.filePath,
        LIGHTCLAW_EXTRACT_SCRIPT: DOCX_SCRIPT,
      },
      timeoutMs: 30_000,
      maxBufferBytes: Math.max(input.maxChars * 4, 64 * 1024),
    })
    if (result.exitCode === 127) {
      return unsupportedDocx('python3 is not installed in this runtime.')
    }
    if (result.exitCode === 1) {
      return unsupportedDocx(
        result.stderr.trim() || 'python-docx is not installed in this runtime. Install with: pip install python-docx',
      )
    }
    if (result.exitCode === 2) {
      return unsupportedDocx(
        result.stderr.trim() ||
          'File is not a valid .docx (OOXML zip). Legacy .doc files must be saved as .docx first.',
      )
    }
    if (result.exitCode !== 0) {
      return unsupportedDocx(result.stderr.trim() || 'DOCX extraction failed.')
    }
    try {
      const parsed = JSON.parse(result.stdout) as {
        text?: string
        paragraphCount?: number
        tableCount?: number
        imageCount?: number
      }
      const { value, truncated } = truncate(parsed.text ?? '', input.maxChars)
      return {
        format: 'docx',
        text: value,
        truncated,
        warnings: parsed.text ? [] : ['DOCX extraction returned no text.'],
        metadata: {
          extractor: 'python-docx',
          paragraphCount: parsed.paragraphCount,
          tableCount: parsed.tableCount,
          imageCount: parsed.imageCount,
        },
      }
    } catch {
      return unsupportedDocx('DOCX extraction returned invalid JSON.')
    }
  },
}

function unsupportedDocx(reason: string): ArtifactExtractionResult {
  return {
    format: 'docx',
    text: '',
    truncated: false,
    warnings: [reason],
  }
}
