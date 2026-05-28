import { z } from 'zod'

import { createBuiltinReplRegistry } from '../commands/builtin.js'
import { isAdmin as isCanonicalAdmin } from '../identity/store.js'
import { getCurrentUserId } from '../state.js'
import { buildTool } from '../tool.js'

export const showSlashCatalogTool = buildTool({
  name: 'ShowSlashCatalog',
  description: [
    'Lists slash commands the current user can type in chat to manage state you cannot mutate directly (credentials, mounts, sandbox, permissions, etc.).',
    '',
    'Call this when the user\'s request implies they need to do such setup — then tell them by name which command to run and with what arguments.',
    '',
    'Treat the tool output as the only source of truth for slash command names and parameters. Do not invent or guess slash command names; if nothing relevant comes back, ask the user how to proceed instead.',
  ].join('\n'),
  inputSchema: z.object({}),
  domain: 'host',
  riskLevel: 'safe',
  concurrencySafe: true,
  async call() {
    const userId = getCurrentUserId()
    const isAdmin = userId ? await isCanonicalAdmin(userId) : false

    const registry = createBuiltinReplRegistry({ includeChannelOnly: true })
    const entries = registry.list(isAdmin)
      .filter(cmd => cmd.agentAdvisory && cmd.agentAdvisory.trim().length > 0)
      .sort((a, b) => a.name.localeCompare(b.name))

    if (entries.length === 0) {
      return { output: 'No slash commands with advisory are registered for the current user role.\n' }
    }

    const header = isAdmin
      ? 'Slash commands (chat only; current user is admin — both user and admin commands shown):'
      : 'Slash commands (chat only):'
    const lines: string[] = [header, '']
    for (const cmd of entries) {
      lines.push(`${cmd.name}  ${cmd.description}`)
      lines.push('  Usage:')
      const usageBlock = cmd.agentUsage ?? cmd.usage
      for (const line of usageBlock.split('\n')) {
        lines.push(`    ${line}`)
      }
      lines.push(`  Suggest when: ${cmd.agentAdvisory!}`)
      lines.push('')
    }
    return { output: lines.join('\n') }
  },
})
