import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { inspectImageBuffer } from './image.js'

describe('inspectImageBuffer', () => {
  it('detects PNG metadata', () => {
    const result = inspectImageBuffer(png1x1())
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.metadata.mimeType, 'image/png')
    assert.equal(result.metadata.format, 'png')
    assert.equal(result.metadata.width, 1)
    assert.equal(result.metadata.height, 1)
  })

  it('rejects empty and unsupported files', () => {
    assert.deepEqual(inspectImageBuffer(Buffer.alloc(0)), {
      ok: false,
      reason: 'Image file is empty.',
    })
    const unsupported = inspectImageBuffer(Buffer.from('not an image'))
    assert.equal(unsupported.ok, false)
    if (!unsupported.ok) {
      assert.match(unsupported.reason, /supported image/)
    }
  })

  it('warns when MIME hint disagrees with magic bytes', () => {
    const result = inspectImageBuffer(png1x1(), { mimeType: 'image/jpeg' })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.match(result.metadata.warnings[0] ?? '', /does not match/)
  })
})

function png1x1(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
    'base64',
  )
}

