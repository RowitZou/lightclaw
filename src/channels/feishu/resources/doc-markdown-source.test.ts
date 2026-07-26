import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { countImageSegments, splitMarkdownLocalImages } from './doc-markdown-source.js'

void describe('splitMarkdownLocalImages', () => {
  void it('splits standalone local image lines into ordered segments', () => {
    const md = [
      '# Title',
      '',
      'intro paragraph',
      '',
      '![Figure 1: overview](assets/fig-1.png)',
      '',
      '图 1｜overview caption',
      '',
      '![](assets/fig-2.jpg)',
      'tail text',
    ].join('\n')
    const segments = splitMarkdownLocalImages(md, '/workspace')
    assert.deepEqual(segments.map(s => s.kind), ['markdown', 'image', 'markdown', 'image', 'markdown'])
    assert.equal(countImageSegments(segments), 2)
    const img1 = segments[1] as Extract<typeof segments[number], { kind: 'image' }>
    assert.equal(img1.path, '/workspace/assets/fig-1.png')
    assert.equal(img1.alt, 'Figure 1: overview')
    const img2 = segments[3] as Extract<typeof segments[number], { kind: 'image' }>
    assert.equal(img2.path, '/workspace/assets/fig-2.jpg')
    assert.ok((segments[2] as { text: string }).text.includes('图 1｜overview caption'))
  })

  void it('keeps remote and data-URI images inline in markdown', () => {
    const md = '![a](https://example.com/x.png)\n\n![b](data:image/png;base64,AAAA)'
    const segments = splitMarkdownLocalImages(md, '/workspace')
    assert.deepEqual(segments.map(s => s.kind), ['markdown'])
  })

  void it('does not split image-looking lines inside fenced code blocks', () => {
    const md = [
      'before',
      '```md',
      '![example](assets/in-fence.png)',
      '```',
      '![real](assets/real.png)',
    ].join('\n')
    const segments = splitMarkdownLocalImages(md, '/ws')
    assert.deepEqual(segments.map(s => s.kind), ['markdown', 'image'])
    assert.equal((segments[1] as { path: string }).path, '/ws/assets/real.png')
    assert.ok((segments[0] as { text: string }).text.includes('in-fence.png'))
  })

  void it('keeps inline (non-standalone) local references in markdown', () => {
    const md = 'see ![icon](assets/icon.png) beside text'
    const segments = splitMarkdownLocalImages(md, '/ws')
    assert.deepEqual(segments.map(s => s.kind), ['markdown'])
  })

  void it('accepts absolute paths and a title suffix', () => {
    const md = '![f](/workspace/a/b.png "hover title")'
    const segments = splitMarkdownLocalImages(md, '/elsewhere')
    assert.deepEqual(segments, [{ kind: 'image', path: '/workspace/a/b.png', alt: 'f' }])
  })

  void it('drops whitespace-only markdown segments between adjacent images', () => {
    const md = '![a](a.png)\n\n![b](b.png)'
    const segments = splitMarkdownLocalImages(md, '/ws')
    assert.deepEqual(segments.map(s => s.kind), ['image', 'image'])
  })
})
