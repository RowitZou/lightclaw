import { z } from 'zod'

import { getFeishuClient, type FeishuClient } from '../channels/feishu/client.js'
import { resolveFeishuLink } from '../channels/feishu/link.js'
import {
  resolveFeishuResource,
  type FeishuCanonicalResource,
  type FeishuResolveResourceInput,
} from '../channels/feishu/resource-resolver.js'
import { readDocPlainText, type FeishuDocReadResult } from '../channels/feishu/resources/doc.js'
import {
  readSheetMetadata,
  readSheetRange,
  type FeishuSheetTarget,
} from '../channels/feishu/resources/sheet.js'
import { buildTool, type ToolCallResult } from '../tool.js'

const DEFAULT_FEISHU_READ_MAX_CHARS = 100_000

const feishuReadInputSchema = z.object({
  url: z.string().url().describe('Feishu/Lark URL (docs / docx / wiki / sheets / bitable / file).'),
  max_chars: z.number().int().min(1).max(500_000).optional()
    .describe('Doc-text cap. Defaults to 100000. Ignored for sheets and metadata_only.'),
  sheet: z.object({
    sheet_id: z.string().min(1).optional(),
    range: z.string().min(1).optional()
      .describe('A1-style range like "Sheet1!A1:D20". If omitted for sheets, returns spreadsheet metadata.'),
  }).optional().describe('Sheet-specific options. Ignored for non-sheet URLs.'),
  metadata_only: z.boolean().optional()
    .describe('Resolve URL to canonical resource metadata without reading content. Useful before deciding what to read.'),
})

export type FeishuReadInput = z.infer<typeof feishuReadInputSchema>

export type FeishuReadMetadataOutput = {
  resource: {
    inputResourceType: string
    canonicalToken?: string
    canonicalType: string
    source: FeishuCanonicalResource['source']
    sheetId?: string
    range?: string
    readableWith: string[]
    writableWith: string[]
  }
}

export type FeishuReadOutput =
  | FeishuDocReadResult
  | Awaited<ReturnType<typeof readSheetRange>>
  | Awaited<ReturnType<typeof readSheetMetadata>>
  | FeishuReadMetadataOutput
  | string

type FeishuReadDeps = {
  client: FeishuClient
  resolveResource?: (
    input: FeishuResolveResourceInput,
    options: { client: FeishuClient },
  ) => Promise<FeishuCanonicalResource>
  readDoc?: typeof readDocPlainText
  readRange?: typeof readSheetRange
  readMetadata?: typeof readSheetMetadata
}

export const feishuReadTool = buildTool<FeishuReadInput, FeishuReadOutput>({
  name: 'FeishuRead',
  description:
    'Read a Feishu/Lark resource by URL. Auto-routes by canonical type: doc/docx -> plain text; sheet -> cell values or metadata; wiki -> resolves to the underlying doc/sheet then reads. Pass metadata_only:true to peek at the resource type without fetching content. Returns a v1-not-supported hint for bitable/file types.',
  domain: 'host',
  riskLevel: 'safe',
  channelScope: ['feishu'],
  shouldDefer: true,
  searchHint: 'feishu lark doc docx wiki sheet bitable url read open view fetch metadata',
  inputSchema: feishuReadInputSchema,
  async call(input): Promise<ToolCallResult<FeishuReadOutput>> {
    try {
      return await runFeishuRead(input, { client: getFeishuClient() })
    } catch (error) {
      return {
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      }
    }
  },
})

export async function runFeishuRead(
  input: FeishuReadInput,
  deps: FeishuReadDeps,
): Promise<ToolCallResult<FeishuReadOutput>> {
  const link = resolveFeishuLink(input.url)
  if (!link.ok) {
    return { output: `Cannot parse Feishu URL: ${link.reason}`, isError: true }
  }

  const resolveResource = deps.resolveResource ?? resolveFeishuResource
  const resource = await resolveResource({ url: input.url }, { client: deps.client })

  if (input.metadata_only) {
    return {
      output: {
        resource: {
          inputResourceType: link.resourceType,
          ...(resource.canonicalToken ? { canonicalToken: resource.canonicalToken } : {}),
          canonicalType: resource.resourceType,
          source: resource.source,
          ...(resource.sheetId ? { sheetId: resource.sheetId } : {}),
          ...(resource.range ? { range: resource.range } : {}),
          readableWith: resource.capabilities.readableWith,
          writableWith: resource.capabilities.writableWith,
        },
      },
    }
  }

  if (resource.resourceType === 'bitable' || resource.resourceType === 'file') {
    return {
      output: `v1 does not support reading ${resource.resourceType} resources. Use Feishu UI to export, or wait for v2.`,
      isError: true,
    }
  }
  if (resource.resourceType === 'unknown') {
    return {
      output: `Could not resolve canonical resource type for ${input.url}.`,
      isError: true,
    }
  }

  if (resource.resourceType === 'docx' || resource.resourceType === 'doc') {
    const documentId = resource.canonicalToken
    if (!documentId) {
      return { output: 'Feishu document resource did not resolve to a readable token.', isError: true }
    }
    const readDoc = deps.readDoc ?? readDocPlainText
    return {
      output: await readDoc({
        client: deps.client,
        documentId,
        maxChars: input.max_chars ?? DEFAULT_FEISHU_READ_MAX_CHARS,
      }),
    }
  }

  if (resource.resourceType === 'sheet') {
    const spreadsheetToken = resource.canonicalToken
    if (!spreadsheetToken) {
      return { output: 'Feishu sheet resource did not resolve to a readable token.', isError: true }
    }
    const target: FeishuSheetTarget = {
      token: spreadsheetToken,
      sheetId: input.sheet?.sheet_id ?? resource.sheetId,
      range: input.sheet?.range ?? resource.range,
    }
    if (target.range) {
      const readRange = deps.readRange ?? readSheetRange
      return {
        output: await readRange({
          client: deps.client,
          spreadsheetToken: target.token,
          ...(target.sheetId ? { sheetId: target.sheetId } : {}),
          range: target.range,
        }),
      }
    }
    const readMetadata = deps.readMetadata ?? readSheetMetadata
    return {
      output: await readMetadata({
        client: deps.client,
        spreadsheetToken: target.token,
      }),
    }
  }

  return { output: `Unhandled canonical resource type: ${resource.resourceType}`, isError: true }
}
