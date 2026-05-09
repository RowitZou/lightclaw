import { truncate } from './common.js'
import type { ArtifactExtractionInput, ArtifactExtractionResult, ArtifactExtractor } from './types.js'

const DOCX_SCRIPT = String.raw`
import os
import sys
import zipfile
import xml.etree.ElementTree as ET

path = os.environ["LIGHTCLAW_EXTRACT_PATH"]
ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}

try:
    with zipfile.ZipFile(path) as zf:
        xml_bytes = zf.read("word/document.xml")
except KeyError:
    print("DOCX archive does not contain word/document.xml.", file=sys.stderr)
    sys.exit(2)

root = ET.fromstring(xml_bytes)
paragraphs = []
for paragraph in root.findall(".//w:p", ns):
    parts = []
    for text in paragraph.findall(".//w:t", ns):
        if text.text:
            parts.append(text.text)
    line = "".join(parts).strip()
    if line:
        paragraphs.append(line)

sys.stdout.write("\n".join(paragraphs))
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
    if (result.exitCode !== 0) {
      return unsupportedDocx(result.stderr.trim() || 'DOCX extraction failed.')
    }
    const { value, truncated } = truncate(result.stdout, input.maxChars)
    return {
      format: 'docx',
      text: value,
      truncated,
      warnings: result.stdout.trim() ? [] : ['DOCX extraction returned no text.'],
      metadata: { extractor: 'python-zipfile' },
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
