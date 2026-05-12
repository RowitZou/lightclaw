import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  deriveFilename,
  extForMime,
  isBinaryContentType,
  isTextContentType,
} from './web-fetch-filename.js'

describe('web-fetch-filename (unit)', () => {
  it('mime-derived ext wins over URL basename pseudo-extension (arxiv pdf regression)', () => {
    // `arxiv.org/pdf/2509.25721` looks like `<basename>.<ext>` but .25721
    // is a paper version, not a file ext. Python's FILENAME_SAFE_RE
    // (`[^A-Za-z0-9._-]`) keeps `.` in the safe set, so the dot is NOT
    // replaced. Basename `2509.25721` lowercase does not end in `.pdf`
    // (the mime-derived suffix) → name part stays `2509.25721`. Mime
    // appends authoritative `.pdf`. Net: `2509.25721-<rand>.pdf`.
    // The "URL pseudo-extension wins" claim from the Python comment is
    // about `os.path.splitext`, which the helper does NOT use — the
    // actual behavior is: mime ext appended unconditionally, URL basename
    // preserved with its dots.
    const fn = deriveFilename(
      'https://arxiv.org/pdf/2509.25721',
      'application/pdf',
    )
    assert.match(fn, /^2509\.25721-[0-9a-f]{6}\.pdf$/, `got: ${fn}`)
  })

  it('URL basename ending in mime-derived ext: ext stripped, original casing preserved', () => {
    // `foo.jpg` with image/jpeg → mime ext is `jpg`, suffix `.jpg` matches
    // basename's lowercase tail → strip to `foo` → append `-<rand>.jpg`.
    const fn = deriveFilename('https://example.com/foo.jpg', 'image/jpeg')
    assert.match(fn, /^foo-[0-9a-f]{6}\.jpg$/, `got: ${fn}`)
  })

  it('empty basename + octet-stream → defaults webfetch-<rand>.bin', () => {
    // Empty path (`https://example.com/`) leaves `raw = ''` after
    // path.basename. Python helper defaults `name_part = "webfetch"`,
    // mime maps `application/octet-stream` → `bin`.
    const fn = deriveFilename('https://example.com/', 'application/octet-stream')
    assert.match(fn, /^webfetch-[0-9a-f]{6}\.bin$/, `got: ${fn}`)
  })

  it('isBinaryContentType: text/html / +json / application/xml are TEXT', () => {
    // Python helper's is_text_content_type covers text/*, +json,
    // application/json, +xml, application/xml, application/javascript,
    // and x-www-form-urlencoded. is_binary is the inverse.
    assert.equal(isBinaryContentType('text/html'), false)
    assert.equal(isBinaryContentType('text/html; charset=utf-8'), false)
    assert.equal(isBinaryContentType('application/json'), false)
    assert.equal(isBinaryContentType('application/vnd.api+json'), false)
    assert.equal(isBinaryContentType('application/xml'), false)
    assert.equal(isBinaryContentType('application/javascript'), false)
    assert.equal(isBinaryContentType('application/x-www-form-urlencoded'), false)
    // Missing header → text (we'd rather utf-8-decode and let extractor
    // fail than blindly persist unknown-mime payload to disk).
    assert.equal(isBinaryContentType(''), false)
  })

  it('isBinaryContentType: pdf / image/* / archives / octet-stream are BINARY', () => {
    assert.equal(isBinaryContentType('application/pdf'), true)
    assert.equal(isBinaryContentType('image/png'), true)
    assert.equal(isBinaryContentType('image/jpeg; charset=binary'), true)
    assert.equal(isBinaryContentType('application/zip'), true)
    assert.equal(isBinaryContentType('application/octet-stream'), true)
    assert.equal(isBinaryContentType('audio/mpeg'), true)
    assert.equal(isBinaryContentType('video/mp4'), true)
  })

  it('extForMime: known maps + fallback bin', () => {
    assert.equal(extForMime('application/pdf'), 'pdf')
    assert.equal(extForMime('image/jpeg'), 'jpg')
    assert.equal(extForMime('image/jpeg; charset=binary'), 'jpg')
    assert.equal(extForMime('application/vnd.unknown-format'), 'bin')
    assert.equal(extForMime(''), 'bin')
    // text/html doesn't appear in MIME_TO_EXT (it's a text content-type
    // and never reaches the binary path); fallback is `bin` if anyone
    // misuses the API.
    assert.equal(extForMime('text/html'), 'bin')
  })

  it('isTextContentType inverse symmetry sanity', () => {
    // Property: for any mime input, isText(m) === !isBinary(m). Pick a
    // mix of edge cases.
    for (const mime of [
      '',
      'text/plain',
      'application/json',
      'application/pdf',
      'image/png',
      'application/svg+xml',
      'application/javascript',
    ]) {
      assert.equal(
        isTextContentType(mime),
        !isBinaryContentType(mime),
        `symmetry broken for ${mime}`,
      )
    }
  })
})
