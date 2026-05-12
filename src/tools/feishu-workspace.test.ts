import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import type { FeishuClient } from '../channels/feishu/client.js'
import { setLightclawHomeOverride } from '../paths.js'
import type { PermissionApprover } from '../permission/types.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'
import {
  runFeishuCreateFolder,
  runFeishuDelete,
  runFeishuList,
  runFeishuMove,
} from './feishu-workspace.js'

let tmpHome = ''

beforeEach(async () => {
  tmpHome = await mkdtemp(path.join(tmpdir(), 'lightclaw-feishu-workspace-'))
  setLightclawHomeOverride(tmpHome)
  await seedIdentity()
})

afterEach(async () => {
  setLightclawHomeOverride(undefined)
  await rm(tmpHome, { recursive: true, force: true })
})

describe('Feishu workspace tools', () => {
  it('lists the current user workspace tree', async () => {
    const client = makeClient({
      userFld: [
        item('papers', 'fldPapers', 'folder', 'userFld'),
        item('notes.docx', 'docNotes', 'docx', 'userFld'),
      ],
      fldPapers: [item('draft.docx', 'docDraft', 'docx', 'fldPapers')],
    })
    const result = await withFeishuSession(() => runFeishuList({ depth: 2 }, { client }))
    assert.match(result.output, /Workspace: \/LightClaw\/alice\//)
    assert.match(result.output, /papers/)
    assert.match(result.output, /notes\.docx/)
    assert.match(result.output, /draft\.docx/)
  })

  it('creates folders under a resolved parent and writes audit', async () => {
    const client = makeClient({
      userFld: [item('papers', 'fldPapers', 'folder', 'userFld')],
      fldPapers: [],
    })
    const result = await withFeishuSession(() =>
      runFeishuCreateFolder({ name: '2026', parent_folder: 'papers' }, { client }),
    )
    assert.match(result.output, /Created folder "2026"/)
    const records = await readAuditRecords()
    assert.equal(records[0].operation, 'create-folder')
    assert.equal(records[0].status, 'confirmed')
    assert.deepEqual(records[0].ancestryChain, ['fldPapers', 'userFld', 'rootFld'])
  })

  it('confirms and deletes a workspace doc with ancestry audit', async () => {
    const client = makeClient({
      userFld: [item('notes.docx', 'docNotes', 'docx', 'userFld')],
    })
    let asked = false
    const result = await withFeishuSession(
      () => runFeishuDelete({ target: 'notes.docx' }, { client }),
      { ask: async () => { asked = true; return { behavior: 'allow' } } },
    )
    assert.equal(asked, true)
    assert.match(result.output, /Deleted doc "notes\.docx"/)
    assert.deepEqual(client.deleted, ['docNotes'])
    const records = await readAuditRecords()
    assert.equal(records[0].operation, 'delete')
    assert.equal(records[0].status, 'confirmed')
    assert.deepEqual(records[0].ancestryChain, ['docNotes', 'userFld', 'rootFld'])
  })

  it('moves workspace docs after confirmation', async () => {
    const client = makeClient({
      userFld: [
        item('papers', 'fldPapers', 'folder', 'userFld'),
        item('notes.docx', 'docNotes', 'docx', 'userFld'),
      ],
      fldPapers: [],
    })
    const result = await withFeishuSession(
      () => runFeishuMove({ target: 'notes.docx', destination: 'papers' }, { client }),
      { ask: async () => ({ behavior: 'allow' }) },
    )
    assert.match(result.output, /Moved "notes\.docx" to "papers"/)
    assert.deepEqual(client.moved, [{ token: 'docNotes', dest: 'fldPapers' }])
    const records = await readAuditRecords()
    assert.equal(records[0].operation, 'move')
    assert.equal(records[0].status, 'confirmed')
    assert.deepEqual(records[0].sourceAncestry, ['docNotes', 'userFld', 'rootFld'])
    assert.deepEqual(records[0].destAncestry, ['fldPapers', 'userFld', 'rootFld'])
  })
})

async function withFeishuSession<T>(
  fn: () => Promise<T>,
  approver: PermissionApprover = { ask: async () => ({ behavior: 'allow' }) },
): Promise<T> {
  const ctx = createSessionContext({
    sessionId: 'feishu:dm:chat1',
    channel: 'feishu',
    cwd: tmpHome,
    model: 'test-model',
    sessionsDir: path.join(tmpHome, 'sessions'),
    memoryDir: path.join(tmpHome, 'memory'),
    currentUserId: 'alice',
    permissionMode: 'default',
    permissionApprover: approver,
  })
  return runWithSessionContext(ctx, fn)
}

async function seedIdentity(): Promise<void> {
  const identityDir = path.join(tmpHome, 'identity')
  await mkdir(identityDir, { recursive: true })
  await writeFile(path.join(identityDir, 'identities.json'), `${JSON.stringify({
    alice: {
      createdAt: '2026-05-12T00:00:00.000Z',
      updatedAt: '2026-05-12T00:00:00.000Z',
      permissionCeiling: 'acceptEdits',
      channels: { feishu: ['ou_alice'], terminal: [] },
    },
  }, null, 2)}\n`, 'utf8')
}

function item(name: string, token: string, type: string, parent: string | null): Record<string, unknown> {
  return { name, token, type, parent_token: parent, modified_time: '2026-05-12T00:00:00.000Z' }
}

function makeClient(tree: Record<string, Array<Record<string, unknown>>>): FeishuClient & {
  deleted: string[]
  moved: Array<{ token: string; dest: string }>
} {
  const deleted: string[] = []
  const moved: Array<{ token: string; dest: string }> = []
  const byToken = new Map<string, Record<string, unknown>>([
    ['rootFld', item('LightClaw', 'rootFld', 'folder', null)],
    ['userFld', item('alice', 'userFld', 'folder', 'rootFld')],
  ])
  for (const entries of Object.values(tree)) {
    for (const entry of entries) {
      byToken.set(String(entry.token), entry)
    }
  }
  return {
    deleted,
    moved,
    drive: {
      permissionMember: {
        create: async () => ({ code: 0, data: {} }),
      },
      v1: {
        file: {
          createFolder: async (input: { data?: { folder_token?: string; name?: string } }) => {
            const token = input.data?.name === 'LightClaw'
              ? 'rootFld'
              : (input.data?.name === 'alice' ? 'userFld' : `fld_${input.data?.name}`)
            const entry = item(input.data?.name ?? token, token, 'folder', input.data?.folder_token ?? null)
            byToken.set(token, entry)
            tree[input.data?.folder_token ?? ''] = [...(tree[input.data?.folder_token ?? ''] ?? []), entry]
            return { code: 0, data: { token, name: input.data?.name } }
          },
          list: async (input: { params?: { folder_token?: string } }) => ({
            code: 0,
            data: { files: tree[input.params?.folder_token ?? ''] ?? [] },
          }),
          getMetadata: async (input: { params?: { file_token?: string } }) => ({
            code: 0,
            data: byToken.get(input.params?.file_token ?? ''),
          }),
          delete: async (input: { path?: { file_token?: string } }) => {
            deleted.push(input.path?.file_token ?? '')
            return { code: 0, data: {} }
          },
          move: async (input: { path?: { file_token?: string }; data?: { folder_token?: string } }) => {
            moved.push({ token: input.path?.file_token ?? '', dest: input.data?.folder_token ?? '' })
            return { code: 0, data: {} }
          },
        },
        metadata: {
          batchQuery: async () => ({ code: 0, data: { metas: [] } }),
        },
      },
    },
  } as unknown as FeishuClient & { deleted: string[]; moved: Array<{ token: string; dest: string }> }
}

async function readAuditRecords(): Promise<Array<Record<string, unknown>>> {
  const dir = path.join(tmpHome, 'audit', 'feishu-writes')
  const files = await readdir(dir)
  const content = await readFile(path.join(dir, files[0]!), 'utf8')
  return content.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
}
