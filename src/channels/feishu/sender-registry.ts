// Module-level singleton handle to the active FeishuSender. Set by
// feishu-channel.start() and cleared on stop(). Read by code that lives
// outside the channel runner (e.g. /user approve in commands/builtin.ts —
// admin's slash command runs in its own state, but needs to push a welcome
// card to a freshly approved user, which only the channel-owned sender can
// deliver).
//
// Single-channel design: LightClaw runs at most one feishu channel per
// process, so a plain module-level slot is enough. If we ever fan out to
// multiple feishu tenants, switch this to a Map<tenantId, FeishuSender>.

import type { FeishuSender } from './sender.js'

let activeSender: FeishuSender | null = null

export function registerFeishuSender(sender: FeishuSender): void {
  activeSender = sender
}

export function clearFeishuSender(sender: FeishuSender): void {
  if (activeSender === sender) {
    activeSender = null
  }
}

export function getFeishuSender(): FeishuSender | null {
  return activeSender
}
