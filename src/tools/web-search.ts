import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'

import { getConfig } from '../config.js'
import { getProvider, modelFor } from '../provider/index.js'
import type { Provider } from '../provider/types.js'
import { buildTool } from '../tool.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function formatWebSearchBlocks(blocks: unknown[]): string {
  const lines: string[] = []

  for (const block of blocks) {
    if (!isRecord(block)) {
      continue
    }

    if (block.type === 'text' && typeof block.text === 'string') {
      lines.push(block.text)
      continue
    }

    if (block.type !== 'server_tool_use' && block.type !== 'web_search_tool_result') {
      continue
    }

    const content = block.content
    if (!Array.isArray(content)) {
      continue
    }

    for (const item of content) {
      if (!isRecord(item)) {
        continue
      }

      const title = typeof item.title === 'string' ? item.title : 'Untitled'
      const url = typeof item.url === 'string' ? item.url : ''
      const snippet =
        typeof item.encrypted_content === 'string'
          ? ''
          : typeof item.page_age === 'string'
            ? ` (${item.page_age})`
            : ''
      lines.push(url ? `- ${title}: ${url}${snippet}` : `- ${title}${snippet}`)
    }
  }

  lines.push('', 'REMINDER: Cite sources with Markdown links when answering.')
  return lines.join('\n').trim()
}

export const webSearchTool = buildTool({
  name: 'WebSearch',
  description:
    'Search the web using Anthropic native web_search. Returns search findings and source URLs.',
  inputSchema: z.object({
    query: z.string().min(2),
    allowed_domains: z.array(z.string()).optional(),
    blocked_domains: z.array(z.string()).optional(),
  }),
  isEnabled(provider: Provider) {
    return provider.capabilities.serverTools.webSearch
  },
  async call(input, context) {
    const config = getConfig()
    const provider = getProvider(config)
    if (!provider.capabilities.serverTools.webSearch) {
      return {
        output: 'Tool not available: current provider does not support WebSearch.',
        isError: true,
      }
    }

    const anthropicConfig = config.providerOptions.anthropic
    if (!anthropicConfig?.apiKey) {
      return {
        output: 'Tool not available: Anthropic API key is not configured.',
        isError: true,
      }
    }

    const anthropic = new Anthropic({
      apiKey: anthropicConfig.apiKey,
      ...(anthropicConfig.baseUrl ? { baseURL: anthropicConfig.baseUrl } : {}),
    })
    const response = await anthropic.messages.create({
      model: modelFor('webSearch', config),
      max_tokens: 4096,
      system:
        'You are a web search assistant. Use web_search to answer the query and include useful source URLs.',
      messages: [
        {
          role: 'user',
          content: `Perform a web search for: ${input.query}`,
        },
      ],
      tools: [
        {
          type: 'web_search_20250305',
          name: 'web_search',
          max_uses: 5,
          ...(input.allowed_domains
            ? { allowed_domains: input.allowed_domains }
            : {}),
          ...(input.blocked_domains
            ? { blocked_domains: input.blocked_domains }
            : {}),
        },
      ] as never,
    }, {
      signal: context.abortSignal,
    })

    return {
      output: formatWebSearchBlocks(response.content as unknown[]),
    }
  },
})
