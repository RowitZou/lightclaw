import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import type { FeishuClient } from '../channels/feishu/client.js'
import { resetWorkspaceParentCacheForTest } from '../channels/feishu/workspace/ancestry.js'
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
  resetWorkspaceParentCacheForTest()
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
    // 2026-05-13: model used to share raw folder tokens; tool output now
    // embeds a clickable feishu.cn folder URL so the model has something
    // shareable. Token is also kept for ancestry/debug.
    assert.match(result.output, /https:\/\/feishu\.cn\/drive\/folder\/fld_2026/)
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

  it('refuses to move a folder into its own subtree (cycle)', async () => {
    const client = makeClient({
      userFld: [item('papers', 'fldPapers', 'folder', 'userFld')],
      fldPapers: [item('drafts', 'fldDrafts', 'folder', 'fldPapers')],
    })
    await assert.rejects(
      withFeishuSession(
        () => runFeishuMove({ target: 'papers', destination: 'papers/drafts' }, { client }),
        { ask: async () => ({ behavior: 'allow' }) },
      ),
      /into its own subtree/,
    )
    assert.deepEqual(client.moved, [])
    const records = await readAuditRecords()
    const violation = records.find(r => r.operation === 'boundary-violation')
    assert.ok(violation, 'expected boundary-violation audit row')
    assert.equal((violation.boundaryViolation as { attemptedTool?: string } | undefined)?.attemptedTool, 'FeishuMove')
  })

  it('rejects move when destination already has a same-named entry', async () => {
    const client = makeClient({
      userFld: [
        item('papers', 'fldPapers', 'folder', 'userFld'),
        item('notes.docx', 'docNotes', 'docx', 'userFld'),
      ],
      // Both root and dest carry a notes.docx; the qualified path lets the
      // source resolver pick the root one unambiguously.
      fldPapers: [item('notes.docx', 'docOtherNotes', 'docx', 'fldPapers')],
    })
    const result = await withFeishuSession(
      () => runFeishuMove({ target: '/notes.docx', destination: 'papers' }, { client }),
      { ask: async () => ({ behavior: 'allow' }) },
    )
    assert.equal(result.isError, true)
    assert.match(result.output, /already contains an entry named "notes\.docx"/)
    assert.deepEqual(client.moved, [])
  })

  it('returns idempotent message when source is already inside destination', async () => {
    const client = makeClient({
      userFld: [
        item('papers', 'fldPapers', 'folder', 'userFld'),
        item('notes.docx', 'docNotes', 'docx', 'userFld'),
      ],
      fldPapers: [],
    })
    const result = await withFeishuSession(
      () => runFeishuMove({ target: 'notes.docx', destination: '/' }, { client }),
      { ask: async () => ({ behavior: 'allow' }) },
    )
    assert.match(result.output, /already in/)
    assert.deepEqual(client.moved, [])
  })

  it('records denied audit when the user rejects FeishuDelete', async () => {
    const client = makeClient({
      userFld: [item('notes.docx', 'docNotes', 'docx', 'userFld')],
    })
    await assert.rejects(
      withFeishuSession(
        () => runFeishuDelete({ target: 'notes.docx' }, { client }),
        { ask: async () => ({ behavior: 'deny', reason: 'no' }) },
      ),
    )
    assert.deepEqual(client.deleted, [])
    const records = await readAuditRecords()
    const denied = records.find(r => r.status === 'denied')
    assert.ok(denied, 'expected denied audit row')
    assert.equal(denied.operation, 'delete')
  })

  it('records failed audit when Feishu delete API throws', async () => {
    const client = makeClient({
      userFld: [item('notes.docx', 'docNotes', 'docx', 'userFld')],
    }, {
      deleteError: new Error('Feishu API error 1064001: doc not found'),
    })
    await assert.rejects(
      withFeishuSession(
        () => runFeishuDelete({ target: 'notes.docx' }, { client }),
        { ask: async () => ({ behavior: 'allow' }) },
      ),
    )
    const records = await readAuditRecords()
    const failed = records.find(r => r.status === 'failed')
    assert.ok(failed, 'expected failed audit row')
    assert.equal(failed.operation, 'delete')
    assert.equal(typeof failed.error, 'object')
    assert.match((failed.error as { message: string }).message, /1064001/)
  })

  it('records failed audit when FeishuCreateFolder API throws', async () => {
    const client = makeClient({ userFld: [] }, {
      createFolderError: new Error('Feishu API error 99991663: ScopeAccessDenied'),
    })
    await assert.rejects(
      withFeishuSession(
        () => runFeishuCreateFolder({ name: 'papers' }, { client }),
      ),
    )
    const records = await readAuditRecords()
    const failed = records.find(r => r.status === 'failed' && r.operation === 'create-folder')
    assert.ok(failed, 'expected create-folder failed audit row')
    assert.equal(typeof failed.error, 'object')
    assert.match((failed.error as { message: string }).message, /ScopeAccessDenied/)
  })

  it('rejects paths containing ".." with a friendly message', async () => {
    const client = makeClient({ userFld: [] })
    // runFeishu* helpers throw — the tool's .call() wrapper converts that
    // into {isError:true,...}. Tests exercise the inner run* functions so
    // the throw is the visible signal.
    await assert.rejects(
      withFeishuSession(
        () => runFeishuList({ path: '../etc', depth: 1 }, { client }),
      ),
      /\.\./,
    )
  })

  it('lists an empty workspace cleanly', async () => {
    const client = makeClient({ userFld: [] })
    const result = await withFeishuSession(
      () => runFeishuList({ depth: 1 }, { client }),
    )
    assert.match(result.output, /empty workspace/i)
  })

  it('caps recursion at the requested depth and flags depth-capped folders', async () => {
    const client = makeClient({
      userFld: [item('a', 'fldA', 'folder', 'userFld')],
      fldA: [item('b', 'fldB', 'folder', 'fldA')],
      fldB: [item('c', 'fldC', 'folder', 'fldB')],
    })
    const result = await withFeishuSession(
      () => runFeishuList({ depth: 1 }, { client }),
    )
    assert.match(result.output, /\ba\//)
    assert.match(result.output, /depth-capped/)
    // depth=1 should not dive past the first level
    assert.doesNotMatch(result.output, /\bb\//)
  })

  it('disambiguates same-named entries by suggesting a path', async () => {
    const client = makeClient({
      userFld: [
        item('papers', 'fldPapers', 'folder', 'userFld'),
        item('drafts', 'fldDrafts', 'folder', 'userFld'),
      ],
      fldPapers: [item('notes.docx', 'docPapers', 'docx', 'fldPapers')],
      fldDrafts: [item('notes.docx', 'docDrafts', 'docx', 'fldDrafts')],
    })
    await assert.rejects(
      withFeishuSession(
        () => runFeishuDelete({ target: 'notes.docx' }, { client }),
        { ask: async () => ({ behavior: 'allow' }) },
      ),
      /Use a path such as/,
    )
    assert.deepEqual(client.deleted, [])
  })

  it('reports requires-feishu-binding when the canonical user has no Feishu openId', async () => {
    const client = makeClient({ userFld: [] })
    await assert.rejects(
      withFeishuSession(
        () => runFeishuList({ depth: 1 }, { client }),
        undefined,
        'bob', // canonical user not in seeded identity
      ),
    )
  })

  // Regression: pre-2026-05-13 dogfood hit
  //
  //   "[feishu-workspace] root folder probe failed (Request failed with
  //    status code 400); recreating"
  //
  // when a transient 4xx from a working folder caused the probe to
  // silently nuke + recreate the root, orphaning the original folder
  // along with the user's share grants. The fix removes probe-driven
  // auto-recreate entirely; persisted tokens are trusted as canonical
  // and only cold-start (no on-disk record) goes through createFolder.
  it('does not auto-recreate the workspace root when a list call fails transiently', async () => {
    const createdNames: string[] = []
    const listAttempts: string[] = []
    let listShouldFail = false
    // Pre-seed the workspace files so the lazy-create branch is bypassed.
    const home = path.join(tmpHome)
    await mkdir(path.join(home, 'identity', 'per-user', 'alice'), { recursive: true })
    await writeFile(path.join(home, 'feishu-cloud-root.json'), JSON.stringify({
      folderToken: 'rootFld',
      createdAt: '2026-05-12T00:00:00.000Z',
      lightclawVersion: 'test',
    }))
    await writeFile(path.join(home, 'identity', 'per-user', 'alice', 'feishu-workspace.json'), JSON.stringify({
      folderToken: 'userFld',
      parentFolderToken: 'rootFld',
      createdAt: '2026-05-12T00:00:00.000Z',
      ownerOpenId: 'ou_alice',
    }))
    const client = {
      drive: {
        permissionMember: { create: async () => ({ code: 0, data: {} }) },
        v1: {
          file: {
            createFolder: async (input: { data?: { name?: string } }) => {
              createdNames.push(input.data?.name ?? '')
              return { code: 0, data: { token: `created_${input.data?.name}`, name: input.data?.name } }
            },
            list: async (input: { params?: { folder_token?: string } }) => {
              const token = input.params?.folder_token ?? ''
              listAttempts.push(token)
              if (listShouldFail) {
                const err = new Error('Request failed with status code 400')
                throw err
              }
              return { code: 0, data: { files: [] } }
            },
            getMetadata: async () => ({ code: 0, data: {} }),
            delete: async () => ({ code: 0, data: {} }),
            move: async () => ({ code: 0, data: {} }),
          },
          metadata: { batchQuery: async () => ({ code: 0, data: { metas: [] } }) },
        },
      },
    } as unknown as FeishuClient
    // Simulate the dogfood scenario: first FeishuList call hits a 400 on
    // the persisted root token.
    listShouldFail = true
    await assert.rejects(withFeishuSession(() => runFeishuList({ depth: 1 }, { client })))
    // No createFolder should have fired — the persisted tokens stay put.
    assert.deepEqual(createdNames, [])
    // Recover (transient gone) — second FeishuList sees the same tokens.
    listShouldFail = false
    const result = await withFeishuSession(() => runFeishuList({ depth: 1 }, { client }))
    assert.match(result.output, /Workspace: \/LightClaw\/alice/)
    assert.deepEqual(createdNames, [])
  })

  // Regression: pre-2026-05-13 dogfood hit
  //
  //   "[feishu-workspace] ancestry metadata failed token=X: Feishu
  //    metadata API is unavailable"
  //
  // because the code tried drive.v1.metadata.batchQuery (wrong path; the
  // SDK exposes drive.v1.meta.batchQuery and that response shape has no
  // parent_token anyway). Every write tool's `assertWithinWorkspace` then
  // threw boundary-violation. The fix is a list-populated parent cache:
  // listFolder responses observe (child, parent) edges, walk-up is
  // synchronous in-memory.
  it('refuses to write against tokens that were never observed via listFolder', async () => {
    const client = makeClient({ userFld: [] })
    // Force the resolver to acquire the workspace context once so root /
    // user folder are seeded.
    await withFeishuSession(() => runFeishuList({ depth: 1 }, { client }))
    // Now feed the bot a token that name resolution would never produce
    // (simulating a legacy `folder_token` typed by the model out of band).
    await assert.rejects(
      withFeishuSession(
        () => runFeishuDelete({ target: 'definitely-not-listed' }, { client }),
        { ask: async () => ({ behavior: 'allow' }) },
      ),
      // resolveEntryByNameOrPath fails before assertWithinWorkspace even
      // gets the token — name-resolution gate keeps the boundary intact
      // without depending on the broken metadata walk.
      /Could not find "definitely-not-listed"/,
    )
  })

  // Regression: Phase 34 plan flagged "creating a folder that already
  // exists" as a UX bug but the original implementation silently created
  // the duplicate. Pre-check now refuses with a friendly hint.
  it('refuses FeishuCreateFolder when a same-named sibling already exists', async () => {
    const client = makeClient({
      userFld: [item('papers', 'fldPapers', 'folder', 'userFld')],
    })
    const result = await withFeishuSession(
      () => runFeishuCreateFolder({ name: 'papers' }, { client }),
    )
    assert.equal(result.isError, true)
    assert.match(result.output, /A folder named "papers" already exists/)
  })

  // 2026-05-13 dogfood: doc landed in user/论文阅读/ but Feishu UI breadcrumb
  // showed only LightClaw → doc, skipping zouyicheng + 论文阅读 (Feishu hides
  // ancestors the viewer can't access). Root cause: createFolder doesn't grant
  // the sender, so the child folder is bot-only. Fix grants sender full_access
  // on every new sub-folder. Chat grant is intentionally NOT applied even in
  // group sessions — granting chat:view on a private workspace folder would
  // let every group member browse the user's entire doc list via the
  // breadcrumb. Audit records the user grant for visibility.
  it('grants sender full_access on every sub-folder created (DM)', async () => {
    const client = makeClient({ userFld: [] })
    const result = await withFeishuSession(
      () => runFeishuCreateFolder({ name: 'papers' }, { client }),
    )
    assert.equal(result.isError, undefined)
    // Among grants: one for user folder during lifecycle preheat (token=userFld),
    // one for new sub-folder (token=fld_papers). Both go to alice's open_id.
    const subFolderGrant = client.grants.find(g => g.token === 'fld_papers')
    assert.ok(subFolderGrant, `expected grant on new sub-folder; got grants=${JSON.stringify(client.grants)}`)
    assert.equal(subFolderGrant!.memberType, 'openid')
    assert.equal(subFolderGrant!.memberId, 'ou_alice')
    assert.equal(subFolderGrant!.perm, 'full_access')
    assert.equal(subFolderGrant!.type, 'folder')
    const records = await readAuditRecords()
    const createRecord = records.find(r => r.operation === 'create-folder')
    assert.deepEqual(createRecord?.permissionGrants, { user: 'full_access' })
  })

  it('grants sender full_access without chat grant in group sessions', async () => {
    const client = makeClient({ userFld: [] })
    const result = await runWithSessionContext(
      createSessionContext({
        sessionId: 'feishu:group:oc_grp:ou_alice',
        channel: 'feishu',
        cwd: tmpHome,
        model: 'test-model',
        sessionsDir: path.join(tmpHome, 'sessions'),
        memoryDir: path.join(tmpHome, 'memory'),
        currentUserId: 'alice',
        permissionMode: 'default',
        permissionApprover: { ask: async () => ({ behavior: 'allow' }) },
      }),
      () => runFeishuCreateFolder({ name: 'projects' }, { client }),
    )
    assert.equal(result.isError, undefined)
    const folderGrants = client.grants.filter(g => g.token === 'fld_projects')
    // Exactly one grant — sender full_access. No chat:view grant on folder.
    assert.equal(folderGrants.length, 1)
    assert.equal(folderGrants[0]!.memberType, 'openid')
    assert.equal(folderGrants[0]!.memberId, 'ou_alice')
    assert.equal(folderGrants[0]!.perm, 'full_access')
  })

  // 2026-05-13 dogfood: zouyicheng user folder grant failed silently at
  // first preheat (warn-only), so the user was permanently locked out of
  // their own workspace folder. Fix re-asserts the grant on every preheat;
  // grantFolderPermission is idempotent (already-exists → success).
  it('re-grants owner on every lifecycle pass when user workspace already exists on disk', async () => {
    const client = makeClient({ userFld: [] })
    // First pass: lifecycle creates user folder + grants alice. Grant is
    // recorded in client.grants.
    await withFeishuSession(() => runFeishuList({ depth: 1 }, { client }))
    const firstPassGrants = client.grants.filter(g => g.token === 'userFld').length
    assert.ok(firstPassGrants >= 1, 'expected ≥1 grant on first preheat')
    // Second pass: same canonical user, existing feishu-workspace.json on
    // disk. Lifecycle should NOT short-circuit past grant — it should
    // re-grant (idempotent self-heal).
    const beforeSecond = client.grants.length
    await withFeishuSession(() => runFeishuList({ depth: 1 }, { client }))
    const secondPassGrants = client.grants.filter(g => g.token === 'userFld').length
    assert.ok(secondPassGrants > firstPassGrants, `expected second preheat to re-grant; before=${beforeSecond} grants=${JSON.stringify(client.grants)}`)
  })
})

async function withFeishuSession<T>(
  fn: () => Promise<T>,
  approver: PermissionApprover = { ask: async () => ({ behavior: 'allow' }) },
  currentUserId: string = 'alice',
): Promise<T> {
  const ctx = createSessionContext({
    sessionId: 'feishu:dm:chat1',
    channel: 'feishu',
    cwd: tmpHome,
    model: 'test-model',
    sessionsDir: path.join(tmpHome, 'sessions'),
    memoryDir: path.join(tmpHome, 'memory'),
    currentUserId,
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

function makeClient(
  tree: Record<string, Array<Record<string, unknown>>>,
  errors: {
    createFolderError?: Error
    deleteError?: Error
    moveError?: Error
  } = {},
): FeishuClient & {
  deleted: string[]
  moved: Array<{ token: string; dest: string }>
  grants: Array<{ token: string; memberId: string; memberType: string; perm: string; type: string }>
} {
  const deleted: string[] = []
  const moved: Array<{ token: string; dest: string }> = []
  const grants: Array<{ token: string; memberId: string; memberType: string; perm: string; type: string }> = []
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
    grants,
    drive: {
      permissionMember: {
        create: async (input: {
          path?: { token?: string }
          params?: { type?: string }
          data?: { member_type?: string; member_id?: string; perm?: string }
        }) => {
          grants.push({
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
            // Always allow root/user folder probe-then-create during workspace
            // lifecycle setup, so the lifecycle path itself doesn't trip the
            // injected error. Only the agent-tool-driven createFolder calls
            // (with names != root / canonical) get the error.
            const isLifecycleSeed = input.data?.name === 'LightClaw' || input.data?.name === 'alice'
            if (!isLifecycleSeed && errors.createFolderError) {
              throw errors.createFolderError
            }
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
            if (errors.deleteError) {
              throw errors.deleteError
            }
            deleted.push(input.path?.file_token ?? '')
            return { code: 0, data: {} }
          },
          move: async (input: { path?: { file_token?: string }; data?: { folder_token?: string } }) => {
            if (errors.moveError) {
              throw errors.moveError
            }
            moved.push({ token: input.path?.file_token ?? '', dest: input.data?.folder_token ?? '' })
            return { code: 0, data: {} }
          },
        },
        metadata: {
          batchQuery: async () => ({ code: 0, data: { metas: [] } }),
        },
      },
    },
  } as unknown as FeishuClient & {
    deleted: string[]
    moved: Array<{ token: string; dest: string }>
    grants: Array<{ token: string; memberId: string; memberType: string; perm: string; type: string }>
  }
}

async function readAuditRecords(): Promise<Array<Record<string, unknown>>> {
  const dir = path.join(tmpHome, 'audit', 'feishu-writes')
  const files = await readdir(dir)
  const content = await readFile(path.join(dir, files[0]!), 'utf8')
  return content.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
}
