import { z } from 'zod'

import {
  auditFailed,
  recordFeishuWriteAudit,
  type FeishuPermissionGrants,
} from '../audit/feishu-writes.js'
import { getFeishuClient, type FeishuClient } from '../channels/feishu/client.js'
import {
  createFolder,
  deleteFile,
  grantFolderPermission,
  listFolder,
  moveFile,
  renameFile,
  type FeishuDriveItemType,
} from '../channels/feishu/resources/folder.js'
import {
  assertWithinWorkspace,
  countDescendants,
  listWorkspaceTree,
  renderTree,
  resolveCurrentFeishuWorkspace,
  resolveEntryByNameOrPath,
  resolveFolderPath,
  WORKSPACE_BREADCRUMB_ROOT,
} from '../channels/feishu/workspace/ops.js'
import { feishuShareUrl } from '../channels/feishu/url.js'
import { buildTool, type ToolCallResult } from '../tool.js'
import {
  feishuToolErrorMessage,
  requireFeishuWriteConfirmation,
  resolveSenderOpenIdForGrant,
} from './feishu-collab.js'

const feishuListInputSchema = z.object({
  path: z.string().optional().describe('Optional subpath within your workspace, like "papers" or "projects/2026". Omit to list the workspace root.'),
  depth: z.number().int().min(1).max(5).optional().default(2).describe('Recursion depth. Default 2, capped at 5.'),
})

const feishuCreateFolderInputSchema = z.object({
  name: z.string().trim().min(1).max(80).regex(/^[^/\\:]+$/, {
    message: 'Folder name cannot contain / \\ or :',
  }),
  parent_folder: z.string().optional().describe('Optional parent folder path within your workspace. Omit to create under workspace root.'),
})

const feishuDeleteInputSchema = z.object({
  target: z.string().min(1).describe('Name or path of the file/folder to delete within your workspace. Use FeishuList first to confirm.'),
})

const feishuMoveInputSchema = z.object({
  target: z.string().min(1).describe('Name or path of the doc/folder to move and/or rename within your workspace.'),
  destination: z.string().optional().describe('Destination folder path within your workspace. Use "/" or "." for workspace root. Omit when only renaming in place.'),
  new_name: z.string().trim().min(1).max(80).regex(/^[^/\\:]+$/, {
    message: 'New name cannot contain / \\ or :',
  }).optional().describe('New basename for the doc/folder. Omit when only moving without renaming.'),
}).refine(
  data => data.destination !== undefined || data.new_name !== undefined,
  { message: 'at least one of destination / new_name must be set' },
)

export type FeishuListInput = z.infer<typeof feishuListInputSchema>
export type FeishuCreateFolderInput = z.infer<typeof feishuCreateFolderInputSchema>
export type FeishuDeleteInput = z.infer<typeof feishuDeleteInputSchema>
export type FeishuMoveInput = z.infer<typeof feishuMoveInputSchema>

export const feishuListTool = buildTool<FeishuListInput, string>({
  name: 'FeishuList',
  description:
    'List files and folders inside the current user private Feishu cloud workspace. Use this before creating docs to avoid duplicates, or when the user asks what is in their workspace. 中文：列出当前用户的飞书私有工作区文件和文件夹；用户问“工作区里有什么 / 清理一下”时调用。',
  domain: 'host',
  riskLevel: 'safe',
  channelScope: ['feishu'],
  shouldDefer: true,
  searchHint: 'feishu lark list folder workspace cloud drive files',
  inputSchema: feishuListInputSchema,
  async call(input): Promise<ToolCallResult<string>> {
    try {
      return await runFeishuList(input, { client: getFeishuClient() })
    } catch (error) {
      return { output: feishuToolErrorMessage(error), isError: true }
    }
  },
})

export const feishuCreateFolderTool = buildTool<FeishuCreateFolderInput, string>({
  name: 'FeishuCreateFolder',
  description:
    'Create a folder inside the current user private Feishu cloud workspace. Use one folder per project or long-running task. The returned output includes a clickable https://feishu.cn/drive/folder/... URL — share that URL with the user when telling them where the folder is, never the raw token. 中文：在当前用户的飞书工作区里创建文件夹。',
  domain: 'host',
  riskLevel: 'write',
  channelScope: ['feishu'],
  shouldDefer: true,
  searchHint: 'feishu lark create folder workspace cloud drive directory',
  inputSchema: feishuCreateFolderInputSchema,
  async call(input): Promise<ToolCallResult<string>> {
    try {
      return await runFeishuCreateFolder(input, { client: getFeishuClient() })
    } catch (error) {
      return { output: feishuToolErrorMessage(error), isError: true }
    }
  },
})

export const feishuDeleteTool = buildTool<FeishuDeleteInput, string>({
  name: 'FeishuDelete',
  description:
    'Delete a file or folder inside the current user private Feishu cloud workspace. This asks the user for explicit confirmation. Feishu keeps deleted items in trash for about 30 days. 中文：删除当前用户飞书工作区内的文件或文件夹；会先弹确认卡。',
  domain: 'host',
  riskLevel: 'write',
  channelScope: ['feishu'],
  shouldDefer: true,
  searchHint: 'feishu lark delete remove trash workspace cloud file folder',
  inputSchema: feishuDeleteInputSchema,
  async call(input): Promise<ToolCallResult<string>> {
    try {
      return await runFeishuDelete(input, { client: getFeishuClient() })
    } catch (error) {
      return { output: feishuToolErrorMessage(error), isError: true }
    }
  },
})

export const feishuMoveTool = buildTool<FeishuMoveInput, string>({
  name: 'FeishuMove',
  description:
    'Move and / or rename a file or folder within the current user private Feishu cloud workspace — Unix `mv` semantics. Provide `destination` to relocate, `new_name` to rename, or both to do both atomically (move runs first, then rename). At least one of `destination` / `new_name` is required. Source and destination must both stay inside this workspace. When both fields are set and only the rename leg fails, the tool returns `WorkerFailure` with `partial_result` so the caller can retry the rename alone. 中文：在当前用户的飞书工作区内部移动 (`destination`) 和 / 或重命名 (`new_name`) 文件或文件夹（Unix `mv` 同款），两个字段至少给一个。',
  domain: 'host',
  riskLevel: 'write',
  channelScope: ['feishu'],
  shouldDefer: true,
  searchHint: 'feishu lark move organize folder workspace cloud drive',
  inputSchema: feishuMoveInputSchema,
  async call(input): Promise<ToolCallResult<string>> {
    try {
      return await runFeishuMove(input, { client: getFeishuClient() })
    } catch (error) {
      return { output: feishuToolErrorMessage(error), isError: true }
    }
  },
})

export async function runFeishuList(
  input: FeishuListInput,
  deps: { client: FeishuClient },
): Promise<ToolCallResult<string>> {
  const ctx = await resolveCurrentFeishuWorkspace(deps.client)
  const folder = await resolveFolderPath({
    client: deps.client,
    workspaceToken: ctx.workspace.folderToken,
    path: input.path,
    canonicalUser: ctx.canonicalUser,
  })
  await assertWithinWorkspaceOrAudit({
    ancestry: ctx.ancestry,
    token: folder.token,
    workspaceToken: ctx.workspace.folderToken,
    toolName: 'FeishuList',
    canonicalUser: ctx.canonicalUser,
    attemptedTarget: input.path ?? '/',
  })
  const tree = await listWorkspaceTree({
    client: deps.client,
    folderToken: folder.token,
    prefix: folder.path,
    depth: input.depth ?? 2,
  })
  return {
    output: renderTree(tree, `Workspace: /${WORKSPACE_BREADCRUMB_ROOT}/${ctx.canonicalUser}${folder.path === '/' ? '/' : `/${folder.path}/`}`),
  }
}

export async function runFeishuCreateFolder(
  input: FeishuCreateFolderInput,
  deps: { client: FeishuClient },
): Promise<ToolCallResult<string>> {
  const ctx = await resolveCurrentFeishuWorkspace(deps.client)
  const parent = await resolveFolderPath({
    client: deps.client,
    workspaceToken: ctx.workspace.folderToken,
    path: input.parent_folder,
    canonicalUser: ctx.canonicalUser,
  })
  const ancestryChain = await assertWithinWorkspaceOrAudit({
    ancestry: ctx.ancestry,
    token: parent.token,
    workspaceToken: ctx.workspace.folderToken,
    toolName: 'FeishuCreateFolder',
    canonicalUser: ctx.canonicalUser,
    attemptedTarget: input.parent_folder ?? '/',
  })
  // Refuse to create a duplicate-named folder. Feishu allows multiple
  // siblings with the same name, which silently pollutes the workspace:
  // FeishuList shows ambiguous siblings and any subsequent name-based
  // resolution (FeishuMove / FeishuDelete) errors out as "ambiguous,
  // disambiguate by path". Pre-checking here is cheaper than cleaning up
  // duplicates later.
  const existing = await listFolder({ client: deps.client, folderToken: parent.token })
  const collision = existing.items.find(child => child.name === input.name && child.type === 'folder')
  if (collision) {
    return {
      output: `A folder named "${input.name}" already exists at ${parent.path === '/' ? '/' : `${parent.path}/`}. Use FeishuList to see the contents, or pick a different name.`,
      isError: true,
    }
  }
  const preview = `Create folder "${input.name}" under ${parent.path}.`
  const baseResource: Record<string, unknown> = {
    kind: 'folder',
    name: input.name,
    parentFolderToken: parent.token,
  }
  const retryCounter = { count: 0 }
  try {
    const created = await createFolder({
      client: deps.client,
      parentFolderToken: parent.token,
      name: input.name,
      retryCounter,
    })
    ctx.ancestry.evict(parent.token)
    // Grant the current sender full_access on the new sub-folder. Feishu
    // folder collaborators are not inherited from the parent at SDK create
    // time, so a child folder created without explicit grant is bot-only —
    // even though the user can see the parent (which has its own grant).
    // The breadcrumb then hides the new sub-folder from the user, and any
    // doc placed inside it appears to have no parent in Feishu UI. Chat
    // grant is intentionally skipped on folders: a chat:view rule on a
    // private workspace folder would let every group member browse the
    // user's entire doc list through the breadcrumb.
    const grants = await grantFolderToSenderBestEffort(deps.client, created.folderToken)
    await recordFeishuWriteAudit({
      at: new Date().toISOString(),
      userId: ctx.canonicalUser,
      operation: 'create-folder',
      resource: { ...baseResource, folderToken: created.folderToken },
      preview,
      status: 'confirmed',
      ancestryChain,
      ...(hasGrantContent(grants) ? { permissionGrants: grants } : {}),
      ...(retryCounter.count > 0 ? { retries: retryCounter.count } : {}),
    })
    return {
      output: `Created folder "${input.name}" at ${parent.path === '/' ? '/' : `${parent.path}/`}${input.name}/. URL: ${feishuShareUrl('folder', created.folderToken)} (token=${created.folderToken}).`,
    }
  } catch (error) {
    await auditFailed('create-folder', preview, baseResource, error, { ancestryChain, retries: retryCounter.count })
    throw error
  }
}

async function grantFolderToSenderBestEffort(
  client: FeishuClient,
  folderToken: string,
): Promise<FeishuPermissionGrants> {
  const { openId } = await resolveSenderOpenIdForGrant()
  if (!openId) {
    return { user: 'skipped-no-binding' }
  }
  const result = await grantFolderPermission({
    client,
    folderToken,
    openId,
    perm: 'full_access',
  })
  if (result.ok || result.alreadyExists) {
    return { user: 'full_access' }
  }
  return { user: 'failed', errors: [`user-grant: ${result.error}`] }
}

function hasGrantContent(grants: FeishuPermissionGrants): boolean {
  return Boolean(grants.chat || grants.user || grants.errors?.length)
}

export async function runFeishuDelete(
  input: FeishuDeleteInput,
  deps: { client: FeishuClient },
): Promise<ToolCallResult<string>> {
  const ctx = await resolveCurrentFeishuWorkspace(deps.client)
  const target = await resolveEntryByNameOrPath({
    client: deps.client,
    workspaceToken: ctx.workspace.folderToken,
    target: input.target,
    canonicalUser: ctx.canonicalUser,
  })
  const ancestryChain = await assertWithinWorkspaceOrAudit({
    ancestry: ctx.ancestry,
    token: target.token,
    workspaceToken: ctx.workspace.folderToken,
    toolName: 'FeishuDelete',
    canonicalUser: ctx.canonicalUser,
    attemptedTarget: input.target,
  })
  const descendantCount = target.type === 'folder'
    ? await countDescendants({ client: deps.client, folderToken: target.token })
    : 0
  const preview = target.type === 'folder'
    ? `Delete folder "${target.path}" and ${descendantCount} contained item(s). Feishu keeps deleted items in trash for about 30 days.`
    : `Delete ${displayType(target.type)} "${target.path}". Feishu keeps deleted items in trash for about 30 days.`
  const resource = {
    kind: target.type,
    name: target.name,
    path: target.path,
    token: target.token,
    ...(target.type === 'folder' ? { descendantCount } : {}),
  }
  await requireFeishuWriteConfirmation({ operation: 'delete', preview, resource, deferConfirmedAudit: true })
  const retryCounter = { count: 0 }
  try {
    await deleteFile({ client: deps.client, token: target.token, type: target.type, retryCounter })
    ctx.ancestry.evict(target.token)
    await recordFeishuWriteAudit({
      at: new Date().toISOString(),
      userId: ctx.canonicalUser,
      operation: 'delete',
      resource,
      preview,
      status: 'confirmed',
      ancestryChain,
      ...(retryCounter.count > 0 ? { retries: retryCounter.count } : {}),
    })
    return { output: `Deleted ${displayType(target.type)} "${target.path}". Feishu retains it in trash for about 30 days.` }
  } catch (error) {
    await auditFailed('delete', preview, resource, error, { ancestryChain, retries: retryCounter.count })
    throw error
  }
}

export async function runFeishuMove(
  input: FeishuMoveInput,
  deps: { client: FeishuClient },
): Promise<ToolCallResult<string>> {
  const ctx = await resolveCurrentFeishuWorkspace(deps.client)
  const shouldMove = input.destination !== undefined
  const shouldRename = input.new_name !== undefined
  const source = await resolveEntryByNameOrPath({
    client: deps.client,
    workspaceToken: ctx.workspace.folderToken,
    target: input.target,
    canonicalUser: ctx.canonicalUser,
  })
  const sourceAncestry = await assertWithinWorkspaceOrAudit({
    ancestry: ctx.ancestry,
    token: source.token,
    workspaceToken: ctx.workspace.folderToken,
    toolName: 'FeishuMove',
    canonicalUser: ctx.canonicalUser,
    attemptedTarget: input.target,
  })
  const currentParentToken = sourceAncestry[1]
  if (!currentParentToken) {
    throw new Error(`Cannot move or rename "${source.path}" because its parent folder is unknown.`)
  }
  const dest = shouldMove
    ? await resolveFolderPath({
        client: deps.client,
        workspaceToken: ctx.workspace.folderToken,
        path: input.destination,
        canonicalUser: ctx.canonicalUser,
      })
    : { token: currentParentToken, path: parentPath(source.path) }
  const destAncestry = shouldMove
    ? await assertWithinWorkspaceOrAudit({
        ancestry: ctx.ancestry,
        token: dest.token,
        workspaceToken: ctx.workspace.folderToken,
        toolName: 'FeishuMove',
        canonicalUser: ctx.canonicalUser,
        attemptedTarget: input.destination ?? '/',
      })
    : ctx.ancestry.ancestryChain(dest.token)
  if (shouldMove && source.type === 'folder' && destAncestry.includes(source.token)) {
    const error = new Error(`Cannot move "${source.path}" into its own subtree.`)
    await auditBoundaryViolation(ctx.canonicalUser, 'FeishuMove', input.destination ?? '/', error, destAncestry)
    throw error
  }
  if (shouldMove && !shouldRename && currentParentToken === dest.token) {
    return { output: `"${source.path}" is already in "${dest.path}". No move needed.` }
  }
  const existingInDest = await listFolder({ client: deps.client, folderToken: dest.token })
  const effectiveName = input.new_name ?? source.name
  if (existingInDest.items.some(item => item.name === effectiveName && item.token !== source.token)) {
    return {
      output: `Destination "${dest.path}" already contains an entry named "${effectiveName}". Delete or rename the existing entry first.`,
      isError: true,
    }
  }
  const descendantCount = source.type === 'folder'
    ? await countDescendants({ client: deps.client, folderToken: source.token })
    : 0
  const mode = shouldMove && shouldRename
    ? 'move-and-rename'
    : shouldRename
      ? 'rename'
      : 'move'
  const preview = formatMovePreview({
    type: source.type,
    sourcePath: source.path,
    destPath: dest.path,
    newName: input.new_name,
    descendantCount,
    mode,
  })
  const resource = {
    kind: source.type,
    name: source.name,
    token: source.token,
    sourcePath: source.path,
    oldTitle: source.name,
    mode,
    moved: shouldMove,
    renamed: shouldRename,
    ...(shouldMove ? { destPath: dest.path, destFolderToken: dest.token } : {}),
    ...(shouldRename ? { newTitle: input.new_name } : {}),
  }
  await requireFeishuWriteConfirmation({ operation: 'move', preview, resource, deferConfirmedAudit: true })
  const retryCounter = { count: 0 }
  let moved = false
  let renamed = false
  try {
    if (shouldMove) {
      await moveFile({ client: deps.client, token: source.token, type: source.type, destFolderToken: dest.token, retryCounter })
      moved = true
    }
    if (shouldRename) {
      await renameFile({ client: deps.client, token: source.token, type: source.type, name: input.new_name!, retryCounter })
      renamed = true
    }
    ctx.ancestry.evict(source.token)
    await recordFeishuWriteAudit({
      at: new Date().toISOString(),
      userId: ctx.canonicalUser,
      operation: 'move',
      resource: { ...resource, moved, renamed },
      preview,
      status: 'confirmed',
      sourceAncestry,
      destAncestry,
      ...(retryCounter.count > 0 ? { retries: retryCounter.count } : {}),
    })
    return { output: formatMoveSuccess({ sourcePath: source.path, destPath: dest.path, newName: input.new_name, mode }) }
  } catch (error) {
    ctx.ancestry.evict(source.token)
    if (shouldMove && shouldRename && moved && !renamed) {
      await recordFeishuWriteAudit({
        at: new Date().toISOString(),
        userId: ctx.canonicalUser,
        operation: 'move',
        resource: { ...resource, moved: true, renamed: false },
        preview,
        status: 'partial',
        sourceAncestry,
        destAncestry,
        error: error instanceof Error ? error.message : String(error),
        ...(retryCounter.count > 0 ? { retries: retryCounter.count } : {}),
      })
      return {
        output: JSON.stringify({
          status: 'failed',
          reason: 'feishu-partial-update',
          partial_result: {
            moved: true,
            renamed: false,
            oldTitle: source.name,
            newName: input.new_name,
            oldParentPath: parentPath(source.path),
            newParentPath: dest.path,
          },
          message: `move succeeded but rename failed: ${feishuToolErrorMessage(error)}`,
        }, null, 2),
        isError: true,
      }
    }
    await auditFailed('move', preview, resource, error, { sourceAncestry, destAncestry, retries: retryCounter.count })
    throw error
  }
}

function parentPath(workspacePath: string): string {
  if (workspacePath === '/' || !workspacePath.includes('/')) {
    return '/'
  }
  return workspacePath.slice(0, workspacePath.lastIndexOf('/')) || '/'
}

function formatMovePreview(input: {
  type: FeishuDriveItemType
  sourcePath: string
  destPath: string
  newName?: string
  descendantCount: number
  mode: 'move' | 'rename' | 'move-and-rename'
}): string {
  const label = input.type === 'folder'
    ? `folder "${input.sourcePath}" and ${input.descendantCount} contained item(s)`
    : `${displayType(input.type)} "${input.sourcePath}"`
  if (input.mode === 'rename') {
    return `Rename ${label} to "${input.newName}".`
  }
  if (input.mode === 'move-and-rename') {
    return `Move ${label} to "${input.destPath}" and rename it to "${input.newName}".`
  }
  return `Move ${label} to "${input.destPath}".`
}

function formatMoveSuccess(input: {
  sourcePath: string
  destPath: string
  newName?: string
  mode: 'move' | 'rename' | 'move-and-rename'
}): string {
  if (input.mode === 'rename') {
    return `Renamed "${input.sourcePath}" to "${input.newName}".`
  }
  if (input.mode === 'move-and-rename') {
    return `Moved "${input.sourcePath}" to "${input.destPath}" and renamed it to "${input.newName}".`
  }
  return `Moved "${input.sourcePath}" to "${input.destPath}".`
}

async function auditBoundaryViolation(
  userId: string,
  attemptedTool: string,
  attemptedTarget: string,
  error: unknown,
  ancestryChain?: string[],
): Promise<void> {
  await recordFeishuWriteAudit({
    at: new Date().toISOString(),
    userId,
    operation: 'boundary-violation',
    boundaryViolation: {
      attemptedTool,
      attemptedTarget,
      reason: error instanceof Error ? error.message : String(error),
    },
    ancestryChain: ancestryChain ?? (error as { ancestryChain?: string[] })?.ancestryChain ?? [],
  })
}

function displayType(type: FeishuDriveItemType): string {
  if (type === 'docx' || type === 'doc') return 'doc'
  return type
}

/**
 * `assertWithinWorkspace` is now synchronous (`ParentCache.ancestryChain` is
 * an in-memory walk), but its boundary-violation audit is async. Wrap the
 * pair so call sites can `await` once and stay readable.
 */
async function assertWithinWorkspaceOrAudit(input: {
  ancestry: import('../channels/feishu/workspace/ancestry.js').ParentCache
  token: string
  workspaceToken: string
  toolName: string
  canonicalUser: string
  attemptedTarget: string
}): Promise<string[]> {
  try {
    return assertWithinWorkspace({
      ancestry: input.ancestry,
      token: input.token,
      workspaceToken: input.workspaceToken,
      toolName: input.toolName,
    })
  } catch (error) {
    await auditBoundaryViolation(input.canonicalUser, input.toolName, input.attemptedTarget, error)
    throw error
  }
}
