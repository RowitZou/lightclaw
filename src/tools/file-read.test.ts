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

describe('Read (office structured extraction)', () => {
  it('returns structured warning when xlsx is malformed', async () => {
    await runtime.fs.writeFile('table.xlsx', Buffer.from([0x50, 0x4b]))
    const result = await fileReadTool.call({ file_path: 'table.xlsx' }, context())
    assert.equal(result.isError, undefined)
    const output = result.output as FileReadStructuredOutput
    assert.equal(output.format, 'xlsx')
    assert.equal(output.text, '')
    assert.match(output.warnings[0] ?? '', /xlsx|openpyxl|workbook|zip/i)
  })

  it('extracts docx text through python-docx', async () => {
    await createDocxFixture('sample.docx')
    const result = await fileReadTool.call({ file_path: 'sample.docx' }, context())
    assert.equal(result.isError, undefined)
    const output = result.output as FileReadStructuredOutput
    assert.equal(output.format, 'docx')
    assert.match(output.text, /Hello from docx/)
    assert.match(output.text, /Second paragraph/)
    assert.equal(output.metadata?.extractor, 'python-docx')
  })

  it('extracts xlsx cells through openpyxl', async () => {
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
    assert.equal(output.metadata?.extractor, 'openpyxl')
  })

  it('extracts pptx slides through python-pptx', async () => {
    await createPptxFixture('sample.pptx')
    const result = await fileReadTool.call({ file_path: 'sample.pptx' }, context())
    assert.equal(result.isError, undefined)
    const output = result.output as FileReadStructuredOutput
    assert.equal(output.format, 'pptx')
    assert.match(output.text, /=== Slide 1/)
    assert.match(output.text, /Welcome to LightClaw/)
    assert.equal(output.metadata?.extractor, 'python-pptx')
    assert.equal(output.metadata?.slideCount, 2)
  })
})

async function createDocxFixture(filePath: string): Promise<void> {
  const result = await runtime.exec({
    command: 'python3 -c "$LIGHTCLAW_FIXTURE_SCRIPT"',
    env: {
      OUT: path.join(tmp, filePath),
      LIGHTCLAW_FIXTURE_SCRIPT: `
import os
from docx import Document
out = os.environ["OUT"]
doc = Document()
doc.add_paragraph("Hello from docx")
doc.add_paragraph("Second paragraph")
doc.save(out)
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
import os
import openpyxl
out = os.environ["OUT"]
wb = openpyxl.Workbook()
ws = wb.active
ws.title = "Sheet1"
ws["A1"] = "Name"
ws["B1"] = "Score"
ws["A2"] = "LightClaw"
ws["B2"] = 100
wb.save(out)
`,
    },
  })
  assert.equal(result.exitCode, 0, result.stderr)
}

async function createPptxFixture(filePath: string): Promise<void> {
  const result = await runtime.exec({
    command: 'python3 -c "$LIGHTCLAW_FIXTURE_SCRIPT"',
    env: {
      OUT: path.join(tmp, filePath),
      LIGHTCLAW_FIXTURE_SCRIPT: `
import os
from pptx import Presentation
out = os.environ["OUT"]
prs = Presentation()

s1 = prs.slides.add_slide(prs.slide_layouts[0])
s1.shapes.title.text = "Welcome to LightClaw"

s2 = prs.slides.add_slide(prs.slide_layouts[1])
s2.shapes.title.text = "Agenda"
body = s2.placeholders[1]
body.text = "Revenue\\nCosts\\nQ4 plan"

prs.save(out)
`,
    },
  })
  assert.equal(result.exitCode, 0, result.stderr)
}
