import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { LocalRuntime } from '../runtime/local.js'
import type { ToolCallContext } from '../tool.js'

import { fileReadTool, type FileReadStructuredOutput } from './file-read.js'

let tmp: string
let runtime: LocalRuntime

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'lightclaw-file-read-'))
  runtime = new LocalRuntime(tmp)
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function context(): ToolCallContext {
  return {
    cwd: tmp,
    abortSignal: new AbortController().signal,
    runtime,
  }
}

describe('Read (legacy text path)', () => {
  it('returns line-numbered content for plain text files', async () => {
    await runtime.fs.writeFile('notes.txt', 'alpha\nbeta\ngamma')
    const result = await fileReadTool.call({ file_path: 'notes.txt' }, context())
    assert.equal(result.isError, undefined)
    assert.equal(
      result.output,
      '     1 | alpha\n     2 | beta\n     3 | gamma',
    )
  })

  it('honors offset and limit', async () => {
    await runtime.fs.writeFile('lines.txt', 'a\nb\nc\nd\ne')
    const result = await fileReadTool.call(
      { file_path: 'lines.txt', offset: 2, limit: 2 },
      context(),
    )
    assert.equal(result.output, '     2 | b\n     3 | c')
  })

  it('treats .json as plain text (line-numbered, no pretty-print)', async () => {
    await runtime.fs.writeFile('data.json', '{"ok":true}')
    const result = await fileReadTool.call({ file_path: 'data.json' }, context())
    assert.equal(result.output, '     1 | {"ok":true}')
  })
})

describe('Read (PDF text path)', () => {
  it('rejects empty PDF files', async () => {
    await runtime.fs.writeFile('empty.pdf', Buffer.alloc(0))
    const result = await fileReadTool.call({ file_path: 'empty.pdf' }, context())
    assert.equal(result.isError, undefined)
    const output = result.output as FileReadStructuredOutput
    assert.equal(output.format, 'pdf')
    assert.equal(output.text, '')
    assert.match(output.warnings[0] ?? '', /empty/i)
  })

  it('rejects files lacking %PDF- header', async () => {
    await runtime.fs.writeFile('not-a.pdf', Buffer.from('plain text content'))
    const result = await fileReadTool.call({ file_path: 'not-a.pdf' }, context())
    assert.equal(result.isError, undefined)
    const output = result.output as FileReadStructuredOutput
    assert.equal(output.format, 'pdf')
    assert.match(output.warnings[0] ?? '', /not a valid PDF/i)
  })
})

describe('Read (xlsx / docx structured extraction)', () => {
  it('returns structured warning when xlsx is malformed', async () => {
    await runtime.fs.writeFile('table.xlsx', Buffer.from([0x50, 0x4b]))
    const result = await fileReadTool.call({ file_path: 'table.xlsx' }, context())
    assert.equal(result.isError, undefined)
    const output = result.output as FileReadStructuredOutput
    assert.equal(output.format, 'xlsx')
    assert.equal(output.text, '')
    assert.match(output.warnings[0] ?? '', /XLSX|runtime|python/i)
  })

  it('extracts docx text through the runtime parser', async () => {
    await createDocxFixture('sample.docx')
    const result = await fileReadTool.call({ file_path: 'sample.docx' }, context())
    assert.equal(result.isError, undefined)
    const output = result.output as FileReadStructuredOutput
    assert.equal(output.format, 'docx')
    assert.equal(output.text, 'Hello from docx\nSecond paragraph')
    assert.equal(output.metadata?.extractor, 'python-zipfile')
  })

  it('extracts xlsx cells through the runtime parser', async () => {
    await createXlsxFixture('sample.xlsx')
    const result = await fileReadTool.call(
      { file_path: 'sample.xlsx', max_rows: 2, max_cols: 2 },
      context(),
    )
    assert.equal(result.isError, undefined)
    const output = result.output as FileReadStructuredOutput
    assert.equal(output.format, 'xlsx')
    assert.equal(output.text, 'Name\tScore\nLightClaw\t100')
    assert.equal(output.metadata?.sheet, 'Sheet1')
  })
})

async function createDocxFixture(filePath: string): Promise<void> {
  const result = await runtime.exec({
    command: 'python3 -c "$LIGHTCLAW_FIXTURE_SCRIPT"',
    env: {
      OUT: path.join(tmp, filePath),
      LIGHTCLAW_FIXTURE_SCRIPT: `
import os, zipfile
out = os.environ["OUT"]
xml = """<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Hello from docx</w:t></w:r></w:p>
    <w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p>
  </w:body>
</w:document>"""
with zipfile.ZipFile(out, "w") as zf:
    zf.writestr("word/document.xml", xml)
`,
    },
  })
  assert.equal(result.exitCode, 0, result.stderr)
}

async function createXlsxFixture(filePath: string): Promise<void> {
  const result = await runtime.exec({
    command: 'python3 -c "$LIGHTCLAW_FIXTURE_SCRIPT"',
    env: {
      OUT: path.join(tmp, filePath),
      LIGHTCLAW_FIXTURE_SCRIPT: `
import os, zipfile
out = os.environ["OUT"]
workbook = """<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>"""
rels = """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Target="worksheets/sheet1.xml" Type=""/>
</Relationships>"""
sheet = """<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="inlineStr"><is><t>Name</t></is></c>
      <c r="B1" t="inlineStr"><is><t>Score</t></is></c>
    </row>
    <row r="2">
      <c r="A2" t="inlineStr"><is><t>LightClaw</t></is></c>
      <c r="B2"><v>100</v></c>
    </row>
  </sheetData>
</worksheet>"""
with zipfile.ZipFile(out, "w") as zf:
    zf.writestr("xl/workbook.xml", workbook)
    zf.writestr("xl/_rels/workbook.xml.rels", rels)
    zf.writestr("xl/worksheets/sheet1.xml", sheet)
`,
    },
  })
  assert.equal(result.exitCode, 0, result.stderr)
}
