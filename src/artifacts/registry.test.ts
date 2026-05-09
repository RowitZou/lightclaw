import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { LocalRuntime } from '../runtime/local.js'

import {
  ARTIFACT_INDEX_PATH,
  createArtifactId,
  listArtifacts,
  lookupArtifact,
  resolveArtifactPath,
  sanitizePathSegment,
  sha256Hex,
  upsertArtifact,
  type ArtifactRecord,
} from './registry.js'

let tmp: string
let runtime: LocalRuntime

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'lightclaw-artifacts-'))
  runtime = new LocalRuntime(tmp)
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('artifact registry', () => {
  it('upserts, lists, filters, and looks up artifacts', async () => {
    const record: ArtifactRecord = {
      artifactId: 'artifact_feishu_file_msg_0_abcdef',
      kind: 'feishu_attachment',
      source: 'feishu',
      title: 'report.pdf',
      summary: 'A test report',
      workspacePath: '.attachments/feishu/msg/00-report.pdf',
      feishu: { messageId: 'msg', chatId: 'chat', fileKey: 'file-key' },
      sessionId: 'feishu-user',
      createdAt: '2026-05-06T00:00:00.000Z',
      lastAccessedAt: null,
      status: 'imported',
    }

    await upsertArtifact(runtime.fs, record)
    await upsertArtifact(runtime.fs, {
      ...record,
      title: 'report-v2.pdf',
      summary: 'Updated summary',
    })

    const all = await listArtifacts(runtime.fs, { source: 'feishu' })
    assert.equal(all.length, 1)
    assert.equal(all[0]?.title, 'report-v2.pdf')

    const byMessage = await listArtifacts(runtime.fs, { messageId: 'msg' })
    assert.equal(byMessage.length, 1)

    const missing = await listArtifacts(runtime.fs, { sessionId: 'other' })
    assert.equal(missing.length, 0)

    const found = await lookupArtifact(runtime.fs, record.artifactId)
    assert.equal(found?.summary, 'Updated summary')

    const indexContent = (await runtime.fs.readFile(ARTIFACT_INDEX_PATH)).toString('utf8')
    assert.match(indexContent, /report-v2\.pdf/)
  })

  it('builds safe ids, path segments, and hashes', () => {
    const hash = sha256Hex(Buffer.from('hello'))
    assert.equal(hash.length, 64)
    assert.equal(
      createArtifactId({
        source: 'feishu',
        kind: 'attachment',
        messageId: 'om_x/y',
        index: 2,
        sha256: hash,
      }),
      `artifact_feishu_attachment_om_x_y_2_${hash.slice(0, 12)}`,
    )
    assert.equal(sanitizePathSegment('../evil/name?.txt'), 'name_.txt')
    assert.equal(sanitizePathSegment('..'), 'artifact')
  })

  it('resolves registry paths under an explicit runtime workspace root', () => {
    assert.equal(
      resolveArtifactPath('/workspace', ARTIFACT_INDEX_PATH),
      '/workspace/.lightclaw/artifacts/index.jsonl',
    )
    assert.equal(
      resolveArtifactPath('/workspace', '/workspace/.attachments/file.txt'),
      '/workspace/.attachments/file.txt',
    )
  })

  it('hides failed artifacts from default lists unless explicitly requested', async () => {
    const base: ArtifactRecord = {
      artifactId: 'artifact_ok',
      kind: 'feishu_attachment',
      source: 'feishu',
      title: 'ok.txt',
      feishu: { messageId: 'msg', chatId: 'chat', fileKey: 'ok' },
      sessionId: 'feishu-user',
      createdAt: '2026-05-06T00:00:00.000Z',
      lastAccessedAt: null,
      status: 'imported',
    }
    await upsertArtifact(runtime.fs, base)
    await upsertArtifact(runtime.fs, {
      ...base,
      artifactId: 'artifact_failed',
      title: 'failed.pdf',
      feishu: { messageId: 'msg', chatId: 'chat', fileKey: 'failed' },
      status: 'failed',
      error: 'download failed',
    })

    const visible = await listArtifacts(runtime.fs, { messageId: 'msg' })
    assert.deepEqual(visible.map(item => item.artifactId), ['artifact_ok'])

    const withFailed = await listArtifacts(runtime.fs, {
      messageId: 'msg',
      includeFailed: true,
    })
    assert.equal(withFailed.length, 2)

    const onlyFailed = await listArtifacts(runtime.fs, {
      messageId: 'msg',
      status: 'failed',
    })
    assert.deepEqual(onlyFailed.map(item => item.artifactId), ['artifact_failed'])
  })
})
