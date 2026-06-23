import type { LightClawConfig } from '../config.js'
import { t } from '../i18n/index.js'

import { runMountCommand } from './mount.js'
import { runSecretCommand } from './secret.js'

/**
 * Context for the `/system` hub. It is the union of what the delegated
 * runners need: `key` → secret runner (userId only), `mount` → mount runner
 * (config + userId + the rlaunch restart hook the channel passes through).
 */
type SystemCommandContext = {
  config: LightClawConfig
  userId?: string
}

type SystemCommandDeps = {
  restartRlaunch?: () => Promise<string>
}

/**
 * `/system <noun> [verb] [args]` — the runtime-resource operation hub
 * (PR5.9 checkpoint B1). It additively absorbs `/secret` (noun `key`) and
 * `/mount` (noun `mount`) by stripping the noun token and delegating the
 * remaining arg string to the existing runners — same return shape, no
 * behavior change. `data` (import/export) is registered as a grammar stub
 * here; its real logic is owned by PR7.
 *
 * `/secret` and `/mount` stay registered in parallel (retired in B6), so
 * this is a strict superset surface, not a replacement.
 */
export async function runSystemCommand(
  rawArgs: string,
  ctx: SystemCommandContext,
  deps: SystemCommandDeps = {},
): Promise<string> {
  const trimmed = rawArgs.trim()
  const firstSpace = trimmed.search(/\s/)
  const noun = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase()
  const rest = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1).trim()

  switch (noun) {
    case 'key':
      // The secret runner already accepts bare/list/status (read) and
      // set/enable/disable/rm|remove (write); pass through verbatim.
      return runSecretCommand(rest, { userId: ctx.userId })
    case 'mount':
      // The mount runner already accepts bare/list (read) and add/rm|remove
      // (write); pass through verbatim plus the restart hook.
      return runMountCommand(rest, { config: ctx.config, userId: ctx.userId }, deps)
    case 'data':
      return runDataNoun(rest)
    default:
      // Empty or unknown noun → the /system overview (nouns + verb hints).
      return `${t('system.usage')}\n`
  }
}

/**
 * `data` noun stub. Real import/export is PR7-owned; B1 only stabilizes the
 * grammar. Bare prints usage; `import`/`export` return a coming-soon notice.
 * No destructive behavior.
 */
function runDataNoun(rest: string): string {
  const verb = (rest.split(/\s+/).filter(Boolean)[0] ?? '').toLowerCase()
  if (verb === 'import' || verb === 'export') {
    return `${t('system.data.comingSoon')}\n`
  }
  return `${t('system.data.usage')}\n`
}
