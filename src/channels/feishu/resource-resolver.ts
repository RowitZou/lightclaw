import {
  resolveFeishuLink,
  type FeishuResolvedLink,
  type FeishuResourceType,
} from './link.js'
import type { FeishuClient } from './client.js'
import { resolveWikiNode, type FeishuWikiNode } from './resources/wiki.js'

export type FeishuCanonicalResourceType =
  | 'docx'
  | 'doc'
  | 'sheet'
  | 'bitable'
  | 'file'
  | 'unknown'

export type FeishuResourceCapabilities = {
  readableWith: string[]
  writableWith: string[]
}

export type FeishuCanonicalResource = {
  input: {
    url?: string
    host?: string
    resourceType: FeishuResourceType
    token: string
  }
  canonical: {
    resourceType: FeishuCanonicalResourceType
    token?: string
    source: 'url' | 'direct' | 'wiki.get_node'
    wikiNode?: FeishuWikiNode
  }
  resourceType: FeishuCanonicalResourceType
  canonicalToken?: string
  source: 'url' | 'direct' | 'wiki.get_node'
  sheetId?: string
  range?: string
  capabilities: FeishuResourceCapabilities
}

export type FeishuResolveResourceInput =
  | { url: string }
  | { documentId: string; resourceType?: 'docx' | 'doc' }
  | { spreadsheetToken: string; sheetId?: string; range?: string }
  | {
    resourceType: FeishuResourceType
    token: string
    url?: string
    host?: string
    sheetId?: string
    range?: string
  }

export type FeishuResolveResourceOptions = {
  client: FeishuClient
}

export async function resolveFeishuResourceFromUrl(
  client: FeishuClient,
  url: string,
): Promise<FeishuCanonicalResource> {
  return resolveFeishuResource({ url }, { client })
}

export async function resolveFeishuResource(
  input: FeishuResolveResourceInput,
  options: FeishuResolveResourceOptions,
): Promise<FeishuCanonicalResource> {
  if ('url' in input && !('token' in input)) {
    const resolved = resolveFeishuLink(input.url)
    if (!resolved.ok) {
      throw new Error(resolved.reason)
    }
    return resolveFeishuResource(fromResolvedLink(resolved), options)
  }

  if ('documentId' in input) {
    return buildCanonical(
      {
        resourceType: input.resourceType ?? 'docx',
        token: input.documentId,
      },
      {
        resourceType: normalizeCanonicalResourceType(input.resourceType ?? 'docx'),
        token: input.documentId,
        source: 'direct',
      },
    )
  }

  if ('spreadsheetToken' in input) {
    return buildCanonical(
      {
        resourceType: 'sheet',
        token: input.spreadsheetToken,
        sheetId: input.sheetId,
        range: input.range,
      },
      {
        resourceType: 'sheet',
        token: input.spreadsheetToken,
        source: 'direct',
      },
    )
  }

  if (input.resourceType === 'wiki') {
    const wikiNode = await resolveWikiNode({ client: options.client, token: input.token })
    const canonicalType = wikiObjTypeToResourceType(wikiNode.objType)
    return buildCanonical(input, {
      resourceType: canonicalType,
      token: wikiNode.objToken,
      source: 'wiki.get_node',
      wikiNode,
    })
  }

  return buildCanonical(input, {
    resourceType: normalizeCanonicalResourceType(input.resourceType),
    token: input.token,
    source: 'url',
  })
}

export function fromResolvedLink(resolved: FeishuResolvedLink): FeishuResolveResourceInput {
  return {
    url: resolved.url,
    host: resolved.host,
    resourceType: resolved.resourceType,
    token: resolved.token,
    sheetId: resolved.sheetId,
    range: resolved.range,
  }
}

export function normalizeCanonicalResourceType(
  resourceType: string | undefined,
): FeishuCanonicalResourceType {
  if (resourceType === 'docx' || resourceType === 'doc') {
    return resourceType
  }
  if (resourceType === 'sheet' || resourceType === 'sheets' || resourceType === 'spreadsheet') {
    return 'sheet'
  }
  if (resourceType === 'bitable' || resourceType === 'base') {
    return 'bitable'
  }
  if (resourceType === 'file') {
    return 'file'
  }
  return 'unknown'
}

export function ensureCanonicalDoc(resource: FeishuCanonicalResource): string {
  if (resource.resourceType === 'docx' || resource.resourceType === 'doc') {
    if (!resource.canonicalToken) {
      throw new Error('Feishu document resource did not resolve to a readable token.')
    }
    return resource.canonicalToken
  }
  throw new Error(
    describeCanonicalMismatch(resource, 'docx/doc', ['FeishuRead'], resource.capabilities.readableWith),
  )
}

export function ensureCanonicalSheet(resource: FeishuCanonicalResource): string {
  if (resource.resourceType === 'sheet') {
    if (!resource.canonicalToken) {
      throw new Error('Feishu sheet resource did not resolve to a readable token.')
    }
    return resource.canonicalToken
  }
  throw new Error(
    describeCanonicalMismatch(resource, 'sheet', ['FeishuRead'], resource.capabilities.readableWith),
  )
}

function buildCanonical(
  input: Exclude<FeishuResolveResourceInput, { url: string } | { documentId: string } | { spreadsheetToken: string }>,
  canonical: FeishuCanonicalResource['canonical'],
): FeishuCanonicalResource {
  return {
    input: {
      url: input.url,
      host: input.host,
      resourceType: input.resourceType,
      token: input.token,
    },
    canonical,
    resourceType: canonical.resourceType,
    canonicalToken: canonical.token,
    source: canonical.source,
    sheetId: input.sheetId,
    range: input.range,
    capabilities: capabilitiesForResource(canonical.resourceType),
  }
}

function wikiObjTypeToResourceType(objType: string | undefined): FeishuCanonicalResourceType {
  return normalizeCanonicalResourceType(objType)
}

function capabilitiesForResource(
  resourceType: FeishuCanonicalResourceType,
): FeishuResourceCapabilities {
  if (resourceType === 'docx') {
    return {
      readableWith: ['FeishuRead'],
      writableWith: ['FeishuCreateFile', 'FeishuWriteDoc'],
    }
  }
  if (resourceType === 'doc') {
    return {
      readableWith: ['FeishuRead'],
      writableWith: ['FeishuWriteDoc'],
    }
  }
  if (resourceType === 'sheet') {
    return {
      readableWith: ['FeishuRead'],
      writableWith: ['FeishuWriteSheet'],
    }
  }
  return { readableWith: [], writableWith: [] }
}

function describeCanonicalMismatch(
  resource: FeishuCanonicalResource,
  expected: string,
  expectedTools: string[],
  actualTools: string[],
): string {
  const wikiDetail = resource.canonical.source === 'wiki.get_node'
    ? ` Wiki node resolved to ${resource.canonical.resourceType}.`
    : ''
  const tools = actualTools.length > 0
    ? ` Use ${actualTools.join(' or ')}.`
    : ` Supported tools here: ${expectedTools.join(' or ')}.`
  return `Expected Feishu ${expected}, got ${resource.input.resourceType} -> ${resource.canonical.resourceType}.${wikiDetail}${tools}`
}
