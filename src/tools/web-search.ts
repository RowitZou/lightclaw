import { z } from 'zod'

import { getConfig } from '../config.js'
import { getProvider, modelFor } from '../provider/index.js'
import type { Provider } from '../provider/types.js'
import { buildTool } from '../tool.js'

const REMINDER = 'REMINDER: Cite sources with Markdown links when answering.'

export const webSearchTool = buildTool({
  name: 'WebSearch',
  description:
    'Search the web using Anthropic native web_search. Returns search findings and source URLs.',
  riskLevel: 'safe',
  concurrencySafe: true,
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
    if (!provider.webSearch) {
      return {
        output: 'Tool not available: current provider does not support WebSearch.',
        isError: true,
      }
    }

    const result = await provider.webSearch({
      query: input.query,
      model: modelFor('webSearch', config),
      allowedDomains: input.allowed_domains,
      blockedDomains: input.blocked_domains,
      signal: context.abortSignal,
    })

    return {
      output: [result.text, '', REMINDER].join('\n').trim(),
    }
  },
})
