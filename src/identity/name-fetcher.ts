import type { ChannelKind } from './types.js'

export async function fetchBestEffortDisplayName(input: {
  channel: ChannelKind
  peerId: string
  client?: unknown
}): Promise<string> {
  if (input.channel !== 'feishu' || !input.client) {
    return ''
  }

  try {
    const client = input.client as {
      contact?: {
        user?: {
          get?: (args: unknown) => Promise<unknown>
        }
      }
    }
    const response = await client.contact?.user?.get?.({
      path: { user_id: input.peerId },
      params: { user_id_type: 'open_id' },
    })
    const data = response as { data?: { user?: { name?: string; en_name?: string } } }
    return data.data?.user?.name ?? data.data?.user?.en_name ?? ''
  } catch {
    return ''
  }
}

