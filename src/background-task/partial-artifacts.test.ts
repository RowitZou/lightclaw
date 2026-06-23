import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

import { collectPartialArtifactPaths } from './partial-artifacts.js'
import { setLightclawHomeOverride } from '../paths.js'

// §十: sessions derive from <home>; isolate via the home override and write
// transcripts into <home>/sessions (the old LIGHTCLAW_SESSIONS_DIR was removed).
let tmpHome: string
let tmpSessions: string

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-partial-artifacts-'))
  setLightclawHomeOverride(tmpHome)
  tmpSessions = path.join(tmpHome, 'sessions')
  mkdirSync(tmpSessions, { recursive: true })
})

afterEach(() => {
  setLightclawHomeOverride(undefined)
  rmSync(tmpHome, { recursive: true, force: true })
})

function writeTranscript(sessionId: string, lines: unknown[]): void {
  const dir = path.join(tmpSessions, sessionId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, 'transcript.jsonl'),
    lines.map(l => JSON.stringify(l)).join('\n') + '\n',
    'utf8',
  )
}

function assistant(blocks: unknown[]): unknown {
  return {
    type: 'assistant',
    uuid: 'a',
    parentUuid: null,
    timestamp: 1,
    message: { role: 'assistant', content: blocks, stop_reason: 'tool_use', usage: {} },
  }
}

function toolResult(id: string, isError = false): unknown {
  return {
    type: 'user',
    uuid: 'u',
    parentUuid: 'a',
    timestamp: 2,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: isError }],
    },
  }
}

describe('collectPartialArtifactPaths', () => {
  it('returns [] when the transcript does not exist', async () => {
    assert.deepEqual(await collectPartialArtifactPaths('bg-missing'), [])
  })

  it('extracts successful Write and Edit file_paths in order', async () => {
    writeTranscript('bg-1', [
      assistant([
        { type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/workspace/draft.md' } },
      ]),
      toolResult('t1'),
      assistant([
        { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/workspace/assets/fig.png' } },
      ]),
      toolResult('t2'),
    ])
    assert.deepEqual(await collectPartialArtifactPaths('bg-1'), [
      '/workspace/draft.md',
      '/workspace/assets/fig.png',
    ])
  })

  it('excludes Write calls whose tool_result is an error', async () => {
    writeTranscript('bg-2', [
      assistant([
        { type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/workspace/ok.md' } },
      ]),
      toolResult('t1'),
      assistant([
        { type: 'tool_use', id: 't2', name: 'Write', input: { file_path: '/workspace/failed.md' } },
      ]),
      toolResult('t2', true),
    ])
    assert.deepEqual(await collectPartialArtifactPaths('bg-2'), ['/workspace/ok.md'])
  })

  it('excludes a Write whose round-trip never completed (no tool_result)', async () => {
    // Incremental persistence only flushes COMPLETED round-trips, but guard
    // anyway: an orphan tool_use with no matching result must not surface.
    writeTranscript('bg-3', [
      assistant([
        { type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/workspace/inflight.md' } },
      ]),
    ])
    assert.deepEqual(await collectPartialArtifactPaths('bg-3'), [])
  })

  it('ignores non-artifact tools and dedupes repeated paths', async () => {
    writeTranscript('bg-4', [
      assistant([
        { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/workspace/draft.md' } },
      ]),
      toolResult('r1'),
      assistant([
        { type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: '/workspace/draft.md' } },
      ]),
      toolResult('w1'),
      assistant([
        { type: 'tool_use', id: 'w2', name: 'Edit', input: { file_path: '/workspace/draft.md' } },
      ]),
      toolResult('w2'),
    ])
    assert.deepEqual(await collectPartialArtifactPaths('bg-4'), ['/workspace/draft.md'])
  })

  it('respects the limit and survives a torn final line', async () => {
    const dir = path.join(tmpSessions, 'bg-5')
    mkdirSync(dir, { recursive: true })
    const good: unknown[] = []
    for (let i = 0; i < 5; i++) {
      good.push(
        assistant([
          { type: 'tool_use', id: `t${i}`, name: 'Write', input: { file_path: `/workspace/f${i}.md` } },
        ]),
      )
      good.push(toolResult(`t${i}`))
    }
    // Append a truncated/torn JSON line at the end (crash mid-append).
    const body = good.map(l => JSON.stringify(l)).join('\n') + '\n' + '{"type":"assist'
    writeFileSync(path.join(dir, 'transcript.jsonl'), body, 'utf8')

    const result = await collectPartialArtifactPaths('bg-5', { limit: 3 })
    assert.deepEqual(result, ['/workspace/f0.md', '/workspace/f1.md', '/workspace/f2.md'])
  })
})
