import { stat } from 'node:fs/promises'
import path from 'node:path'

import { z } from 'zod'

import { memoryFreshnessText } from '../memory/aging.js'
import { normalizeMemoryFilename, readMemoryFile, scanMemoryFiles } from '../memory/auto-memory.js'
import { getMemoryDir } from '../state.js'
import { buildTool } from '../tool.js'

export const memoryReadTool = buildTool({
  name: 'MemoryRead',
  description:
    'Read auto-memory files. Use action "list" to list files or "read" to inspect a specific memory file.',
  domain: 'host',
  riskLevel: 'safe',
  concurrencySafe: true,
  inputSchema: z.object({
    action: z.enum(['list', 'read']),
    filename: z.string().min(1).optional(),
  }),
  async call(input) {
    try {
      const memoryDir = getMemoryDir()

      if (input.action === 'list') {
        const entries = await scanMemoryFiles(memoryDir)
        return {
          output:
            entries.length > 0
              ? entries
                  .map(
                    entry =>
                      `[${entry.type}] ${entry.filename}: ${entry.description}`,
                  )
                  .join('\n')
              : 'No memory files found.',
        }
      }

      if (!input.filename) {
        return {
          output: 'filename is required when action is "read".',
          isError: true,
        }
      }

      const content = await readMemoryFile(memoryDir, input.filename)
      if (content) {
        let staleness = ''
        try {
          // Use the same normalized filename as readMemoryFile — otherwise
          // a caller passing "foo" (no .md) would load content via
          // normalize-on-read but stat the wrong path, silently dropping
          // the staleness reminder.
          const normalized = normalizeMemoryFilename(input.filename)
          const stats = await stat(path.join(memoryDir, normalized))
          staleness = memoryFreshnessText(stats.mtimeMs)
        } catch {
          // mtime unavailable — fall through to plain content
        }
        const output = staleness
          ? `${content}\n\n<system-reminder>${staleness}</system-reminder>`
          : content
        return { output }
      }
      return {
        output: `Memory file not found: ${input.filename}`,
        isError: true,
      }
    } catch (error) {
      return {
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      }
    }
  },
})
