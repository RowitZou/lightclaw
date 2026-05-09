import { truncate } from './common.js'
import type { ArtifactExtractionInput, ArtifactExtractionResult, ArtifactExtractor } from './types.js'

const XLSX_SCRIPT = String.raw`
import json
import os
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

path = os.environ["LIGHTCLAW_EXTRACT_PATH"]
requested_sheet = os.environ.get("LIGHTCLAW_EXTRACT_SHEET", "").strip()
requested_range = os.environ.get("LIGHTCLAW_EXTRACT_RANGE", "").strip()
max_rows = int(os.environ.get("LIGHTCLAW_EXTRACT_MAX_ROWS", "50"))
max_cols = int(os.environ.get("LIGHTCLAW_EXTRACT_MAX_COLS", "20"))

main_ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
rel_ns = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
pkg_rel_ns = "http://schemas.openxmlformats.org/package/2006/relationships"
ns = {"x": main_ns, "r": rel_ns, "pr": pkg_rel_ns}

def col_to_num(col):
    n = 0
    for ch in col:
        n = n * 26 + ord(ch.upper()) - 64
    return n

def cell_ref(ref):
    m = re.match(r"^([A-Z]+)([0-9]+)", ref or "")
    if not m:
        return None
    return int(m.group(2)), col_to_num(m.group(1))

def range_bounds(value):
    m = re.match(r"^([A-Z]+)([0-9]+):([A-Z]+)([0-9]+)$", value.upper())
    if not m:
        return None
    left = (int(m.group(2)), col_to_num(m.group(1)))
    right = (int(m.group(4)), col_to_num(m.group(3)))
    return min(left[0], right[0]), min(left[1], right[1]), max(left[0], right[0]), max(left[1], right[1])

def text_of(node):
    return "".join(t.text or "" for t in node.findall(".//x:t", ns))

try:
    zf = zipfile.ZipFile(path)
except zipfile.BadZipFile:
    print("XLSX file is not a valid ZIP archive.", file=sys.stderr)
    sys.exit(2)

try:
    workbook = ET.fromstring(zf.read("xl/workbook.xml"))
    rels = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
except KeyError as exc:
    print(f"XLSX archive missing {exc}.", file=sys.stderr)
    sys.exit(2)

rel_targets = {}
for rel in rels.findall("pr:Relationship", ns):
    rid = rel.attrib.get("Id")
    target = rel.attrib.get("Target")
    if rid and target:
        rel_targets[rid] = "xl/" + target.lstrip("/")

sheets = []
for sheet in workbook.findall(".//x:sheet", ns):
    name = sheet.attrib.get("name", "")
    rid = sheet.attrib.get(f"{{{rel_ns}}}id")
    if name and rid and rid in rel_targets:
        sheets.append({"name": name, "path": rel_targets[rid]})

if not sheets:
    print("XLSX workbook has no sheets.", file=sys.stderr)
    sys.exit(2)

selected = None
if requested_sheet:
    for sheet in sheets:
        if sheet["name"] == requested_sheet:
            selected = sheet
            break
    if selected is None:
        print(f"Sheet not found: {requested_sheet}", file=sys.stderr)
        sys.exit(3)
else:
    selected = sheets[0]

shared = []
try:
    shared_root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
    shared = [text_of(si) for si in shared_root.findall(".//x:si", ns)]
except KeyError:
    shared = []

bounds = range_bounds(requested_range) if requested_range else None
if requested_range and bounds is None:
    print(f"Unsupported range format: {requested_range}", file=sys.stderr)
    sys.exit(3)

sheet_root = ET.fromstring(zf.read(selected["path"]))
rows = []
max_seen_col = 0
for row in sheet_root.findall(".//x:row", ns):
    row_index = int(row.attrib.get("r", "0") or "0")
    if bounds and (row_index < bounds[0] or row_index > bounds[2]):
        continue
    values = {}
    for cell in row.findall("x:c", ns):
        ref = cell.attrib.get("r", "")
        parsed = cell_ref(ref)
        if not parsed:
            continue
        _, col_index = parsed
        if bounds and (col_index < bounds[1] or col_index > bounds[3]):
            continue
        if len(rows) >= max_rows:
            continue
        raw = cell.find("x:v", ns)
        inline = cell.find("x:is", ns)
        value = ""
        if cell.attrib.get("t") == "s" and raw is not None and raw.text:
            idx = int(raw.text)
            value = shared[idx] if 0 <= idx < len(shared) else raw.text
        elif inline is not None:
            value = text_of(inline)
        elif raw is not None and raw.text:
            value = raw.text
        values[col_index] = value
        max_seen_col = max(max_seen_col, col_index)
    if values:
        rows.append(values)
    if len(rows) >= max_rows:
        break

start_col = bounds[1] if bounds else 1
end_col = min(bounds[3] if bounds else max_seen_col, start_col + max_cols - 1)
lines = []
for row in rows:
    lines.append("\t".join(row.get(col, "") for col in range(start_col, end_col + 1)))

sys.stdout.write(json.dumps({
    "text": "\n".join(lines),
    "sheet": selected["name"],
    "sheets": [sheet["name"] for sheet in sheets],
    "rowsRead": len(rows),
    "colsRead": max(0, end_col - start_col + 1),
    "truncated": len(rows) >= max_rows,
}, ensure_ascii=False))
`

export const xlsxExtractor: ArtifactExtractor = {
  format: 'xlsx',
  async extract(input: ArtifactExtractionInput): Promise<ArtifactExtractionResult> {
    if (!input.exec) {
      return unsupportedXlsx('XLSX extraction requires a runtime command executor.')
    }
    const result = await input.exec({
      command: 'python3 -c "$LIGHTCLAW_EXTRACT_SCRIPT"',
      env: {
        LIGHTCLAW_EXTRACT_PATH: input.filePath,
        LIGHTCLAW_EXTRACT_SCRIPT: XLSX_SCRIPT,
        LIGHTCLAW_EXTRACT_SHEET: input.sheet ?? '',
        LIGHTCLAW_EXTRACT_RANGE: input.range ?? '',
        LIGHTCLAW_EXTRACT_MAX_ROWS: String(input.maxRows ?? 50),
        LIGHTCLAW_EXTRACT_MAX_COLS: String(input.maxCols ?? 20),
      },
      timeoutMs: 30_000,
      maxBufferBytes: Math.max(input.maxChars * 4, 64 * 1024),
    })
    if (result.exitCode === 127) {
      return unsupportedXlsx('python3 is not installed in this runtime.')
    }
    if (result.exitCode !== 0) {
      return unsupportedXlsx(result.stderr.trim() || 'XLSX extraction failed.')
    }
    try {
      const parsed = JSON.parse(result.stdout) as {
        text?: string
        sheet?: string
        sheets?: string[]
        rowsRead?: number
        colsRead?: number
        truncated?: boolean
      }
      const { value, truncated } = truncate(parsed.text ?? '', input.maxChars)
      return {
        format: 'xlsx',
        text: value,
        truncated: Boolean(parsed.truncated) || truncated,
        warnings: parsed.text ? [] : ['XLSX extraction returned no cell text.'],
        metadata: {
          extractor: 'python-zipfile',
          sheet: parsed.sheet,
          sheets: parsed.sheets,
          rowsRead: parsed.rowsRead,
          colsRead: parsed.colsRead,
        },
      }
    } catch {
      return unsupportedXlsx('XLSX extraction returned invalid JSON.')
    }
  },
}

function unsupportedXlsx(reason: string): ArtifactExtractionResult {
  return {
    format: 'xlsx',
    text: '',
    truncated: false,
    warnings: [reason],
  }
}
