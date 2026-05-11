import type { FeishuClient } from '../client.js'
import { callFeishu } from './api.js'
import { readNestedString } from './common.js'

export type FeishuWikiNode = {
  objType?: string
  objToken?: string
}

export async function resolveWikiNode(input: {
  client: FeishuClient
  token: string
}): Promise<FeishuWikiNode> {
  const client = input.client as FeishuWikiClient
  const node = await callFeishu(() => client.wiki.space.getNode({
    params: { token: input.token },
  }))
  return {
    objType: readNestedString(node.data, ['node', 'obj_type'])?.toLowerCase(),
    objToken: readNestedString(node.data, ['node', 'obj_token']),
  }
}

export function isWikiDocType(objType: string | undefined): boolean {
  return objType === 'docx' || objType === 'doc'
}

export function isWikiSheetType(objType: string | undefined): boolean {
  return objType === 'sheet' || objType === 'sheets' || objType === 'spreadsheet'
}

type FeishuWikiClient = {
  wiki: {
    space: {
      getNode(input: unknown): Promise<{ code?: number; msg?: string; data?: unknown }>
    }
  }
}
