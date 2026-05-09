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

  it('does not treat PDF text extraction as reliable content', async () => {
    const result = await extractArtifactText({
      buffer: Buffer.from('%PDF-'),
      filePath: 'paper.pdf',
      maxChars: 100,
    })
    assert.equal(result.format, 'pdf')
    assert.equal(result.text, '')
    assert.match(result.warnings[0] ?? '', /disabled/)
    assert.deepEqual(result.metadata?.readableWith, ['RenderPdfPages'])
  })
})
