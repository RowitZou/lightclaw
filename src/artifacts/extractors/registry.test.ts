import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { extractArtifactText, inferArtifactFormat } from './registry.js'

describe('artifact extractor registry', () => {
  it('infers common text-oriented formats from path and MIME', () => {
    assert.equal(inferArtifactFormat('notes.md', undefined), 'text')
    assert.equal(inferArtifactFormat('data.json', undefined), 'json')
    assert.equal(inferArtifactFormat('table.tsv', undefined), 'csv')
    assert.equal(inferArtifactFormat('report.pdf', undefined), 'pdf')
    assert.equal(inferArtifactFormat('book.xlsx', undefined), 'xlsx')
    assert.equal(inferArtifactFormat('doc.docx', undefined), 'docx')
    assert.equal(inferArtifactFormat('deck.pptx', undefined), 'pptx')
    assert.equal(inferArtifactFormat('image.png', undefined), 'binary')
    assert.equal(inferArtifactFormat('unknown.bin', 'text/plain'), 'text')
  })

  it('pretty prints JSON and returns parser warnings for invalid JSON', async () => {
    const pretty = await extractArtifactText({
      buffer: Buffer.from('{"name":"lightclaw"}'),
      filePath: 'data.json',
      maxChars: 100,
    })
    assert.equal(pretty.format, 'json')
    assert.equal(pretty.text, '{\n  "name": "lightclaw"\n}')
    assert.deepEqual(pretty.warnings, [])

    const invalid = await extractArtifactText({
      buffer: Buffer.from('{broken'),
      filePath: 'data.json',
      maxChars: 100,
    })
    assert.equal(invalid.text, '{broken')
    assert.match(invalid.warnings[0] ?? '', /JSON/)
  })

  it('PDF extraction without an executor returns a clear warning', async () => {
    const result = await extractArtifactText({
      buffer: Buffer.from('%PDF-'),
      filePath: 'paper.pdf',
      maxChars: 100,
    })
    assert.equal(result.format, 'pdf')
    assert.equal(result.text, '')
    assert.match(result.warnings[0] ?? '', /executor/i)
  })

  it('PDF extraction surfaces a missing-pdftotext warning when exec returns 127', async () => {
    const result = await extractArtifactText({
      buffer: Buffer.from('%PDF-1.7\n'),
      filePath: 'paper.pdf',
      maxChars: 100,
      exec: async () => ({ stdout: '', stderr: '', exitCode: 127 }),
    })
    assert.equal(result.format, 'pdf')
    assert.equal(result.text, '')
    assert.match(result.warnings[0] ?? '', /pdftotext/i)
  })

  it('PDF extraction returns text and metadata when pdftotext succeeds', async () => {
    const stdout = 'Page 1 line 1\nPage 1 line 2\n\fPage 2 line 1\n'
    const result = await extractArtifactText({
      buffer: Buffer.from('%PDF-1.7\n'),
      filePath: 'paper.pdf',
      maxChars: 100,
      exec: async () => ({ stdout, stderr: '', exitCode: 0 }),
    })
    assert.equal(result.format, 'pdf')
    assert.equal(result.text, stdout)
    assert.equal(result.truncated, false)
    assert.equal(result.metadata?.extractor, 'pdftotext')
    assert.equal(result.metadata?.pageRange, undefined, 'no pageRange metadata when range was not requested')
  })

  it('PDF extraction passes -f N -l M to pdftotext when pdfPageRange is set + records the range in metadata', async () => {
    let receivedCommand = ''
    const result = await extractArtifactText({
      buffer: Buffer.from('%PDF-1.7\n'),
      filePath: 'paper.pdf',
      maxChars: 100,
      pdfPageRange: { firstPage: 31, lastPage: 33 },
      exec: async (params) => {
        receivedCommand = params.command
        return { stdout: 'page 31\n\fpage 32\n\fpage 33\n', stderr: '', exitCode: 0 }
      },
    })
    assert.equal(result.format, 'pdf')
    assert.match(receivedCommand, /-f 31 -l 33/, 'pdftotext command must include -f/-l from pdfPageRange')
    assert.equal(result.metadata?.pageRange, '31-33', 'metadata must record the page range so the agent can confirm what it got')
  })
})
