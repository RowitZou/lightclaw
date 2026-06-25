import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { clearFeishuClient, registerFeishuClient, type FeishuClient } from '../channels/feishu/client.js'
import { setLang } from '../i18n/index.js'
import { setLightclawHomeOverride } from '../paths.js'
import { runFeishuWorkspaceCommand } from './feishu-workspace.js'

let tmpHome = ''
let driveState: DriveStub

type DriveStub = {
  deleted: string[]
  files: Map<string, Array<{ name: string; token: string; type: string }>>
  deleteError?: Error
}

beforeEach(async () => {
  tmpHome = await mkdtemp(path.join(tmpdir(), 'lightclaw-feishu-workspace-cmd-'))
  setLightclawHomeOverride(tmpHome)
  setLang('en')
  driveState = {
    deleted: [],
    files: new Map([
      ['rootFld', [
        { name: 'alice', token: 'aliceFld', type: 'folder' },
        { name: 'bob', token: 'bobFld', type: 'folder' },
      ]],
      ['aliceFld', [
        { name: 'notes.docx', token: 'docNotes', type: 'docx' },
      ]],
      ['bobFld', []],
      ['orphanFld', []],
    ]),
  }
  registerFeishuClient(makeStubClient(driveState) as FeishuClient)
})

afterEach(async () => {
  setLang('cn')
  clearFeishuClient()
  setLightclawHomeOverride(undefined)
  await rm(tmpHome, { recursive: true, force: true })
})

describe('/feishu-workspace admin slash', () => {
  it('status reports root token and user folder count', async () => {
    await seedRoot('rootFld')
    await seedUserWorkspace('alice', 'aliceFld', 'rootFld')
    await seedUserWorkspace('bob', 'bobFld', 'rootFld')
    const out = await runFeishuWorkspaceCommand('status')
    assert.match(out, /root: rootFld/)
    assert.match(out, /user folders: 2/)
  })

  it('list dumps a canonical / folderToken / updated table', async () => {
    await seedRoot('rootFld')
    await seedUserWorkspace('alice', 'aliceFld', 'rootFld')
    const out = await runFeishuWorkspaceCommand('list')
    assert.match(out, /alice\s+aliceFld/)
  })

  it('orphans shows folders that have no identity binding', async () => {
    await seedRoot('rootFld')
    await seedUserWorkspace('alice', 'aliceFld', 'rootFld')
    // Add an orphan folder under root that is not bound to any identity.
    driveState.files.set('rootFld', [
      ...driveState.files.get('rootFld') ?? [],
      { name: 'ghost', token: 'orphanFld', type: 'folder' },
    ])
    const out = await runFeishuWorkspaceCommand('orphans')
    assert.match(out, /orphanFld\s+ghost/)
  })

  it('delete previews + requires --y before actually deleting', async () => {
    await seedRoot('rootFld')
    await seedUserWorkspace('alice', 'aliceFld', 'rootFld')
    const preview = await runFeishuWorkspaceCommand('delete alice')
    // B5: preview lists the folder + item count and tells the user to re-run
    // with --y; no token round-trip, no delete fires.
    assert.match(preview, /alice/)
    assert.match(preview, /--y/)
    assert.deepEqual(driveState.deleted, [], 'no delete should fire before --y')

    const done = await runFeishuWorkspaceCommand('delete alice --y')
    assert.match(done, /Deleted Feishu workspace for "alice"/)
    assert.deepEqual(driveState.deleted, ['aliceFld'])

    const records = await readAuditRecords()
    const admin = records.find(r => r.operation === 'admin-delete-workspace')
    assert.ok(admin, 'expected admin-delete-workspace audit row')
    assert.equal(admin.status, 'confirmed')
  })

  it('delete records a failed audit row when Feishu rejects the delete', async () => {
    await seedRoot('rootFld')
    await seedUserWorkspace('alice', 'aliceFld', 'rootFld')
    driveState.deleteError = new Error('Feishu API error 99991663: ScopeAccessDenied')
    const out = await runFeishuWorkspaceCommand('delete alice --y')
    assert.match(out, /Failed to delete/)
    assert.match(out, /ScopeAccessDenied/)

    const records = await readAuditRecords()
    const failed = records.find(r => r.status === 'failed' && r.operation === 'admin-delete-workspace')
    assert.ok(failed, 'expected failed admin-delete-workspace audit row')

    // Identity binding should remain on disk so admin can re-investigate.
    const stillBound = await readFile(
      path.join(tmpHome, 'users', 'alice', 'state', 'feishu-workspace.json'),
      'utf8',
    )
    assert.match(stillBound, /aliceFld/)
  })

  it('rejects unknown subcommand with usage hint', async () => {
    const out = await runFeishuWorkspaceCommand('bogus')
    assert.match(out, /Usage:/)
  })
})

async function seedRoot(folderToken: string): Promise<void> {
  const file = path.join(tmpHome, 'feishu-cloud-root.json')
  await writeFile(file, `${JSON.stringify({
    folderToken,
    createdAt: '2026-05-12T00:00:00.000Z',
    lightclawVersion: 'test',
  })}\n`, 'utf8')
}

async function seedUserWorkspace(canonical: string, folderToken: string, rootToken: string): Promise<void> {
  const dir = path.join(tmpHome, 'users', canonical, 'state')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'feishu-workspace.json'), `${JSON.stringify({
    folderToken,
    parentFolderToken: rootToken,
    createdAt: '2026-05-12T00:00:00.000Z',
    ownerOpenId: `ou_${canonical}`,
  })}\n`, 'utf8')
}

function makeStubClient(state: DriveStub): unknown {
  return {
    drive: {
      permissionMember: { create: async () => ({ code: 0, data: {} }) },
      v1: {
        file: {
          createFolder: async () => ({ code: 0, data: { token: 'newFld', name: 'new' } }),
          list: async (input: { params?: { folder_token?: string } }) => ({
            code: 0,
            data: { files: state.files.get(input.params?.folder_token ?? '') ?? [] },
          }),
          delete: async (input: { path?: { file_token?: string } }) => {
            if (state.deleteError) {
              throw state.deleteError
            }
            state.deleted.push(input.path?.file_token ?? '')
            return { code: 0, data: {} }
          },
          move: async () => ({ code: 0, data: {} }),
          getMetadata: async () => ({ code: 0, data: {} }),
        },
        metadata: { batchQuery: async () => ({ code: 0, data: { metas: [] } }) },
      },
    },
  }
}

async function readAuditRecords(): Promise<Array<Record<string, unknown>>> {
  const dir = path.join(tmpHome, 'audit', 'feishu-writes')
  const files = await readdir(dir)
  const content = await readFile(path.join(dir, files[0]!), 'utf8')
  return content.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
}
