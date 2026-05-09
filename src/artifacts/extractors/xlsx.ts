import { truncate } from './common.js'
import type { ArtifactExtractionInput, ArtifactExtractionResult, ArtifactExtractor } from './types.js'

/** openpyxl-based extraction. Handles dates / merged cells / cached formula
 *  values out of the box (raw stdlib XML parsing got these all wrong). Sheet
 *  selection by name; range as A1:D20; max_rows / max_cols clamp. Returns
 *  tab-separated rows + sheet metadata.
 *  Failure modes:
 *    127 → python missing
 *    1   → openpyxl missing (re-emitted as "Install openpyxl")
 *    2   → file not a valid xlsx zip
 *    3   → sheet not found / invalid range */
const XLSX_SCRIPT = String.raw`
import json
import os
import sys
from datetime import date, datetime, time

try:
    import openpyxl
    from openpyxl.utils import range_boundaries
except ImportError:
    sys.stderr.write("openpyxl is not installed in this runtime. Install with: pip install openpyxl")
    sys.exit(1)

path = os.environ["LIGHTCLAW_EXTRACT_PATH"]
requested_sheet = os.environ.get("LIGHTCLAW_EXTRACT_SHEET", "").strip()
requested_range = os.environ.get("LIGHTCLAW_EXTRACT_RANGE", "").strip()
max_rows = int(os.environ.get("LIGHTCLAW_EXTRACT_MAX_ROWS", "50"))
max_cols = int(os.environ.get("LIGHTCLAW_EXTRACT_MAX_COLS", "20"))

try:
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
except Exception as exc:
    msg = str(exc).lower()
    if "not a zip" in msg or "bad zip" in msg or "badzipfile" in msg:
        sys.stderr.write("File is not a valid .xlsx (OOXML zip). Legacy .xls files must be saved as .xlsx first.")
        sys.exit(2)
    sys.stderr.write(f"openpyxl could not open the workbook: {exc}")
    sys.exit(2)

sheet_names = wb.sheetnames
if not sheet_names:
    sys.stderr.write("XLSX workbook has no sheets.")
    sys.exit(2)

if requested_sheet:
    if requested_sheet not in sheet_names:
        sys.stderr.write(f"Sheet not found: {requested_sheet}. Available: {', '.join(sheet_names)}")
        sys.exit(3)
    ws = wb[requested_sheet]
else:
    ws = wb[sheet_names[0]]

if requested_range:
    try:
        min_col, min_row, max_col, max_row = range_boundaries(requested_range.upper())
    except Exception:
        sys.stderr.write(f"Invalid range: {requested_range}. Use A1-style, e.g. A1:D20.")
        sys.exit(3)
else:
    min_col, min_row = 1, 1
    max_col = min_col + max_cols - 1
    max_row = min_row + max_rows - 1

def fmt_cell(v):
    if v is None:
        return ""
    if isinstance(v, datetime):
        return v.isoformat(sep=" ", timespec="seconds")
    if isinstance(v, date):
        return v.isoformat()
    if isinstance(v, time):
        return v.isoformat(timespec="seconds")
    if isinstance(v, float):
        if v.is_integer():
            return str(int(v))
        return repr(v)
    return str(v)

lines = []
rows_read = 0
cols_read = 0
truncated_rows = False
truncated_cols = False

for row_idx, row in enumerate(
    ws.iter_rows(min_row=min_row, max_row=max_row, min_col=min_col, max_col=max_col),
    start=min_row,
):
    if row_idx > min_row + max_rows - 1:
        truncated_rows = True
        break
    cells = list(row)
    if len(cells) > max_cols:
        cells = cells[:max_cols]
        truncated_cols = True
    cols_read = max(cols_read, len(cells))
    lines.append("\t".join(fmt_cell(c.value) for c in cells))
    rows_read += 1

sys.stdout.write(json.dumps({
    "text": "\n".join(lines),
    "sheet": ws.title,
    "sheets": sheet_names,
    "rowsRead": rows_read,
    "colsRead": cols_read,
    "truncated": truncated_rows or truncated_cols,
    "totalRows": ws.max_row,
    "totalCols": ws.max_column,
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
    if (result.exitCode === 1) {
      return unsupportedXlsx(
        result.stderr.trim() || 'openpyxl is not installed in this runtime. Install with: pip install openpyxl',
      )
    }
    if (result.exitCode === 2) {
      return unsupportedXlsx(
        result.stderr.trim() ||
          'File is not a valid .xlsx (OOXML zip). Legacy .xls files must be saved as .xlsx first.',
      )
    }
    if (result.exitCode === 3) {
      return unsupportedXlsx(result.stderr.trim() || 'XLSX sheet or range not found.')
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
        totalRows?: number
        totalCols?: number
      }
      const { value, truncated } = truncate(parsed.text ?? '', input.maxChars)
      return {
        format: 'xlsx',
        text: value,
        truncated: Boolean(parsed.truncated) || truncated,
        warnings: parsed.text ? [] : ['XLSX extraction returned no cell text.'],
        metadata: {
          extractor: 'openpyxl',
          sheet: parsed.sheet,
          sheets: parsed.sheets,
          rowsRead: parsed.rowsRead,
          colsRead: parsed.colsRead,
          totalRows: parsed.totalRows,
          totalCols: parsed.totalCols,
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
