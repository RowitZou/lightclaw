import type { FeishuClient } from './client.js'

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
    if (envelope.code === 99991672) {
      warnNoContactScopeOnce()
      return undefined
    }
    if (envelope.code !== 0) {
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
    const detail = error instanceof Error ? error.message : String(error)
    process.stderr.write(`feishu pairing: contact lookup failed for ${openId}: ${detail}\n`)
    return undefined
  }
}

export function resetFeishuUserInfoWarningsForTest(): void {
  warnedNoContactScope = false
}

function warnNoContactScopeOnce(): void {
  if (warnedNoContactScope) {
    return
  }
  warnedNoContactScope = true
  process.stderr.write(
    'feishu pairing: contact:contact.base:readonly scope not granted; sender names will fall back to open_id\n',
  )
}
