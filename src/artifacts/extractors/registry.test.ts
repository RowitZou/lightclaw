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
  })
})
