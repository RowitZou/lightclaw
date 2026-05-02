import assert from 'node:assert/strict'
import test from 'node:test'

import { createAssistantMessage, createUserMessage } from '../messages.js'
import type { MemoryEntry } from './types.js'
import {
  buildExtractPrompt,
  hasMemoryWritesSince,
  messageToText,
} from './extract.js'
import {
  createAutoMemCanUseTool,
  getBashHead,
  isReadOnlyBash,
} from './auto-mem-can-use-tool.js'
import type { Tool } from '../tool.js'

function memory(filename: string): MemoryEntry {
  return {
    filename,
    type: 'project',
    description: 'A project convention',
    content: 'Why: useful\nHow to apply: remember it',
    mtimeMs: 1,
  }
}

function tool(name: string): Tool {
  return {
    name,
    description: name,
    source: 'builtin',
    domain: 'host',
    riskLevel: 'safe',
    async call() {
      return { output: 'ok' }
    },
    formatResult(output, toolUseId) {
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: String(output),
      }
    },
  }
}

test('messageToText renders user text', () => {
  assert.equal(messageToText(createUserMessage('hello', null, 10)), '[user]\nhello')
})

test('messageToText renders assistant text and tool_use', () => {
  const message = createAssistantMessage({
    content: [
      { type: 'text', text: 'done' },
      { type: 'tool_use', id: 't1', name: 'Read', input: { path: 'a.txt' } },
    ],
    stopReason: 'tool_use',
    usage: {},
    timestamp: 20,
  })
  assert.match(messageToText(message), /Tool use: Read/)
})

test('buildExtractPrompt instructs tool-use and not JSON output', () => {
  const prompt = buildExtractPrompt(
    [createUserMessage('remember my preference', null, 10)],
    [memory('project-style.md')],
  )
  assert.match(prompt, /MemoryWrite/)
  assert.match(prompt, /Do not output JSON/)
  assert.match(prompt, /project-style\.md/)
})

test('hasMemoryWritesSince detects assistant MemoryWrite tool_use', () => {
  const message = createAssistantMessage({
    content: [
      {
        type: 'tool_use',
        id: 't1',
        name: 'MemoryWrite',
        input: { filename: 'user.md' },
      },
    ],
    stopReason: 'tool_use',
    usage: {},
    timestamp: 20,
  })
  assert.equal(hasMemoryWritesSince([message], 10), true)
})

test('hasMemoryWritesSince ignores old MemoryWrite tool_use', () => {
  const message = createAssistantMessage({
    content: [
      {
        type: 'tool_use',
        id: 't1',
        name: 'MemoryWrite',
        input: { filename: 'user.md' },
      },
    ],
    stopReason: 'tool_use',
    usage: {},
    timestamp: 5,
  })
  assert.equal(hasMemoryWritesSince([message], 10), false)
})

test('getBashHead skips env prefixes and path dirs', () => {
  assert.equal(getBashHead('LANG=C /usr/bin/grep foo file'), 'grep')
})

test('isReadOnlyBash accepts read-only heads', () => {
  assert.equal(isReadOnlyBash({ command: 'cat note.md' }), true)
})

test('isReadOnlyBash rejects mutating heads', () => {
  assert.equal(isReadOnlyBash({ command: 'rm -rf /tmp/a' }), false)
})

test('auto memory tool gate allows MemoryWrite', async () => {
  const gate = createAutoMemCanUseTool('/tmp/memory')
  assert.deepEqual(await gate(tool('MemoryWrite'), {}), { behavior: 'allow' })
})

test('auto memory tool gate denies Edit', async () => {
  const gate = createAutoMemCanUseTool('/tmp/memory')
  const decision = await gate(tool('Edit'), {})
  assert.equal(decision.behavior, 'deny')
})
