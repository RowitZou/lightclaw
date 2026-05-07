import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { Tool } from '../tool.js'
import { matchesUnattendedAllowlist } from './unattended-allowlist.js'

describe('matchesUnattendedAllowlist', () => {
  it('allows the built-in background safe tool set without task rules', () => {
    assert.equal(matchesUnattendedAllowlist(fakeTool('Read'), { file_path: '/tmp/a' }, []), true)
    assert.equal(matchesUnattendedAllowlist(fakeTool('ListBackgroundTasks'), {}, undefined), true)
  })

  it('does not treat Bash as built-in safe', () => {
    assert.equal(matchesUnattendedAllowlist(fakeTool('Bash'), { command: 'ls' }, []), false)
  })

  it('matches taskAllowedTools with normal permission rule syntax', () => {
    assert.equal(
      matchesUnattendedAllowlist(
        fakeTool('Bash'),
        { command: 'cd /data && rsync -av a b' },
        ['Bash(rsync:*)'],
      ),
      true,
    )
    assert.equal(
      matchesUnattendedAllowlist(
        fakeTool('Edit'),
        { file_path: '/var/log/app.log' },
        ['Edit(/var/log/**)'],
      ),
      true,
    )
  })

  it('rejects unmatched or malformed task rules', () => {
    assert.equal(
      matchesUnattendedAllowlist(
        fakeTool('Bash'),
        { command: 'rm -rf x' },
        ['malformed[', 'Bash(rsync:*)'],
      ),
      false,
    )
  })

  it('matches MCP(<server>:<tool>) rules for MCP tools', () => {
    assert.equal(
      matchesUnattendedAllowlist(
        fakeTool('mcp__docs__fetch', { source: 'mcp', mcpServer: 'docs', mcpToolName: 'fetch' }),
        {},
        ['MCP(docs:fetch)'],
      ),
      true,
    )
  })
})

function fakeTool(
  name: string,
  overrides: Partial<Tool> = {},
): Tool {
  return {
    name,
    description: name,
    source: 'builtin',
    domain: 'host',
    riskLevel: 'safe',
    async call() {
      return { output: '' }
    },
    formatResult(output, toolUseId) {
      return { type: 'tool_result', tool_use_id: toolUseId, content: String(output) }
    },
    ...overrides,
  }
}
