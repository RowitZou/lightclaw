import type { Channel, ChannelId, ChannelsConfig } from './types.js'
import { createFeishuChannel } from './feishu/feishu-channel.js'

/**
 * A ChannelFactory turns the top-level ChannelsConfig into a concrete
 * Channel, or returns null if this channel is not present in the config
 * at all (distinct from "configured but disabled"). Registered once per
 * channel id.
 */
export type ChannelFactory = (config: ChannelsConfig) => Channel | null

const factories: Array<{ id: ChannelId; create: ChannelFactory }> = [
  { id: 'feishu', create: config => createFeishuChannel(config.feishu) },
]

/**
 * Build all channels present in the given config. Used by
 * `lightclaw channel list` to iterate without hard-coding channel ids.
 */
export function listChannels(config: ChannelsConfig): Channel[] {
  const channels: Channel[] = []
  for (const factory of factories) {
    const channel = factory.create(config)
    if (channel) {
      channels.push(channel)
    }
  }
  return channels
}

export function getChannel(config: ChannelsConfig, id: ChannelId): Channel | null {
  const factory = factories.find(entry => entry.id === id)
  if (!factory) {
    return null
  }
  return factory.create(config)
}

export function knownChannelIds(): ChannelId[] {
  return factories.map(entry => entry.id)
}
