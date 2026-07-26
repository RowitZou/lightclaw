// source_file markdown segmentation (candidate-8, 2026-07-26).
//
// A report authored in the workspace references its figures as standalone
// local-image lines (`![caption](assets/fig-1.png)`). Publishing it to Feishu
// used to force the model to re-type the whole document as a tool argument
// and then hand-place each image by block index. The daemon can do both from the
// source file: split the markdown at standalone LOCAL image references and
// emit an ordered segment list; the caller then appends markdown segments and
// uploads image segments SEQUENTIALLY, so document order is preserved without
// any block-index arithmetic.
//
// Deliberately narrow:
// - Only STANDALONE image lines split (a full line that is exactly one image
//   reference). Inline references stay inside their markdown segment and go
//   through Feishu's converter untouched.
// - Only LOCAL targets split. Remote (`http(s)://`, any scheme) and `data:`
//   URIs stay in the markdown — Feishu's converter owns those.
// - Fenced code blocks are never split: an example image line inside ``` is
//   content, not a reference.

import path from 'node:path'

export type MarkdownSegment =
  | { kind: 'markdown'; text: string }
  | { kind: 'image'; path: string; alt: string }

const STANDALONE_IMAGE_LINE = /^\s*!\[([^\]]*)\]\(([^()\s]+)(?:\s+"[^"]*")?\)\s*$/
const FENCE_LINE = /^\s*(```|~~~)/
const REMOTE_TARGET = /^[a-z][a-z0-9+.-]*:/i

/** Split markdown into ordered segments at standalone local-image lines.
 *  Relative image paths resolve against `baseDir` (the source file's own
 *  directory in the runtime's path view), matching how the document renders
 *  when previewed next to its assets. */
export function splitMarkdownLocalImages(markdown: string, baseDir: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = []
  let buffer: string[] = []
  let inFence = false

  const flush = (): void => {
    if (buffer.length === 0) return
    const text = buffer.join('\n')
    if (text.trim().length > 0) segments.push({ kind: 'markdown', text })
    buffer = []
  }

  for (const line of markdown.split('\n')) {
    if (FENCE_LINE.test(line)) {
      inFence = !inFence
      buffer.push(line)
      continue
    }
    if (inFence) {
      buffer.push(line)
      continue
    }
    const match = STANDALONE_IMAGE_LINE.exec(line)
    if (!match) {
      buffer.push(line)
      continue
    }
    const target = match[2]
    if (REMOTE_TARGET.test(target)) {
      buffer.push(line)
      continue
    }
    flush()
    segments.push({
      kind: 'image',
      path: path.posix.isAbsolute(target) ? path.posix.normalize(target) : path.posix.join(baseDir, target),
      alt: match[1] ?? '',
    })
  }
  flush()
  return segments
}

export function countImageSegments(segments: MarkdownSegment[]): number {
  return segments.reduce((n, s) => n + (s.kind === 'image' ? 1 : 0), 0)
}
