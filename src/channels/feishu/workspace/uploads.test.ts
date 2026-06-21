import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import type { FeishuClient } from '../client.js'
import { setLightclawHomeOverride } from '../../../paths.js'
import {
  _resetUploadsFolderInflightForTests,
  getOrCreateUserUploadsFolder,
  userUploadsFolderPath,
} from './uploads.js'
import type { UserWorkspace } from './lifecycle.js'

let tmpHome = ''

beforeEach(async () => {
  tmpHome = await mkdtemp(path.join(tmpdir(), 'lightclaw-feishu-uploads-'))
  setLightclawHomeOverride(tmpHome)
  _resetUploadsFolderInflightForTests()
  await mkdir(path.join(tmpHome, 'users', 'alice', 'state'), { recursive: true })
})

afterEach(async () => {
  setLightclawHomeOverride(undefined)
  await rm(tmpHome, { recursive: true, force: true })
})

const workspace: UserWorkspace = {
  folderToken: 'userFld',
  parentFolderToken: 'rootFld',
  createdAt: '2026-05-13T00:00:00.000Z',
  ownerOpenId: 'ou_alice',
}

describe('getOrCreateUserUploadsFolder', () => {
  it('cold path creates the folder, persists to disk, grants the owner', async () => {
    const calls = makeCallLog()
    const client = makeClient(calls)
    const result = await getOrCreateUserUploadsFolder(client, 'alice', 'ou_alice', workspace)
    assert.equal(result.folderToken, 'fld_uploads')
    assert.equal(result.parentFolderToken, 'userFld')
    assert.equal(result.name, 'LightClaw Uploads')
    assert.equal(result.ownerOpenId, 'ou_alice')
    assert.deepEqual(calls.createdFolders, [{ parent: 'userFld', name: 'LightClaw Uploads' }])
    assert.deepEqual(calls.grants, [
      { token: 'fld_uploads', memberId: 'ou_alice', memberType: 'openid', perm: 'full_access', type: 'folder' },
    ])
    // Persisted on disk so the next call short-circuits.
    const persisted = JSON.parse(await readFile(userUploadsFolderPath('alice'), 'utf8'))
    assert.equal(persisted.folderToken, 'fld_uploads')
    assert.equal(persisted.name, 'LightClaw Uploads')
  })

  it('warm path reuses the persisted token and skips createFolder', async () => {
    await writeFile(
      userUploadsFolderPath('alice'),
      JSON.stringify({
        folderToken: 'fld_existing',
        parentFolderToken: 'userFld',
        name: 'LightClaw Uploads',
        createdAt: '2026-05-12T00:00:00.000Z',
        ownerOpenId: 'ou_alice',
      }),
    )
    const calls = makeCallLog()
    const client = makeClient(calls)
    const result = await getOrCreateUserUploadsFolder(client, 'alice', 'ou_alice', workspace)
    assert.equal(result.folderToken, 'fld_existing')
    assert.deepEqual(calls.createdFolders, [])
    // Owner grant is still re-asserted on every preheat to recover from a
    // transient 4xx at folder birth (same belt-and-braces invariant
    // getOrCreateUserWorkspace uses).
    assert.deepEqual(calls.grants, [
      { token: 'fld_existing', memberId: 'ou_alice', memberType: 'openid', perm: 'full_access', type: 'folder' },
    ])
  })

  it('concurrent cold calls coalesce to a single createFolder', async () => {
    const calls = makeCallLog()
    const client = makeClient(calls)
    const [a, b] = await Promise.all([
      getOrCreateUserUploadsFolder(client, 'alice', 'ou_alice', workspace),
      getOrCreateUserUploadsFolder(client, 'alice', 'ou_alice', workspace),
    ])
    assert.equal(a.folderToken, b.folderToken)
    assert.equal(calls.createdFolders.length, 1)
  })

  it('honors channels.feishu.cloudSpace.uploadsFolderName override', async () => {
    await writeFile(
      path.join(tmpHome, 'channels.json'),
      JSON.stringify({
        feishu: { cloudSpace: { uploadsFolderName: '论文转存' } },
      }),
      'utf8',
    )
    const calls = makeCallLog()
    const client = makeClient(calls)
    const result = await getOrCreateUserUploadsFolder(client, 'alice', 'ou_alice', workspace)
    assert.equal(result.name, '论文转存')
    assert.deepEqual(calls.createdFolders, [{ parent: 'userFld', name: '论文转存' }])
  })
})

type CallLog = {
  createdFolders: Array<{ parent: string; name: string }>
  grants: Array<{ token: string; memberId: string; memberType: string; perm: string; type: string }>
}

function makeCallLog(): CallLog {
  return { createdFolders: [], grants: [] }
}

function makeClient(calls: CallLog): FeishuClient {
  let nextId = 0
  return {
    drive: {
      permissionMember: {
        create: async (input: {
          path?: { token?: string }
          params?: { type?: string }
          data?: { member_type?: string; member_id?: string; perm?: string }
        }) => {
          calls.grants.push({
            token: input.path?.token ?? '',
            memberId: input.data?.member_id ?? '',
            memberType: input.data?.member_type ?? '',
            perm: input.data?.perm ?? '',
            type: input.params?.type ?? '',
          })
          return { code: 0, data: {} }
        },
      },
      v1: {
        file: {
          createFolder: async (input: { data?: { folder_token?: string; name?: string } }) => {
            calls.createdFolders.push({
              parent: input.data?.folder_token ?? '',
              name: input.data?.name ?? '',
            })
            const token = `fld_uploads${nextId === 0 ? '' : `_${nextId}`}`
            nextId += 1
            return { code: 0, data: { token, name: input.data?.name } }
          },
        },
      },
    },
  } as unknown as FeishuClient
}
