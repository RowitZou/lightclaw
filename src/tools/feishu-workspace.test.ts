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

  // Regression: 0.3.4 dogfood (#5) — FeishuList renders the workspace root as
  // the breadcrumb `/LightClaw/<user>/<sub>`, the agent copies it straight
  // back as `path`, but path inputs resolve RELATIVE to the user's workspace
  // root. The echoed `LightClaw/alice/...` then looks for a literal `LightClaw`
  // sub-folder and fails with `Folder "LightClaw" does not exist`. The path is
  // now self-healed by stripping the echoed breadcrumb prefix. Pre-fix this
  // throws; post-fix it resolves the same folder as the bare path.
  it('self-heals a path that echoes the full /LightClaw/<user>/ breadcrumb', async () => {
    const client = makeClient({
      userFld: [item('papers', 'fldPapers', 'folder', 'userFld')],
      fldPapers: [item('draft.docx', 'docDraft', 'docx', 'fldPapers')],
    })
    const result = await withFeishuSession(() =>
      runFeishuList({ path: 'LightClaw/alice/papers', depth: 2 }, { client }),
    )
    assert.match(result.output, /Workspace: \/LightClaw\/alice\/papers\//)
    assert.match(result.output, /draft\.docx/)
  })

  it('self-heals a path that echoes only the bare <user>/ prefix', async () => {
    const client = makeClient({
      userFld: [item('papers', 'fldPapers', 'folder', 'userFld')],
      fldPapers: [item('draft.docx', 'docDraft', 'docx', 'fldPapers')],
    })
    const result = await withFeishuSession(() =>
      runFeishuList({ path: 'alice/papers', depth: 2 }, { client }),
    )
    assert.match(result.output, /Workspace: \/LightClaw\/alice\/papers\//)
    assert.match(result.output, /draft\.docx/)
  })

  // The strip is leading-prefix only: an interior folder that happens to be
  // named after the breadcrumb is left intact.
  it('does not strip a non-leading folder named like the breadcrumb root', async () => {
    const client = makeClient({
      userFld: [item('papers', 'fldPapers', 'folder', 'userFld')],
      fldPapers: [item('LightClaw', 'fldNested', 'folder', 'fldPapers')],
      fldNested: [item('keep.docx', 'docKeep', 'docx', 'fldNested')],
    })
    const result = await withFeishuSession(() =>
      runFeishuList({ path: 'papers/LightClaw', depth: 2 }, { client }),
    )
    assert.match(result.output, /Workspace: \/LightClaw\/alice\/papers\/LightClaw\//)
    assert.match(result.output, /keep\.docx/)
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

  // Regression: deployed dogfood (zouyicheng_62236ecd) — the model holds a
  // doc as a pasted Feishu URL and passes it as `target`. Pre-fix the URL
  // contains "/" so it routed to path resolution, split on "//", and reported
  // the nonsense `Folder "https:" does not exist`. A URL now resolves by token
  // (still ancestry-gated by the same walk that warms the ParentCache).
  it('deletes a workspace doc addressed by a pasted Feishu URL', async () => {
    const client = makeClient({
      userFld: [item('notes.docx', 'docNotes', 'docx', 'userFld')],
    })
    const result = await withFeishuSession(
      () => runFeishuDelete({ target: 'https://feishu.cn/docx/docNotes' }, { client }),
    )
    assert.match(result.output, /Deleted doc "notes\.docx"/)
    assert.deepEqual(client.deleted, ['docNotes'])
  })

  // A Feishu document title may contain "/", which name/path resolution can
  // never address (it splits on the workspace path separator). The URL/token
  // path sidesteps that — the only way to delete such a doc.
  it('deletes a doc whose Feishu title contains a slash, via URL', async () => {
    const client = makeClient({
      userFld: [item('2026/finals.docx', 'docCup', 'docx', 'userFld')],
    })
    const result = await withFeishuSession(
      () => runFeishuDelete({ target: 'https://feishu.cn/docx/docCup' }, { client }),
    )
    assert.match(result.output, /Deleted doc "2026\/finals\.docx"/)
    assert.deepEqual(client.deleted, ['docCup'])
  })

  // A bare resource token (as printed by FeishuList `token=...`) is accepted
  // as a fallback after no name matches.
  it('deletes a workspace doc addressed by a bare resource token', async () => {
    const client = makeClient({
      userFld: [item('notes.docx', 'docNotesLongToken000', 'docx', 'userFld')],
    })
    const result = await withFeishuSession(
      () => runFeishuDelete({ target: 'docNotesLongToken000' }, { client }),
    )
    assert.match(result.output, /Deleted doc "notes\.docx"/)
    assert.deepEqual(client.deleted, ['docNotesLongToken000'])
  })

  // A URL pointing outside the user workspace is never found by the walk, so
  // it is refused with a clear message rather than a confusing path error.
  it('refuses a Feishu URL whose token is not inside the workspace', async () => {
    const client = makeClient({
      userFld: [item('notes.docx', 'docNotes', 'docx', 'userFld')],
    })
    await assert.rejects(
      withFeishuSession(() => runFeishuDelete({ target: 'https://feishu.cn/docx/docOutside' }, { client })),
      /Could not find that Feishu resource inside your workspace/,
    )
    assert.deepEqual(client.deleted, [])
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
    assert.equal((records[0].resource as Record<string, unknown>).mode, 'move')
    assert.equal((records[0].resource as Record<string, unknown>).moved, true)
    assert.equal((records[0].resource as Record<string, unknown>).renamed, false)
    assert.deepEqual(records[0].sourceAncestry, ['docNotes', 'userFld', 'rootFld'])
    assert.deepEqual(records[0].destAncestry, ['fldPapers', 'userFld', 'rootFld'])
  })

  it('renames workspace docs in place after confirmation', async () => {
    const client = makeClient({
      userFld: [item('notes.docx', 'docNotes', 'docx', 'userFld')],
    })
    const result = await withFeishuSession(
      () => runFeishuMove({ target: 'notes.docx', new_name: 'archive.docx' }, { client }),
      { ask: async () => ({ behavior: 'allow' }) },
    )
    assert.match(result.output, /Renamed "notes\.docx" to "archive\.docx"/)
    assert.deepEqual(client.renamed, [{ token: 'docNotes', name: 'archive.docx' }])
    const records = await readAuditRecords()
    assert.equal(records[0].operation, 'move')
    assert.equal(records[0].status, 'confirmed')
    const resource = records[0].resource as Record<string, unknown>
    assert.equal(resource.mode, 'rename')
    assert.equal(resource.oldTitle, 'notes.docx')
    assert.equal(resource.newTitle, 'archive.docx')
    assert.equal(resource.moved, false)
    assert.equal(resource.renamed, true)
  })

  it('moves then renames workspace docs when both fields are set', async () => {
    const client = makeClient({
      userFld: [
        item('papers', 'fldPapers', 'folder', 'userFld'),
        item('notes.docx', 'docNotes', 'docx', 'userFld'),
      ],
      fldPapers: [],
    })
    const result = await withFeishuSession(
      () => runFeishuMove({ target: 'notes.docx', destination: 'papers', new_name: 'archive.docx' }, { client }),
      { ask: async () => ({ behavior: 'allow' }) },
    )
    assert.match(result.output, /Moved "notes\.docx" to "papers" and renamed it to "archive\.docx"/)
    assert.deepEqual(client.moved, [{ token: 'docNotes', dest: 'fldPapers' }])
    assert.deepEqual(client.renamed, [{ token: 'docNotes', name: 'archive.docx' }])
    const records = await readAuditRecords()
    const resource = records[0].resource as Record<string, unknown>
    assert.equal(resource.mode, 'move-and-rename')
    assert.equal(resource.moved, true)
    assert.equal(resource.renamed, true)
  })

  it('returns partial WorkerFailure when move succeeds but rename fails', async () => {
    const client = makeClient({
      userFld: [
        item('papers', 'fldPapers', 'folder', 'userFld'),
        item('notes.docx', 'docNotes', 'docx', 'userFld'),
      ],
      fldPapers: [],
    }, {
      renameError: new Error('rename rejected'),
    })
    const result = await withFeishuSession(
      () => runFeishuMove({ target: 'notes.docx', destination: 'papers', new_name: 'archive.docx' }, { client }),
      { ask: async () => ({ behavior: 'allow' }) },
    )
    assert.equal(result.isError, true)
    const envelope = JSON.parse(result.output) as {
      reason: string
      partial_result: Record<string, unknown>
    }
    assert.equal(envelope.reason, 'feishu-partial-update')
    assert.deepEqual(envelope.partial_result, {
      moved: true,
      renamed: false,
      oldTitle: 'notes.docx',
      newName: 'archive.docx',
      oldParentPath: '/',
      newParentPath: 'papers',
    })
    const records = await readAuditRecords()
    assert.equal(records[0].status, 'partial')
    assert.equal((records[0].resource as Record<string, unknown>).mode, 'move-and-rename')
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

  it('rejects rename when effective destination already has the new name', async () => {
    const client = makeClient({
      userFld: [
        item('notes.docx', 'docNotes', 'docx', 'userFld'),
        item('archive.docx', 'docArchive', 'docx', 'userFld'),
      ],
    })
    const result = await withFeishuSession(
      () => runFeishuMove({ target: 'notes.docx', new_name: 'archive.docx' }, { client }),
      { ask: async () => ({ behavior: 'allow' }) },
    )
    assert.equal(result.isError, true)
    assert.match(result.output, /already contains an entry named "archive\.docx"/)
    assert.deepEqual(client.renamed, [])
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
    await mkdir(path.join(home, 'users', 'alice', 'state'), { recursive: true })
    await writeFile(path.join(home, 'feishu-cloud-root.json'), JSON.stringify({
      folderToken: 'rootFld',
      createdAt: '2026-05-12T00:00:00.000Z',
      lightclawVersion: 'test',
    }))
    await writeFile(path.join(home, 'users', 'alice', 'state', 'feishu-workspace.json'), JSON.stringify({
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
        resourceGrantTarget: { chatId: 'oc_grp', senderOpenId: 'ou_alice' },
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
    renameError?: Error
  } = {},
): FeishuClient & {
  deleted: string[]
  moved: Array<{ token: string; dest: string }>
  renamed: Array<{ token: string; name: string }>
  grants: Array<{ token: string; memberId: string; memberType: string; perm: string; type: string }>
} {
  const deleted: string[] = []
  const moved: Array<{ token: string; dest: string }> = []
  const renamed: Array<{ token: string; name: string }> = []
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
    renamed,
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
          update: async (input: {
            path?: { file_token?: string }
            data?: { name?: string; title?: string }
            request_body?: { title?: string }
          }) => {
            if (errors.renameError) {
              throw errors.renameError
            }
            const token = input.path?.file_token ?? ''
            const name = input.data?.name ?? input.data?.title ?? input.request_body?.title ?? ''
            renamed.push({ token, name })
            const entry = byToken.get(token)
            if (entry) {
              entry.name = name
            }
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
    renamed: Array<{ token: string; name: string }>
    grants: Array<{ token: string; memberId: string; memberType: string; perm: string; type: string }>
  }
}

async function readAuditRecords(): Promise<Array<Record<string, unknown>>> {
  const dir = path.join(tmpHome, 'audit', 'feishu-writes')
  const files = await readdir(dir)
  const content = await readFile(path.join(dir, files[0]!), 'utf8')
  return content.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
}
