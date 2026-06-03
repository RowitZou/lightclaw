import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createSystemCompactMessage,
  createAssistantMessage,
  createUserMessage,
} from '../messages.js'
import type { LightClawConfig } from '../config.js'
import type { Message } from '../types.js'
import {
  buildCompactPrompt,
  compactConversation,
  findSafeSplitIndex,
  setCompactSummaryRequesterForTest,
} from './compact.js'

const fakeConfig = {
  paths: { sessions: '/tmp/lightclaw-compact-test-sessions' },
} as unknown as LightClawConfig

function userText(text: string): Message {
  return createUserMessage(text)
}

function userToolResult(toolUseId: string, text = 'ok'): Message {
  return createUserMessage([
    { type: 'tool_result', tool_use_id: toolUseId, content: text },
  ])
}

function taggedSkillResult(toolUseId: string, name: string, body: string): Message {
  return userToolResult(
    toolUseId,
    `<skill-content name="${name}">\nUse the skill "${name}".\n\n${body}\n</skill-content>`,
  )
}

function assistantText(text: string): Message {
  return createAssistantMessage({
    content: [{ type: 'text', text }],
    stopReason: 'end_turn',
    usage: {},
  })
}

function assistantToolUse(id: string, name = 'Read'): Message {
  return createAssistantMessage({
    content: [{ type: 'tool_use', id, name, input: {} }],
    stopReason: 'tool_use',
    usage: {},
  })
}

async function compactWithCapturedPrompt(messages: Message[], keepRecent = 1) {
  let prompt = ''
  setCompactSummaryRequesterForTest(async (receivedPrompt) => {
    prompt = receivedPrompt
    return {
      summary: '<summary>Compacted work summary.</summary>',
      usage: { input_tokens: 11, output_tokens: 7 },
    }
  })
  try {
    const result = await compactConversation({
      messages,
      keepRecent,
      config: fakeConfig,
    })
    assert.ok(prompt.length > 0)
    assert.equal(result.messages[0]?.type, 'system')
    return {
      prompt,
      result,
      summary: result.messages[0].message.summary,
    }
  } finally {
    setCompactSummaryRequesterForTest(null)
  }
}

test('findSafeSplitIndex: returns initial when toKeep[0] is plain user text', () => {
  const messages: Message[] = [
    userText('q1'),
    assistantText('a1'),
    userText('q2'),
    assistantText('a2'),
  ]
  // initial split = 2 (keep last 2: user + assistant)
  assert.equal(findSafeSplitIndex(messages, 2), 2)
})

test('findSafeSplitIndex: rewinds one step when split severs assistant.tool_use from user.tool_result', () => {
  // The exact 2026-05-09 incident shape: WebFetch tool_use lives in the
  // compressed prefix, its tool_result lands at the head of the keep window.
  const messages: Message[] = [
    userText('q1'),                       // 0
    assistantToolUse('call_X', 'WebFetch'), // 1  ← belongs in toKeep
    userToolResult('call_X', 'fetch out'),  // 2  ← initial split here = orphan
    assistantText('summary'),               // 3
  ]
  // initial split = 2 → toKeep starts with orphan tool_result → rewind to 1
  assert.equal(findSafeSplitIndex(messages, 2), 1)
})

test('findSafeSplitIndex: rewinds across a multi-pair chain', () => {
  // Two back-to-back tool calls where keepRecent is set so the boundary
  // initially lands inside the chain. Both tool_use messages must come along.
  const messages: Message[] = [
    userText('q1'),                          // 0
    assistantToolUse('call_A', 'Read'),       // 1
    userToolResult('call_A'),                 // 2
    assistantToolUse('call_B', 'Read'),       // 3
    userToolResult('call_B'),                 // 4
    assistantText('done'),                    // 5
  ]
  // initial split = 4 lands on userToolResult(call_B) — orphan because
  // assistantToolUse(call_B) is at index 3 (still in compress). Rewind to 3.
  assert.equal(findSafeSplitIndex(messages, 4), 3)
})

test('findSafeSplitIndex: stops at 0 if every prefix message is orphan-shaped', () => {
  const messages: Message[] = [
    userToolResult('call_X'), // 0 — pathological transcript starting with orphan
    assistantText('ok'),       // 1
  ]
  // initial split = 1 → toKeep[0] = assistantText, not user, so no rewind.
  assert.equal(findSafeSplitIndex(messages, 1), 1)
  // initial split = 0 → already at floor, returns 0.
  assert.equal(findSafeSplitIndex(messages, 0), 0)
})

test('findSafeSplitIndex: clamps initial to messages.length', () => {
  const messages: Message[] = [userText('q1'), assistantText('a1')]
  assert.equal(findSafeSplitIndex(messages, 999), 2)
})

test('findSafeSplitIndex: leaves user message with mixed text + paired tool_result alone', () => {
  // If the tool_result's tool_use lives in toKeep itself, no orphan exists.
  // Current implementation rewinds whenever the head user has *any*
  // tool_result, which is conservative-but-correct: it merges that user's
  // matching tool_use back in too. The test asserts this conservative
  // behavior so we notice if it ever changes.
  const messages: Message[] = [
    userText('q1'),                      // 0
    assistantToolUse('call_X'),           // 1
    userToolResult('call_X'),             // 2
    assistantText('done'),                // 3
  ]
  assert.equal(findSafeSplitIndex(messages, 2), 1)
})

test('compactConversation elides tagged skill bodies from the summary prompt and appends reload pointers', async () => {
  const body = 'SECRET SKILL BODY STEP: run the fragile exact recipe.'
  const messages: Message[] = [
    userText('please use the skill'),
    assistantToolUse('call_skill', 'UseSkill'),
    taggedSkillResult('call_skill', 'demo-skill', body),
    assistantText('I followed the fragile exact recipe and produced artifact A.'),
    userText('continue from here'),
  ]

  const rawPrompt = buildCompactPrompt(messages.slice(0, 4))
  const { prompt, summary } = await compactWithCapturedPrompt(messages, 1)

  assert.ok(prompt.length < rawPrompt.length)
  assert.doesNotMatch(prompt, /SECRET SKILL BODY STEP/)
  assert.match(
    prompt,
    /\[skill "demo-skill" was loaded here; its instructions are omitted from this summary and can be reloaded via UseSkill\]/,
  )
  assert.match(summary, /<reloadable-skills>/)
  assert.match(summary, /If you need their exact steps again, call UseSkill with the skill name:/)
  assert.match(summary, /^- demo-skill$/m)
  assert.match(summary, /I followed the fragile exact recipe|Compacted work summary/)
})

test('compactConversation deduplicates reloadable skill names in first-seen order', async () => {
  const messages: Message[] = [
    userText('load skills'),
    assistantToolUse('call_a', 'UseSkill'),
    taggedSkillResult('call_a', 'demo-skill', 'body A'),
    assistantToolUse('call_b', 'UseSkill'),
    taggedSkillResult('call_b', 'other-skill', 'body B'),
    assistantToolUse('call_c', 'UseSkill'),
    taggedSkillResult('call_c', 'demo-skill', 'body C'),
    assistantText('done'),
    userText('latest'),
  ]

  const { summary } = await compactWithCapturedPrompt(messages, 1)
  const listed = [...summary.matchAll(/^- ([a-z0-9-]+)$/gm)].map(match => match[1])

  assert.deepEqual(listed, ['demo-skill', 'other-skill'])
})

test('compactConversation leaves tagged skill content in the keep window verbatim', async () => {
  const body = 'RECENT SKILL BODY MUST STAY VERBATIM.'
  const messages: Message[] = [
    userText('older request'),
    assistantText('older answer'),
    userText('more context'),
    assistantText('more answer'),
    assistantToolUse('call_recent', 'UseSkill'),
    taggedSkillResult('call_recent', 'recent-skill', body),
  ]

  const { prompt, result, summary } = await compactWithCapturedPrompt(messages, 2)

  assert.doesNotMatch(prompt, /recent-skill/)
  assert.doesNotMatch(summary, /<reloadable-skills>/)
  assert.equal(result.messages.length, 3)
  const kept = result.messages[2]
  assert.equal(kept?.type, 'user')
  assert.match(JSON.stringify(kept.message.content), /RECENT SKILL BODY MUST STAY VERBATIM/)
})

test('compactConversation keeps byte-identical boundary text when no skill roster exists', async () => {
  const messages: Message[] = [
    userText('q1'),
    assistantText('a1'),
    userText('q2'),
    assistantText('a2'),
    userText('latest'),
  ]

  const { summary } = await compactWithCapturedPrompt(messages, 1)

  assert.equal(
    summary,
    'This session continues from a previous conversation that was compacted to fit context.\n'
    + 'The structured summary below covers the earlier portion. Continue from where you left off — '
    + 'do NOT recap what is in the summary, do NOT acknowledge the summary, and do NOT retry '
    + 'steps marked failed in the "Errors and fixes" section.\n\n'
    + 'Compacted work summary.',
  )
})

test('compactConversation tolerates existing reloadable-skills blocks during partial compaction', async () => {
  const messages: Message[] = [
    createSystemCompactMessage({
      summary:
        'Prior summary.\n\n'
        + '<reloadable-skills>\n'
        + 'The full instructions for these skills were loaded earlier in this conversation and elided from the summary above. If you need their exact steps again, call UseSkill with the skill name:\n'
        + '- old-skill\n'
        + '</reloadable-skills>',
      parentUuid: null,
    }),
    userText('q1'),
    assistantText('a1'),
    userText('q2'),
    assistantText('a2'),
    userText('latest'),
  ]

  const { prompt, summary } = await compactWithCapturedPrompt(messages, 1)

  assert.match(prompt, /<reloadable-skills>/)
  assert.doesNotMatch(summary, /<reloadable-skills>/)
})
