import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

import { setLightclawHomeOverride } from '../../paths.js'
import { writeTaskCardBinding } from './task-card-binding.js'
import { resolveTaskCardReplyAnchor } from './task-card-reply-anchor.js'

const OWNER = 'alice'
const ROOT = 'tr_anchor_root'

let home: string

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'lightclaw-card-anchor-'))
  setLightclawHomeOverride(home)
})

afterEach(() => {
  setLightclawHomeOverride(undefined)
  rmSync(home, { recursive: true, force: true })
})

describe('resolveTaskCardReplyAnchor', () => {
  it('resolves the card message id when the binding matches the target chat (DM)', async () => {
    await writeTaskCardBinding(OWNER, ROOT, {
      chatId: 'oc_dm',
      messageId: 'om_card_1',
    })
    assert.equal(
      await resolveTaskCardReplyAnchor({ owner: OWNER, rootRunId: ROOT, chatId: 'oc_dm' }),
      'om_card_1',
    )
  })

  it('resolves inside a topic group when both threadIds match', async () => {
    await writeTaskCardBinding(OWNER, ROOT, {
      chatId: 'oc_grp',
      threadId: 'omt_topic',
      messageId: 'om_card_2',
    })
    assert.equal(
      await resolveTaskCardReplyAnchor({
        owner: OWNER,
        rootRunId: ROOT,
        chatId: 'oc_grp',
        threadId: 'omt_topic',
      }),
      'om_card_2',
    )
  })

  it('returns undefined when no binding exists', async () => {
    assert.equal(
      await resolveTaskCardReplyAnchor({ owner: OWNER, rootRunId: ROOT, chatId: 'oc_dm' }),
      undefined,
    )
  })

  it('returns undefined when the card lives in a different chat', async () => {
    await writeTaskCardBinding(OWNER, ROOT, {
      chatId: 'oc_group_origin',
      messageId: 'om_card_3',
    })
    assert.equal(
      await resolveTaskCardReplyAnchor({ owner: OWNER, rootRunId: ROOT, chatId: 'oc_dm' }),
      undefined,
    )
  })

  it('returns undefined on topic mismatch in either direction', async () => {
    await writeTaskCardBinding(OWNER, ROOT, {
      chatId: 'oc_grp',
      threadId: 'omt_topic_a',
      messageId: 'om_card_4',
    })
    // Turn output targets a different topic — replying to the card would
    // pull the output out of its topic.
    assert.equal(
      await resolveTaskCardReplyAnchor({
        owner: OWNER,
        rootRunId: ROOT,
        chatId: 'oc_grp',
        threadId: 'omt_topic_b',
      }),
      undefined,
    )
    // Card is in a topic but the turn output is not (or vice versa).
    assert.equal(
      await resolveTaskCardReplyAnchor({ owner: OWNER, rootRunId: ROOT, chatId: 'oc_grp' }),
      undefined,
    )
  })

  it('returns undefined for a non-replyable (non-om_) binding id', async () => {
    await writeTaskCardBinding(OWNER, ROOT, {
      chatId: 'oc_dm',
      messageId: 'replay-not-a-platform-id',
    })
    assert.equal(
      await resolveTaskCardReplyAnchor({ owner: OWNER, rootRunId: ROOT, chatId: 'oc_dm' }),
      undefined,
    )
  })
})
