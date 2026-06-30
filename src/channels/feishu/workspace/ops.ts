import type { FeishuClient } from '../client.js'
import { getIdentity } from '../../../identity/store.js'
import { getCurrentUserId } from '../../../state.js'
import {
  listFolder,
  type FeishuDriveItemType,
  type FeishuFolderItem,
} from '../resources/folder.js'
import { getWorkspaceParentCache, type ParentCache } from './ancestry.js'
import { resolveFeishuLink, parseFeishuFolderToken } from '../link.js'
import {
  getOrCreateUserWorkspace,
  getOrCreateWorkspaceRoot,
  type UserWorkspace,
  type WorkspaceRoot,
} from './lifecycle.js'

export type FeishuWorkspaceContext = {
  canonicalUser: string
  ownerOpenId: string
  root: WorkspaceRoot
  workspace: UserWorkspace
  ancestry: ParentCache
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
  // Seed the parent cache: root is a known top-level marker; user folder's
  // parent is the root. Without these seeds an `assertWithinWorkspace` on
  // a token whose listFolder hops never reached either seed would fail
  // even when the chain is legitimate (e.g. depth-1 file under user
  // workspace root: its parent edge gets observed by the workspace-root
  // list, then chain walk hits user folder which we just seeded).
  const cache = getWorkspaceParentCache()
  cache.markRoot(root.folderToken)
  cache.observeChild(workspace.folderToken, root.folderToken)
  return {
    canonicalUser,
    ownerOpenId,
    root,
    workspace,
    ancestry: cache,
  }
}

// The breadcrumb FeishuList renders for the workspace root. Agents routinely
// copy the displayed `/LightClaw/<user>/<sub>` path straight back as a tool
// `path` argument, but path inputs are resolved RELATIVE to the user's
// workspace root (which already IS /LightClaw/<user>). Echoing the breadcrumb
// then double-prefixes and fails with `Folder "LightClaw" does not exist`.
// This constant ties the rendered breadcrumb and the self-heal strip together
// so the two can never drift.
export const WORKSPACE_BREADCRUMB_ROOT = 'LightClaw'

export function normalizeWorkspacePath(
  input: string | undefined,
  canonicalUser?: string,
): string[] {
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
  return stripEchoedWorkspacePrefix(parts, canonicalUser)
}

// Self-heal a path the agent copied from the FeishuList breadcrumb. Strips a
// leading `LightClaw/<canonicalUser>` pair (full breadcrumb echo) or a bare
// leading `<canonicalUser>` (partial echo) so the remaining segments resolve
// against the workspace root as intended. Conservative: only an exact leading
// match of the user's own breadcrumb prefix is removed, never an interior
// segment.
function stripEchoedWorkspacePrefix(parts: string[], canonicalUser?: string): string[] {
  if (!canonicalUser || parts.length === 0) {
    return parts
  }
  if (parts.length >= 2 && parts[0] === WORKSPACE_BREADCRUMB_ROOT && parts[1] === canonicalUser) {
    return parts.slice(2)
  }
  if (parts[0] === canonicalUser) {
    return parts.slice(1)
  }
  return parts
}

export async function resolveFolderPath(input: {
  client: FeishuClient
  workspaceToken: string
  path?: string
  canonicalUser?: string
}): Promise<{ token: string; path: string; item?: FeishuFolderItem }> {
  const parts = normalizeWorkspacePath(input.path, input.canonicalUser)
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
  canonicalUser?: string
}): Promise<WorkspaceTreeEntry> {
  const parts = normalizeWorkspacePath(input.target, input.canonicalUser)
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

// Walk the workspace tree to the entry carrying `token`. Like
// `findEntriesByName` but matches by token, which is unique — so it returns
// the single entry (with its real name/type/path) or undefined. The walk is
// also what warms the `ParentCache` for that token, so a subsequent
// `assertWithinWorkspace` passes; an out-of-workspace token is never found,
// which is exactly the boundary we want.
export async function findEntryByToken(input: {
  client: FeishuClient
  workspaceToken: string
  token: string
  maxDepth?: number
}): Promise<WorkspaceTreeEntry | undefined> {
  const needle = input.token.trim()
  async function walk(folderToken: string, prefix: string, depth: number): Promise<WorkspaceTreeEntry | undefined> {
    if (depth > (input.maxDepth ?? 6)) {
      return undefined
    }
    const children = await listFolder({ client: input.client, folderToken })
    for (const child of children.items) {
      const childPath = prefix === '/' ? child.name : `${prefix}/${child.name}`
      if (child.token === needle) {
        return { ...child, path: childPath }
      }
      if (child.type === 'folder') {
        const hit = await walk(child.token, childPath, depth + 1)
        if (hit) {
          return hit
        }
      }
    }
    return undefined
  }
  return walk(input.workspaceToken, '/', 1)
}

// A pasted Feishu URL (doc / sheet / wiki / folder / drive file) maps to its
// resource token. Returns undefined for a non-URL or an unrecognized link.
function feishuUrlToToken(target: string): string | undefined {
  const link = resolveFeishuLink(target)
  if (link.ok) {
    return link.token
  }
  return parseFeishuFolderToken(target)
}

// A bare Feishu resource token: the FeishuList / FeishuCreateFolder output
// renders `token=<...>`, so the model sometimes passes that verbatim. Tokens
// are long base62-ish strings with no separators; a real file/folder *name*
// containing only 20+ alphanumerics and nothing else is vanishingly rare, so
// this is a safe fallback to attempt only after a name lookup found nothing.
function looksLikeFeishuToken(target: string): boolean {
  return /^[A-Za-z0-9]{20,}$/.test(target)
}

export async function resolveEntryByNameOrPath(input: {
  client: FeishuClient
  workspaceToken: string
  target: string
  canonicalUser?: string
}): Promise<WorkspaceTreeEntry> {
  const target = input.target.trim()

  // A pasted Feishu URL addresses a resource directly. Resolve it by token so
  // it works regardless of the resource's name — in particular a Feishu title
  // containing "/" (which name/path resolution below cannot express, since "/"
  // is the workspace path separator). Without this, the URL's "//" was split
  // as a path and reported the nonsense `Folder "https:" does not exist`.
  if (/^https?:\/\//i.test(target)) {
    const token = feishuUrlToToken(target)
    if (!token) {
      throw new Error(`"${target}" is not a recognizable Feishu resource link. Paste the doc / sheet / folder URL, or use FeishuList to pick the target by name.`)
    }
    const entry = await findEntryByToken({
      client: input.client,
      workspaceToken: input.workspaceToken,
      token,
    })
    if (!entry) {
      throw new Error(`Could not find that Feishu resource inside your workspace. It may be outside your workspace, or already deleted. Use FeishuList to confirm.`)
    }
    return entry
  }

  if (normalizeWorkspacePath(target, input.canonicalUser).length > 1 || target.includes('/')) {
    return resolveEntryPath(input)
  }
  const matches = await findEntriesByName({
    client: input.client,
    workspaceToken: input.workspaceToken,
    name: target,
  })
  if (matches.length > 1) {
    throw new Error(`Found ${matches.length} entries named "${target}". Use a path such as "folder/${target}" to disambiguate.`)
  }
  if (matches.length === 1) {
    return matches[0]!
  }
  // No name match — a bare resource token is the remaining possibility.
  if (looksLikeFeishuToken(target)) {
    const entry = await findEntryByToken({
      client: input.client,
      workspaceToken: input.workspaceToken,
      token: target,
    })
    if (entry) {
      return entry
    }
  }
  throw new Error(`Could not find "${target}" in the Feishu workspace. Use FeishuList to confirm the target.`)
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

export function assertWithinWorkspace(input: {
  ancestry: ParentCache
  token: string
  workspaceToken: string
  toolName: string
}): string[] {
  const chain = input.ancestry.ancestryChain(input.token)
  if (!chain.includes(input.workspaceToken)) {
    throw Object.assign(
      new Error(`${input.toolName}: boundary-violation target is outside the current user workspace.`),
      { ancestryChain: chain },
    )
  }
  return chain
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
