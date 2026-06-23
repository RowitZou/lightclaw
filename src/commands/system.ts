import type { LightClawConfig } from '../config.js'
import { loadUserConfigOverride } from '../config/user-override.js'
import { t } from '../i18n/index.js'

import { requireConfirm } from './confirm.js'
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
      // set/enable/disable/rm|remove (write); pass through verbatim — except
      // `rm <NAME>`, which is --y-gated ONLY when the key is referenced by some
      // endpoint (design F.3b: unreferenced keys delete directly).
      return runKeyNoun(rest, ctx)
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
 * `key` noun. Delegates to the shared secret runner, but interposes a --y gate
 * on `rm <NAME>` when the key is referenced by one of the user's BYO endpoints
 * (apiKeyRef). An unreferenced key deletes directly (no --y) — there is nothing
 * to cascade. A referenced key without --y returns a preview listing the
 * dependent endpoint(s) and performs no delete.
 */
async function runKeyNoun(rest: string, ctx: SystemCommandContext): Promise<string> {
  const parts = rest.split(/\s+/).filter(Boolean)
  const verb = (parts[0] ?? '').toLowerCase()
  if ((verb === 'rm' || verb === 'remove') && parts[1] && ctx.userId) {
    const name = parts[1]
    const dependents = endpointsReferencingKey(ctx.userId, name)
    if (dependents.length > 0) {
      const gate = requireConfirm(parts, {
        preview: t('confirm.key.rm', { name, endpoints: dependents.join(', ') }),
      })
      if (!gate.confirmed) return gate.message
      // Strip --y, then hand the cleaned arg string to the secret runner.
      return runSecretCommand(gate.rest.join(' '), { userId: ctx.userId })
    }
  }
  return runSecretCommand(rest, { userId: ctx.userId })
}

/** The user's BYO endpoint aliases whose `apiKeyRef` points at `name`. */
function endpointsReferencingKey(userId: string, name: string): string[] {
  const override = loadUserConfigOverride(userId)
  return Object.entries(override.endpoints ?? {})
    .filter(([, ep]) => ep.apiKeyRef === name)
    .map(([alias]) => alias)
}

/**
 * `data` noun stub. Real import/export is PR7-owned; B1 only stabilizes the
 * grammar. Bare prints usage; `export` returns a coming-soon notice; `import`
 * is --y-gated (it would overwrite memory/data) even while it stays a stub, so
 * the grammar/UX is correct now.
 */
function runDataNoun(rest: string): string {
  const parts = rest.split(/\s+/).filter(Boolean)
  const verb = (parts[0] ?? '').toLowerCase()
  if (verb === 'import') {
    const src = parts[1] ?? '<src>'
    const gate = requireConfirm(parts, { preview: t('confirm.data.import', { src }) })
    if (!gate.confirmed) return gate.message
    return `${t('system.data.comingSoon')}\n`
  }
  if (verb === 'export') {
    return `${t('system.data.comingSoon')}\n`
  }
  return `${t('system.data.usage')}\n`
}
