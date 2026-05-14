import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { setLightclawHomeOverride } from '../paths.js'
import { setAdmin } from '../identity/store.js'
import { clearFeishuSender, registerFeishuSender } from '../channels/feishu/sender-registry.js'
import type { FeishuSender } from '../channels/feishu/sender.js'
import {
  buildWakePrompt,
  deliverWakeNotification,
  resolveOriginWakeSessionId,
  resolveWakeSessionId,
  wakeMainAgent,
} from './wake.js'
import type { BackgroundTaskEntry, FireOutcome } from './types.js'

describe('buildWakePrompt', () => {
  it('renders permission_denied details and auto-heal instructions', () => {
    const prompt = buildWakePrompt(fakeTask(), {
      kind: 'failure',
      reason: 'permission denied',
      transient: false,
      attempt: 1,
      permissionDenials: [{
        toolName: 'Bash',
        inputPreview: 'Command: find /tmp -type f',
        suggestedRules: ['Bash(find:*)'],
      }],
    })

    assert.match(prompt, /<outcome-kind>permission_denied<\/outcome-kind>/)
    assert.match(prompt, /Bash\(find:\*\)/)
    assert.match(prompt, /UpdateBackgroundTask/)
    assert.match(prompt, /notify_user/)
    assert.match(prompt, /stay_silent/)
  })

  it('keeps the normal wake prompt for non-permission outcomes', () => {
    const outcome: FireOutcome = {
      kind: 'success',
      summary: 'all good',
      transcriptPath: '/tmp/transcript.jsonl',
    }
    const prompt = buildWakePrompt(fakeTask(), outcome)
    assert.match(prompt, /<outcome>all good<\/outcome>/)
    assert.doesNotMatch(prompt, /permission_denied/)
  })

  it('inserts a prompt-change notice block when priorPromptNotice is provided', () => {
    const outcome: FireOutcome = {
      kind: 'success',
      summary: 'all good',
      transcriptPath: '/tmp/transcript.jsonl',
    }
    const prompt = buildWakePrompt(fakeTask(), outcome, 'remind me at 8am every weekday')
    assert.match(prompt, /<prompt-change-notice>/)
    assert.match(prompt, /<prior>remind me at 8am every weekday<\/prior>/)
    assert.match(prompt, /<task-prompt>.*<\/task-prompt>/)
  })

  it('omits the prompt-change notice block when priorPromptNotice is undefined', () => {
    const outcome: FireOutcome = {
      kind: 'success',
      summary: 'all good',
      transcriptPath: '/tmp/transcript.jsonl',
    }
    const prompt = buildWakePrompt(fakeTask(), outcome)
    assert.doesNotMatch(prompt, /prompt-change-notice/)
  })

  it('still includes the prompt-change notice on permission_denied wakes', () => {
    const prompt = buildWakePrompt(fakeTask(), {
      kind: 'failure',
      reason: 'permission denied',
      transient: false,
      attempt: 1,
      permissionDenials: [{
        toolName: 'Bash',
        inputPreview: 'Command: find /tmp -type f',
        suggestedRules: ['Bash(find:*)'],
      }],
    }, 'old prompt before user edit')
    assert.match(prompt, /<outcome-kind>permission_denied<\/outcome-kind>/)
    assert.match(prompt, /<prior>old prompt before user edit<\/prior>/)
  })
})

describe('resolveWakeSessionId', () => {
  let tmpDir: string
  let sessionsDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'lightclaw-wake-resolve-'))
    sessionsDir = path.join(tmpDir, 'sessions')
    mkdirSync(sessionsDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns null when sessions dir does not exist', async () => {
    const missingDir = path.join(tmpDir, 'never-existed')
    assert.equal(await resolveWakeSessionId('alice', missingDir), null)
  })

  it('returns null when no DM session belongs to the user', async () => {
    writeMeta(sessionsDir, 'feishu:dm:oc_someone-else', { userId: 'bob', lastActiveAt: 100 })
    writeMeta(sessionsDir, 'feishu:group:oc_g:ou_alice', { userId: 'alice', lastActiveAt: 200 })
    writeMeta(sessionsDir, 'terminal-alice', { userId: 'alice', lastActiveAt: 300 })

    assert.equal(await resolveWakeSessionId('alice', sessionsDir), null)
  })

  it('picks the most-recently-active DM session for the canonical user', async () => {
    writeMeta(sessionsDir, 'feishu:dm:oc_old', { userId: 'alice', lastActiveAt: 100 })
    writeMeta(sessionsDir, 'feishu:dm:oc_new', { userId: 'alice', lastActiveAt: 500 })
    writeMeta(sessionsDir, 'feishu:dm:oc_mid', { userId: 'alice', lastActiveAt: 300 })

    assert.equal(await resolveWakeSessionId('alice', sessionsDir), 'feishu:dm:oc_new')
  })

  it('ignores DM sessions belonging to other users and skips group sessions', async () => {
    writeMeta(sessionsDir, 'feishu:dm:oc_alice_dm', { userId: 'alice', lastActiveAt: 100 })
    // bob's DM session is more recent but should not be picked for alice
    writeMeta(sessionsDir, 'feishu:dm:oc_bob_dm', { userId: 'bob', lastActiveAt: 999 })
    // even alice's most-recent group session must lose to her DM
    writeMeta(sessionsDir, 'feishu:group:oc_g:ou_alice', { userId: 'alice', lastActiveAt: 999 })

    assert.equal(await resolveWakeSessionId('alice', sessionsDir), 'feishu:dm:oc_alice_dm')
  })

  it('tolerates session dirs whose meta.json is missing or unreadable', async () => {
    // Directory with no meta.json — must not throw, must not be picked.
    mkdirSync(path.join(sessionsDir, 'feishu:dm:oc_meta_missing'), { recursive: true })
    writeMeta(sessionsDir, 'feishu:dm:oc_alice_dm', { userId: 'alice', lastActiveAt: 100 })

    assert.equal(await resolveWakeSessionId('alice', sessionsDir), 'feishu:dm:oc_alice_dm')
  })
})

describe('resolveOriginWakeSessionId (Bug 15)', () => {
  let tmpDir: string
  let sessionsDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'lightclaw-wake-origin-'))
    sessionsDir = path.join(tmpDir, 'sessions')
    mkdirSync(sessionsDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns the origin sessionId when it points at an existing feishu:group: transcript', async () => {
    writeMeta(sessionsDir, 'feishu:group:oc_g:ou_alice', { userId: 'alice', lastActiveAt: 100 })
    const result = await resolveOriginWakeSessionId('feishu:group:oc_g:ou_alice', sessionsDir)
    assert.equal(result, 'feishu:group:oc_g:ou_alice')
  })

  it('returns the origin sessionId when it points at an existing feishu:dm: transcript', async () => {
    writeMeta(sessionsDir, 'feishu:dm:oc_alice', { userId: 'alice', lastActiveAt: 100 })
    const result = await resolveOriginWakeSessionId('feishu:dm:oc_alice', sessionsDir)
    assert.equal(result, 'feishu:dm:oc_alice')
  })

  it('returns null when origin sessionId is not a feishu DM/group prefix (terminal / branch / fresh)', async () => {
    assert.equal(await resolveOriginWakeSessionId('terminal-alice', sessionsDir), null)
    assert.equal(await resolveOriginWakeSessionId('branch-alice-abc', sessionsDir), null)
    assert.equal(await resolveOriginWakeSessionId('fresh-xyz', sessionsDir), null)
  })

  it('returns null when origin transcript has been deleted (caller falls back to DM)', async () => {
    // Origin parses to feishu:group: but the on-disk dir does not exist
    const result = await resolveOriginWakeSessionId('feishu:group:oc_gone:ou_alice', sessionsDir)
    assert.equal(result, null)
  })
})

describe('wakeMainAgent input gates', () => {
  it('refuses non-DM session ids without acquiring any runtime', async () => {
    const result = await wakeMainAgent({
      canonicalUser: 'alice',
      mainSessionId: 'feishu-alice', // pre-Phase-26 hard-coded form
      task: fakeTask(),
      outcome: { kind: 'success', summary: 'ok', transcriptPath: '/tmp/x.jsonl' },
    })
    assert.deepEqual(result, { kind: 'silent', reason: 'wake-refused-bad-session-id' })
  })

  it('refuses non-Feishu session ids (terminal, branch, fresh) without acquiring any runtime', async () => {
    // Bug 15 relaxed the precondition to accept both feishu:dm: and feishu:group:.
    // Non-Feishu ids (terminal sessions, branch/fresh forks) are still refused —
    // wake needs a real Feishu transcript and the channelSessionLock keyed on
    // a Feishu session id so the user's main turn lock semantics hold.
    const result = await wakeMainAgent({
      canonicalUser: 'alice',
      mainSessionId: 'terminal-alice', // not a Phase 26 Feishu shape
      task: fakeTask(),
      outcome: { kind: 'success', summary: 'ok', transcriptPath: '/tmp/x.jsonl' },
    })
    assert.deepEqual(result, { kind: 'silent', reason: 'wake-refused-bad-session-id' })
  })

  it('refuses paired non-admin user under local backend (admin-only LocalRuntime)', async () => {
    const tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-wake-admin-gate-'))
    setLightclawHomeOverride(tmpHome)
    try {
      writeFileSync(path.join(tmpHome, 'config.json'), JSON.stringify({
        endpoints: { a: { apiKey: 'sk-fake' } },
        models: { m: { endpoint: 'a', schema: 'anthropic', upstreamModel: 'claude-fake' } },
        model: 'm',
        runtime: { backend: 'local' },
      }))
      mkdirSync(path.join(tmpHome, 'workspaces', 'bob'), { recursive: true })
      await setAdmin('alice')

      const result = await wakeMainAgent({
        canonicalUser: 'bob', // paired non-admin
        mainSessionId: 'feishu:dm:oc_bob_dm',
        task: fakeTask(),
        outcome: { kind: 'success', summary: 'ok', transcriptPath: '/tmp/x.jsonl' },
      })
      assert.deepEqual(result, { kind: 'silent', reason: 'wake-refused-admin-only' })
    } finally {
      setLightclawHomeOverride(undefined)
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })
})

describe('deliverWakeNotification origin routing', () => {
  let calls: Array<{ chatId?: string; openId?: string; text: string }>
  let fakeSender: Pick<FeishuSender, 'sendMarkdownTextToChatId' | 'sendMarkdownTextToOpenId'>

  beforeEach(() => {
    calls = []
    fakeSender = {
      async sendMarkdownTextToChatId(chatId: string, text: string) {
        calls.push({ chatId, text })
      },
      async sendMarkdownTextToOpenId(openId: string, text: string) {
        calls.push({ openId, text })
      },
    }
    registerFeishuSender(fakeSender as unknown as FeishuSender)
  })

  afterEach(() => {
    clearFeishuSender(fakeSender as unknown as FeishuSender)
  })

  it('group-origin wake delivers notify_user output to the origin group chat_id', async () => {
    await deliverWakeNotification({
      wakeSessionId: 'feishu:group:oc_grp:ou_alice',
      ownerOpenId: 'ou_alice',
      taskLabel: 'NVDA watch',
      result: { kind: 'notify', text: 'NVDA up 3%' },
    })
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.chatId, 'oc_grp')
    assert.equal(calls[0]?.openId, undefined)
    assert.match(calls[0]?.text ?? '', /NVDA watch/)
    assert.match(calls[0]?.text ?? '', /NVDA up 3%/)
  })

  it('topic-group origin delivers to the parent group chat_id (threadId not separately addressed)', async () => {
    await deliverWakeNotification({
      wakeSessionId: 'feishu:group:oc_grp:omt_thread:ou_alice',
      ownerOpenId: 'ou_alice',
      taskLabel: 'X',
      result: { kind: 'notify', text: 'y' },
    })
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.chatId, 'oc_grp')
  })

  it('DM-origin wake delivers to the owner DM open_id', async () => {
    await deliverWakeNotification({
      wakeSessionId: 'feishu:dm:oc_dm',
      ownerOpenId: 'ou_alice',
      taskLabel: 'X',
      result: { kind: 'notify', text: 'y' },
    })
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.openId, 'ou_alice')
    assert.equal(calls[0]?.chatId, undefined)
  })

  it('non-Feishu wakeSessionId (fallback) delivers to the owner DM open_id', async () => {
    await deliverWakeNotification({
      wakeSessionId: 'terminal-alice',
      ownerOpenId: 'ou_alice',
      taskLabel: 'X',
      result: { kind: 'notify', text: 'y' },
    })
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.openId, 'ou_alice')
  })

  it('delivers nothing when the wake decision is not notify', async () => {
    await deliverWakeNotification({
      wakeSessionId: 'feishu:group:oc_grp:ou_alice',
      ownerOpenId: 'ou_alice',
      taskLabel: 'X',
      result: { kind: 'silent', reason: 'nothing to report' },
    })
    assert.equal(calls.length, 0)
  })
})

function writeMeta(
  sessionsDir: string,
  sessionId: string,
  meta: { userId: string; lastActiveAt: number },
): void {
  const dir = path.join(sessionsDir, sessionId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    sessionId,
    model: 'm',
    cwd: '/tmp',
    createdAt: 0,
    lastActiveAt: meta.lastActiveAt,
    messageCount: 0,
    compactionCount: 0,
    userId: meta.userId,
  }))
}

function fakeTask(): BackgroundTaskEntry {
  return {
    id: 'task-1',
    ownerCanonicalUser: 'alice',
    prompt: 'check the workspace and summarize anything important',
    schedule: { kind: 'interval', everyMinutes: 60 },
    label: 'Workspace check',
    notifyOn: 'always',
    notifyTo: 'agent',
    enabled: true,
    createdAt: '2026-05-07T10:00:00.000Z',
    consecutiveFailures: 0,
    fireHistory: [],
  }
}
