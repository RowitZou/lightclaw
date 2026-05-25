import type { FeishuClient } from './client.js'
import { classifyFeishuError, formatFeishuErrorForLog } from './resources/errors.js'

export type FeishuUserInfo = {
  name?: string
  email?: string
  userId?: string
}

let warnedNoContactScope = false

export async function fetchFeishuUserInfo(
  client: FeishuClient,
  openId: string,
): Promise<FeishuUserInfo | undefined> {
  // Feishu's contact.v3.user.get with user_id_type=open_id rejects bot app_ids
  // (`cli_xxx`) with HTTP 400 (not a structured Feishu envelope), polluting the
  // stderr stream every time a parent message was sent by a bot. Short-circuit
  // here so all callers (ParentMessageFetcher sender-name resolution, pairing,
  // sender display) treat bot senders as "no contact info" cleanly.
  if (openId.startsWith('cli_')) {
    return undefined
  }
  try {
    const resp = await client.contact.v3.user.get({
      path: { user_id: openId },
      params: { user_id_type: 'open_id' },
    })
    const envelope = resp as unknown as {
      code?: number
      msg?: string
      data?: {
        user?: {
          name?: string
          en_name?: string
          email?: string
          user_id?: string
        }
      }
    }
    if (envelope.code !== 0) {
      const c = classifyFeishuError({ response: { status: 400, data: envelope } })
      if (c.kind === 'scope-missing') {
        warnNoContactScopeOnce(`${c.adminMessage} contact:contact.base:readonly scope not granted; sender names will fall back to open_id`)
      }
      return undefined
    }

    const user = envelope.data?.user
    if (!user) {
      return undefined
    }
    const name = user.name?.trim() || user.en_name?.trim() || undefined
    const email = user.email?.trim() || undefined
    const userId = user.user_id?.trim() || undefined
    if (!name && !email && !userId) {
      return undefined
    }
    return {
      ...(name ? { name } : {}),
      ...(email ? { email } : {}),
      ...(userId ? { userId } : {}),
    }
  } catch (error) {
    const c = classifyFeishuError(error)
    if (c.kind === 'scope-missing') {
      warnNoContactScopeOnce(`${c.adminMessage} contact:contact.base:readonly scope not granted; sender names will fall back to open_id`)
      return undefined
    }
    process.stderr.write(
      `feishu pairing: contact lookup failed for ${openId}: ${formatFeishuErrorForLog(error, 'contact.user.get')}\n`,
    )
    return undefined
  }
}

export function resetFeishuUserInfoWarningsForTest(): void {
  warnedNoContactScope = false
}

function warnNoContactScopeOnce(detail = 'feishu pairing: contact:contact.base:readonly scope not granted; sender names will fall back to open_id'): void {
  if (warnedNoContactScope) {
    return
  }
  warnedNoContactScope = true
  process.stderr.write(`${detail}\n`)
}
