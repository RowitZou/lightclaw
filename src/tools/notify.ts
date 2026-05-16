import { z } from 'zod'

import { getIdentity } from '../identity/store.js'
import { getCurrentUserId, getSessionId } from '../state.js'
import { buildTool } from '../tool.js'
import { getSignalRouter } from '../signal-bus/router.js'
import { getFeishuSender } from '../channels/feishu/sender-registry.js'
import { parseFeishuSessionId } from '../channels/feishu/routing.js'

const NOTIFY_DESCRIPTION = `Send a high-priority notification card to the user. Use this ONLY when the user genuinely cannot afford to miss the message - anything routine should go as plain reply or stay silent.

This is your escalation channel. Plain reply (your normal channel response) is the default for ordinary information; Notify produces a visually distinct colored card that demands attention. Overusing Notify makes users learn to ignore the cards, defeating its purpose entirely.

## severity (drives card color, required)
- 'info' (green/blue): a thing the user explicitly asked to be notified about has happened. Example: user said "tell me when the deploy finishes" -> deploy finished. Routine completion / FYI is NOT info; use plain reply.
- 'warning' (yellow): something needs the user's attention but is not yet broken. Example: API quota crossed 80%, retry count rising, certificate expires in 3 days.
- 'urgent' (red): the user must read this now. Example: deploy failed, security incident, cron task on its 5th consecutive failure, data loss risk, user's hard deadline reached.

## target (required)
- 'this-chat' (default choice): card appears in the current chat (DM stays DM, group stays group). Natural for most cases - user already chose this chat as the locus.
- 'user-dm': card pushed to the user's private DM with bot. Use when the content is sensitive in a group context (user's personal deploy/quota/finances/credentials), or when the current chat is a group thread where bystanders shouldn't see the message.

## When to use Notify (yes) vs not (no)
yes: User explicitly asked to be pinged when X happens, and X happened.
yes: A scheduled task you dispatched has hit a critical threshold or failed in a way that requires user action.
yes: Security / privacy / data-integrity alert.
yes: A user-set condition has been triggered ("notify me when NVDA crosses 200").
no: "Web research is done, here's the result" - that's a plain reply.
no: Routine progress updates ("step 3 of 5 complete") - that's progress signal territory, not Notify.
no: FYI information the user might find interesting - plain reply or stay silent.
no: Cron task fired successfully as expected - plain reply if anything, often stay silent.
no: Self-acknowledgment / meta-commentary about what you just did - never goes through Notify.

When in doubt, default to plain reply or silence. Notify is the manager-to-stakeholder escalation, not your daily voice.

## title and body
- title (2-60 chars): the headline shown prominently on the card. Make it specific and information-bearing: "Deploy failed: 3 services down" beats "Deploy update".
- body (>= 5 chars): the detail. Markdown supported. Include what happened, what it means, and what action is needed (if any) - the user should be able to decide their next step from the card alone without needing to ask follow-up questions.`

export const notifyTool = buildTool({
  name: 'Notify',
  shouldDefer: true,
  description: NOTIFY_DESCRIPTION,
  searchHint: 'alert notification notify urgent warning important card 通知 提醒 重要 告警',
  domain: 'host',
  riskLevel: 'write',
  inputSchema: z.object({
    title: z.string().min(2).max(60),
    body: z.string().min(5),
    severity: z.enum(['info', 'warning', 'urgent']),
    target: z.enum(['this-chat', 'user-dm']),
  }),
  async call(input) {
    const userId = getCurrentUserId()
    if (!userId) {
      return { output: 'Notify requires an active user identity.', isError: true }
    }
    const identity = await getIdentity(userId).catch(() => null)
    const openId = identity?.channels.feishu[0]
    if (!openId) {
      return { output: `Notify cannot deliver: no Feishu open_id is bound for ${userId}.`, isError: true }
    }
    const sessionId = getSessionId()
    await getSignalRouter().publish({
      kind: 'notification',
      from: { kind: 'role', id: 'main', sessionId },
      to: { kind: 'user', id: openId },
      payload: {
        kind: 'card',
        fromTool: 'Notify',
        severity: input.severity,
        title: input.title,
        body: input.body,
        target: input.target,
      },
      timing: { emittedAt: Date.now() },
      chainId: sessionId,
    })

    const sender = getFeishuSender()
    if (!sender) {
      return { output: 'Notify signal emitted, but no Feishu sender is registered.', isError: true }
    }
    const card = buildNotifyCard(input)
    if (input.target === 'user-dm') {
      await sender.sendInteractiveCardToOpenId(openId, card, {
        purpose: 'notice',
        canonicalUser: userId,
      })
    } else {
      const parsed = parseFeishuSessionId(sessionId)
      if (!parsed) {
        await sender.sendInteractiveCardToOpenId(openId, card, {
          purpose: 'notice',
          canonicalUser: userId,
        })
      } else {
        await sender.sendInteractiveCardToChatId(parsed.chatId, card, {
          purpose: 'notice',
          canonicalUser: userId,
        })
      }
    }
    return { output: `Notification delivered: ${input.severity} "${input.title}" to ${input.target}` }
  },
})

export function buildNotifyCard(input: {
  title: string
  body: string
  severity: 'info' | 'warning' | 'urgent'
}): Record<string, unknown> {
  const template = {
    info: 'green',
    warning: 'yellow',
    urgent: 'red',
  }[input.severity]
  return {
    config: { wide_screen_mode: true },
    header: {
      template,
      title: { tag: 'plain_text', content: input.title },
    },
    elements: [{
      tag: 'div',
      text: { tag: 'lark_md', content: input.body },
    }],
  }
}

export const __notifyDescriptionForSnapshot = NOTIFY_DESCRIPTION
