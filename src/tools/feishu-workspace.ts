import { z } from 'zod'

import { getFeishuClient, type FeishuClient } from '../channels/feishu/client.js'
import { feishuErrorMessage } from '../channels/feishu/resources/api.js'
import {
  createFolder,
  deleteFile,
  listFolder,
  moveFile,
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
} from '../channels/feishu/workspace/ops.js'
import { buildTool, type ToolCallResult } from '../tool.js'
import {
  auditFailed,
  recordFeishuWriteAudit,
  requireFeishuWriteConfirmation,
} from './feishu-collab.js'

const feishuListInputSchema = z.object({
  path: z.string().optional().describe('Optional subpath within your workspace, like "papers" or "projects/2026". Omit to list the workspace root.'),
  depth: z.number().int().min(1).max(5).optional().default(2).describe('Recursion depth. Default 2, capped at 5.'),
})

const feishuCreateFolderInputSchema = z.object({
  name: z.string().min(1).max(80).regex(/^[^/\\:]+$/, {
    message: 'Folder name cannot contain / \\ or :',
  }),
  parent_folder: z.string().optional().describe('Optional parent folder path within your workspace. Omit to create under workspace root.'),
})

const feishuDeleteInputSchema = z.object({
  target: z.string().min(1).describe('Name or path of the file/folder to delete within your workspace. Use FeishuList first to confirm.'),
})

const feishuMoveInputSchema = z.object({
  target: z.string().min(1).describe('Name or path of the doc/folder to move within your workspace.'),
  destination: z.string().describe('Destination folder path within your workspace. Use "/" or "." for workspace root.'),
})

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
      return { output: feishuErrorMessage(error), isError: true }
    }
  },
})

export const feishuCreateFolderTool = buildTool<FeishuCreateFolderInput, string>({
  name: 'FeishuCreateFolder',
  description:
    'Create a folder inside the current user private Feishu cloud workspace. Use one folder per project or long-running task. 中文：在当前用户的飞书工作区里创建文件夹。',
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
      return { output: feishuErrorMessage(error), isError: true }
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
      return { output: feishuErrorMessage(error), isError: true }
    }
  },
})

export const feishuMoveTool = buildTool<FeishuMoveInput, string>({
  name: 'FeishuMove',
  description:
    'Move a file or folder within the current user private Feishu cloud workspace. Source and destination must both stay inside this workspace. 中文：在当前用户的飞书工作区内部移动文件或文件夹。',
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
      return { output: feishuErrorMessage(error), isError: true }
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
  })
  await assertWithinWorkspace({
    ancestry: ctx.ancestry,
    token: folder.token,
    workspaceToken: ctx.workspace.folderToken,
    toolName: 'FeishuList',
  })
  const tree = await listWorkspaceTree({
    client: deps.client,
    folderToken: folder.token,
    prefix: folder.path,
    depth: input.depth ?? 2,
  })
  return {
    output: renderTree(tree, `Workspace: /LightClaw/${ctx.canonicalUser}${folder.path === '/' ? '/' : `/${folder.path}/`}`),
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
  })
  const ancestryChain = await assertWithinWorkspace({
    ancestry: ctx.ancestry,
    token: parent.token,
    workspaceToken: ctx.workspace.folderToken,
    toolName: 'FeishuCreateFolder',
  })
  const created = await createFolder({
    client: deps.client,
    parentFolderToken: parent.token,
    name: input.name,
  })
  ctx.ancestry.evict(parent.token)
  await recordFeishuWriteAudit({
    at: new Date().toISOString(),
    userId: ctx.canonicalUser,
    operation: 'create-folder',
    resource: {
      kind: 'folder',
      name: input.name,
      folderToken: created.folderToken,
      parentFolderToken: parent.token,
    },
    preview: `Create folder "${input.name}" under ${parent.path}.`,
    status: 'confirmed',
    ancestryChain,
  })
  return {
    output: `Created folder "${input.name}" at ${parent.path === '/' ? '/' : `${parent.path}/`}${input.name}/ (token=${created.folderToken}).`,
  }
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
  })
  const ancestryChain = await assertWithinWorkspace({
    ancestry: ctx.ancestry,
    token: target.token,
    workspaceToken: ctx.workspace.folderToken,
    toolName: 'FeishuDelete',
  }).catch(async error => {
    await auditBoundaryViolation(ctx.canonicalUser, 'FeishuDelete', input.target, error)
    throw error
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
  try {
    await deleteFile({ client: deps.client, token: target.token, type: target.type })
    ctx.ancestry.evict(target.token)
    await recordFeishuWriteAudit({
      at: new Date().toISOString(),
      userId: ctx.canonicalUser,
      operation: 'delete',
      resource,
      preview,
      status: 'confirmed',
      ancestryChain,
    })
    return { output: `Deleted ${displayType(target.type)} "${target.path}". Feishu retains it in trash for about 30 days.` }
  } catch (error) {
    await auditFailed('delete', preview, resource, error)
    throw error
  }
}

export async function runFeishuMove(
  input: FeishuMoveInput,
  deps: { client: FeishuClient },
): Promise<ToolCallResult<string>> {
  const ctx = await resolveCurrentFeishuWorkspace(deps.client)
  const source = await resolveEntryByNameOrPath({
    client: deps.client,
    workspaceToken: ctx.workspace.folderToken,
    target: input.target,
  })
  const dest = await resolveFolderPath({
    client: deps.client,
    workspaceToken: ctx.workspace.folderToken,
    path: input.destination,
  })
  const sourceAncestry = await assertWithinWorkspace({
    ancestry: ctx.ancestry,
    token: source.token,
    workspaceToken: ctx.workspace.folderToken,
    toolName: 'FeishuMove',
  }).catch(async error => {
    await auditBoundaryViolation(ctx.canonicalUser, 'FeishuMove', input.target, error)
    throw error
  })
  const destAncestry = await assertWithinWorkspace({
    ancestry: ctx.ancestry,
    token: dest.token,
    workspaceToken: ctx.workspace.folderToken,
    toolName: 'FeishuMove',
  }).catch(async error => {
    await auditBoundaryViolation(ctx.canonicalUser, 'FeishuMove', input.destination, error)
    throw error
  })
  if (source.type === 'folder' && destAncestry.includes(source.token)) {
    const error = new Error(`Cannot move "${source.path}" into its own subtree.`)
    await auditBoundaryViolation(ctx.canonicalUser, 'FeishuMove', input.destination, error, destAncestry)
    throw error
  }
  if (sourceAncestry[1] === dest.token) {
    return { output: `"${source.path}" is already in "${dest.path}". No move needed.` }
  }
  const existingInDest = await listFolder({ client: deps.client, folderToken: dest.token })
  if (existingInDest.items.some(item => item.name === source.name && item.token !== source.token)) {
    return {
      output: `Destination "${dest.path}" already contains an entry named "${source.name}". Delete or rename the existing entry first.`,
      isError: true,
    }
  }
  const descendantCount = source.type === 'folder'
    ? await countDescendants({ client: deps.client, folderToken: source.token })
    : 0
  const preview = source.type === 'folder'
    ? `Move folder "${source.path}" and ${descendantCount} contained item(s) to "${dest.path}".`
    : `Move ${displayType(source.type)} "${source.path}" to "${dest.path}".`
  const resource = {
    kind: source.type,
    name: source.name,
    token: source.token,
    sourcePath: source.path,
    destPath: dest.path,
    destFolderToken: dest.token,
  }
  await requireFeishuWriteConfirmation({ operation: 'move', preview, resource, deferConfirmedAudit: true })
  try {
    await moveFile({ client: deps.client, token: source.token, type: source.type, destFolderToken: dest.token })
    ctx.ancestry.evict(source.token)
    await recordFeishuWriteAudit({
      at: new Date().toISOString(),
      userId: ctx.canonicalUser,
      operation: 'move',
      resource,
      preview,
      status: 'confirmed',
      sourceAncestry,
      destAncestry,
    })
    return { output: `Moved "${source.path}" to "${dest.path}".` }
  } catch (error) {
    await auditFailed('move', preview, resource, error)
    throw error
  }
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
