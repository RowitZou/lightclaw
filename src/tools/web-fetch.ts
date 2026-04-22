import { z } from 'zod'

import { buildTool } from '../tool.js'
import { fetchContent } from '../web/fetch-content.js'
import { htmlToMarkdown } from '../web/html-to-markdown.js'

function formatJson(input: string): string {
  try {
    return `\`\`\`json\n${JSON.stringify(JSON.parse(input), null, 2)}\n\`\`\``
  } catch {
    return input
  }
}

export const webFetchTool = buildTool({
  name: 'WebFetch',
  description:
    'Fetch content from a URL and return it as Markdown. Supports HTML, plain text, Markdown, and JSON. Binary content is rejected.',
  riskLevel: 'execute',
  inputSchema: z.object({
    url: z.string().url(),
    maxBytes: z.number().int().min(1024).max(500_000).optional(),
    timeoutMs: z.number().int().min(1000).max(120_000).optional(),
  }),
  async call(input, context) {
    const maxBytes = input.maxBytes ?? 200_000
    const result = await fetchContent({
      url: input.url,
      maxBytes,
      timeoutMs: input.timeoutMs,
      signal: context.abortSignal,
    })
    const contentType = result.contentType.toLowerCase()

    let body: string
    if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
      body = htmlToMarkdown(result.content)
    } else if (
      contentType.includes('text/markdown') ||
      contentType.includes('text/plain')
    ) {
      body = result.content
    } else if (contentType.includes('application/json')) {
      body = formatJson(result.content)
    } else {
      return {
        output: `Unsupported content type: ${result.contentType}`,
        isError: true,
      }
    }

    const suffix = result.truncated
      ? `\n\n[truncated at ${maxBytes} bytes]`
      : ''

    return {
      output: [
        `URL: ${result.url}`,
        `Status: ${result.status}`,
        `Content-Type: ${result.contentType}`,
        `Bytes: ${result.bytes}`,
        '',
        `${body}${suffix}`,
      ].join('\n'),
    }
  },
})
