// Lookup product-language display name for a worker role's agentType. Used by
// the progress / worker-activity breadcrumb path to render verb-progressive
// phrases ("正在搜索互联网") instead of internal role ids ("webSearcher").
//
// Returns undefined when the role isn't in the registry, isn't a worker, or
// hasn't filled `displayName`. Callers fall back to a generic user-facing
// label (e.g. `t('channel.actor.fallback')`) — never to the raw agentType,
// which would leak internal vocabulary the user is meant not to see.
//
// Why optional rather than required: bundled workers ship displayName today,
// but user-defined roles loaded from `<lightclawHome>/roles/<name>/ROLE.md`
// may legitimately omit it. We prefer a graceful "正在执行任务" than to force
// every operator-authored role to translate themselves before they can be
// dispatched.

import { getLang } from '../i18n/index.js'
import { getAgent } from './registry.js'

export function resolveDisplayName(agentType: string): string | undefined {
  const role = getAgent(agentType)
  if (!role?.displayName) return undefined
  return role.displayName[getLang()] ?? role.displayName.en
}
