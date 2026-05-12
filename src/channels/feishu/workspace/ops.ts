import type { FeishuClient } from '../client.js'
import { getIdentity } from '../../../identity/store.js'
import { getCurrentUserId } from '../../../state.js'
import {
  listFolder,
  type FeishuDriveItemType,
  type FeishuFolderItem,
} from '../resources/folder.js'
import { createAncestryResolver, type AncestryResolver } from './ancestry.js'
import {
  getOrCreateUserWorkspace,
  getOrCreateWorkspaceRoot,
  type UserWorkspace,
  type WorkspaceRoot,
} from './lifecycle.js'

// Module-level singleton keyed by FeishuClient identity. The whole point of
// `createAncestryResolver`'s 5-min LRU is to amortize getMetadata HTTP calls
// across tool invocations within the same daemon process. Instantiating per
// tool call collapses the TTL to the ~100 ms it takes one tool call to finish
// and defeats the cache. The bot keeps one long-lived FeishuClient per Feishu
// channel runner, so a WeakMap keyed on client is correct: when a client is
// GC'd the resolver goes with it; live clients keep one resolver each.
let resolverByClient: WeakMap<FeishuClient, AncestryResolver> = new WeakMap()

export function getAncestryResolver(client: FeishuClient): AncestryResolver {
  let resolver = resolverByClient.get(client)
  if (!resolver) {
    resolver = createAncestryResolver(client)
    resolverByClient.set(client, resolver)
  }
  return resolver
}

/** Test-only: drop all cached resolvers so the next call rebuilds. */
export function resetAncestryResolversForTest(): void {
  resolverByClient = new WeakMap()
}

export type FeishuWorkspaceContext = {
  canonicalUser: string
  ownerOpenId: string
  root: WorkspaceRoot
  workspace: UserWorkspace
  ancestry: AncestryResolver
}

export type WorkspaceTreeEntry = FeishuFolderItem & {
  path: string
  children?: WorkspaceTreeEntry[]
  depthCapped?: boolean
  childCount?: number
}

export async function resolveCurrentFeishuWorkspace(
  client: FeishuClient,
): Promise<FeishuWorkspaceContext> {
  const canonicalUser = getCurrentUserId()
  if (!canonicalUser) {
    throw new Error('requires-feishu-binding: current LightClaw user is not bound.')
  }
  const identity = await getIdentity(canonicalUser)
  const ownerOpenId = identity?.channels.feishu[0]
  if (!ownerOpenId) {
    throw new Error(`requires-feishu-binding: ${canonicalUser} has no Feishu open_id binding.`)
  }
  const root = await getOrCreateWorkspaceRoot(client)
  const workspace = await getOrCreateUserWorkspace(client, canonicalUser, ownerOpenId, root)
  return {
    canonicalUser,
    ownerOpenId,
    root,
    workspace,
    ancestry: getAncestryResolver(client),
  }
}

export function normalizeWorkspacePath(input: string | undefined): string[] {
  const raw = (input ?? '').trim()
  if (!raw || raw === '.' || raw === '/') {
    return []
  }
  const parts = raw.split('/').map(part => part.trim()).filter(Boolean)
  for (const part of parts) {
    if (part === '..' || part.includes('\\') || part.includes('\0')) {
      throw new Error('Workspace path must stay inside the Feishu workspace and cannot contain ".." or backslashes.')
    }
  }
  return parts
}

export async function resolveFolderPath(input: {
  client: FeishuClient
  workspaceToken: string
  path?: string
}): Promise<{ token: string; path: string; item?: FeishuFolderItem }> {
  const parts = normalizeWorkspacePath(input.path)
  let folderToken = input.workspaceToken
  let rendered = ''
  let item: FeishuFolderItem | undefined
  for (const part of parts) {
    const children = await listFolder({ client: input.client, folderToken })
    const matches = children.items.filter(child => child.type === 'folder' && child.name === part)
    if (matches.length === 0) {
      throw new Error(`Folder "${part}" does not exist. Use FeishuList first, or create it with FeishuCreateFolder.`)
    }
    if (matches.length > 1) {
      throw new Error(`Folder "${part}" is ambiguous. Use a more specific path.`)
    }
    item = matches[0]
    folderToken = item!.token
    rendered = rendered ? `${rendered}/${part}` : part
  }
  return { token: folderToken, path: rendered || '/', ...(item ? { item } : {}) }
}

export async function resolveEntryPath(input: {
  client: FeishuClient
  workspaceToken: string
  target: string
}): Promise<WorkspaceTreeEntry> {
  const parts = normalizeWorkspacePath(input.target)
  if (parts.length === 0) {
    return {
      token: input.workspaceToken,
      name: '/',
      type: 'folder',
      path: '/',
    }
  }
  const leaf = parts.at(-1)!
  const parentPath = parts.slice(0, -1).join('/')
  const parent = await resolveFolderPath({
    client: input.client,
    workspaceToken: input.workspaceToken,
    path: parentPath,
  })
  const children = await listFolder({ client: input.client, folderToken: parent.token })
  const matches = children.items.filter(child => child.name === leaf)
  if (matches.length === 0) {
    throw new Error(`Could not find "${input.target}" in the Feishu workspace. Use FeishuList to confirm the target.`)
  }
  if (matches.length > 1) {
    throw new Error(`Found ${matches.length} entries named "${leaf}". Use a more specific path.`)
  }
  const item = matches[0]!
  return {
    ...item,
    path: parent.path === '/' ? item.name : `${parent.path}/${item.name}`,
  }
}

export async function findEntriesByName(input: {
  client: FeishuClient
  workspaceToken: string
  name: string
  maxDepth?: number
}): Promise<WorkspaceTreeEntry[]> {
  const needle = input.name.trim()
  const found: WorkspaceTreeEntry[] = []
  async function walk(folderToken: string, prefix: string, depth: number): Promise<void> {
    if (depth > (input.maxDepth ?? 5)) {
      return
    }
    const children = await listFolder({ client: input.client, folderToken })
    for (const child of children.items) {
      const childPath = prefix === '/' ? child.name : `${prefix}/${child.name}`
      if (child.name === needle) {
        found.push({ ...child, path: childPath })
      }
      if (child.type === 'folder') {
        await walk(child.token, childPath, depth + 1)
      }
    }
  }
  await walk(input.workspaceToken, '/', 1)
  return found
}

export async function resolveEntryByNameOrPath(input: {
  client: FeishuClient
  workspaceToken: string
  target: string
}): Promise<WorkspaceTreeEntry> {
  if (normalizeWorkspacePath(input.target).length > 1 || input.target.includes('/')) {
    return resolveEntryPath(input)
  }
  const matches = await findEntriesByName({
    client: input.client,
    workspaceToken: input.workspaceToken,
    name: input.target,
  })
  if (matches.length === 0) {
    throw new Error(`Could not find "${input.target}" in the Feishu workspace. Use FeishuList to confirm the target.`)
  }
  if (matches.length > 1) {
    throw new Error(`Found ${matches.length} entries named "${input.target}". Use a path such as "folder/${input.target}" to disambiguate.`)
  }
  return matches[0]!
}

export async function listWorkspaceTree(input: {
  client: FeishuClient
  folderToken: string
  prefix?: string
  depth: number
}): Promise<WorkspaceTreeEntry[]> {
  const children = await listFolder({ client: input.client, folderToken: input.folderToken })
  const entries: WorkspaceTreeEntry[] = []
  for (const child of children.items) {
    const childPath = (input.prefix ?? '/') === '/' ? child.name : `${input.prefix}/${child.name}`
    const entry: WorkspaceTreeEntry = { ...child, path: childPath }
    if (child.type === 'folder') {
      if (input.depth > 1) {
        // Recurse once and reuse the result for childCount instead of
        // calling listFolder twice on the same folder (one for the
        // count + one for the recurse — doubled API traffic on every
        // multi-level FeishuList).
        const subTree = await listWorkspaceTree({
          client: input.client,
          folderToken: child.token,
          prefix: childPath,
          depth: input.depth - 1,
        })
        entry.children = subTree
        entry.childCount = subTree.length
      } else {
        // Depth-capped — still want childCount + depthCapped flag for the
        // render. One list call per cap leaf is unavoidable since we have
        // no other source of the count.
        const listed = await listFolder({ client: input.client, folderToken: child.token })
        entry.childCount = listed.items.length
        if (listed.items.length > 0) {
          entry.depthCapped = true
        }
      }
    }
    entries.push(entry)
  }
  return entries
}

export async function countDescendants(input: {
  client: FeishuClient
  folderToken: string
  maxDepth?: number
}): Promise<number> {
  const maxDepth = input.maxDepth ?? 20
  async function walk(folderToken: string, depth: number): Promise<number> {
    if (depth > maxDepth) {
      return 0
    }
    const children = await listFolder({ client: input.client, folderToken })
    let count = children.items.length
    for (const child of children.items) {
      if (child.type === 'folder') {
        count += await walk(child.token, depth + 1)
      }
    }
    return count
  }
  return walk(input.folderToken, 1)
}

export async function assertWithinWorkspace(input: {
  ancestry: AncestryResolver
  token: string
  workspaceToken: string
  toolName: string
}): Promise<string[]> {
  const chain = await input.ancestry.resolve(input.token)
  const tokens = chain?.map(entry => entry.token) ?? []
  if (!chain || !tokens.includes(input.workspaceToken)) {
    throw Object.assign(
      new Error(`${input.toolName}: boundary-violation target is outside the current user workspace.`),
      { ancestryChain: tokens },
    )
  }
  return tokens
}

export function renderTree(entries: WorkspaceTreeEntry[], rootLabel: string): string {
  if (entries.length === 0) {
    return `${rootLabel}\n(empty workspace)`
  }
  const lines = [rootLabel]
  renderEntries(entries, lines, '')
  return lines.join('\n')
}

function renderEntries(entries: WorkspaceTreeEntry[], lines: string[], prefix: string): void {
  entries.forEach((entry, index) => {
    const last = index === entries.length - 1
    const connector = last ? '`-- ' : '|-- '
    const nextPrefix = `${prefix}${last ? '    ' : '|   '}`
    const type = displayType(entry.type)
    const suffix = entry.type === 'folder'
      ? ` (${type}, ${entry.childCount ?? 0} items${entry.depthCapped ? ', depth-capped' : ''})`
      : ` (${type})`
    lines.push(`${prefix}${connector}${entry.name}${entry.type === 'folder' ? '/' : ''}${entry.modifiedTime ? `  ${entry.modifiedTime}` : ''}${suffix} token=${entry.token}`)
    if (entry.children?.length) {
      renderEntries(entry.children, lines, nextPrefix)
    }
  })
}

function displayType(type: FeishuDriveItemType): string {
  if (type === 'docx' || type === 'doc') return 'doc'
  return type
}
