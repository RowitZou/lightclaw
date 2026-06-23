import chalk from 'chalk'

import {
  getConfig,
  isSelectableModelFor,
  selectableModelNames,
  type LightClawConfig,
} from '../config.js'
import {
  addLink,
  createUser,
  getAdmin,
  getIdentity,
  getUserPermissionCeiling,
  isAdmin,
  isValidIdentityName,
  listIdentities,
  lookupBySender,
  parseSenderKey,
  rebuildReverseIndex,
  removeLink,
  removeUser,
  setUserDataRoot,
  setUserPermissionCeiling,
} from '../identity/store.js'
import { validateUserDataRootPath } from '../identity/data-root.js'
import {
  approveDataRootRequest,
  listDataRootRequests,
  rejectDataRootRequest,
} from '../identity/data-root-requests.js'
import { approveCode, listPending, rejectCode } from '../identity/pairing.js'
import { deriveCanonicalName } from '../identity/derive-canonical.js'
import { preheatAndWelcomeOnApproval } from '../identity/post-approve.js'
import { setIdentityPreference } from '../identity/preferences.js'
import { setUserConfigOverrideField, updateUserConfigOverride } from '../config/user-override.js'
import { normalizeProxyUrl } from '../config/proxy-url.js'
import type { SenderKey } from '../identity/types.js'
import { formatRule, parseRule } from '../permission/rules.js'
import {
  appendIdentityRules,
  clearIdentityRules,
  loadIdentityRules,
  removeIdentityRule,
} from '../permission/storage.js'
import { isModeWithinCeiling, type PermissionMode, type PermissionRule } from '../permission/types.js'
import { DockerRuntime, RlaunchRuntime } from '../runtime/index.js'
import { brainppDockerImageProbe } from '../runtime/image-readiness.js'
import { resolveDockerImage } from '../runtime/pool.js'
import { clearAllForModel } from '../provider/capability-cache.js'
import { clearPrechargeForModel, clearProviderCacheForEndpoint } from '../provider/index.js'
import {
  abortInFlightForSession,
  getCurrentUserId,
  getIdentityRules,
  getImageReadiness,
  getModel,
  getPermissionMode,
  getRuntime,
  getRuntimePool,
  getUsageTotals,
  setIdentityRules,
  setModel,
  setPermissionMode,
} from '../state.js'

import { runAuthCommand } from './auth.js'
import { runUserAuthCommand } from './user-auth.js'
import { runUserConfigCommand } from './user-config.js'
import { appendFeedback, readAllFeedback } from './feedback-store.js'
import { runFeishuWorkspaceCommand } from './feishu-workspace.js'
import { runEndpointCommand } from './endpoint.js'
import { runModelCustomCommand } from './model-custom.js'
import { runMountCommand } from './mount.js'
import { restartCurrentRlaunchRuntime } from './rlaunch-restart.js'
import { runSecretCommand } from './secret.js'
import { runSkillCommand } from './skill.js'
import { getFeishuVisualSetupCoordinator } from '../channels/feishu/visual-setup-card.js'
import { formatFeishuErrorForLog } from '../channels/feishu/resources/errors.js'
import {
  MODE_ALIASES,
  modeToAlias,
  parseMode,
} from './mode-aliases.js'
import { t } from '../i18n/index.js'
import { getSignalRouter, type ChainTreeNode, type ChainView } from '../signal-bus/router.js'
import type { ReplCommand, ReplContext } from './registry.js'
import { ReplCommandRegistry } from './registry.js'
import { readUsage, type UsageRecord } from '../usage/storage.js'
import { stopActiveTaskRunsForSession } from '../taskrun/stop.js'

export function createBuiltinReplRegistry(
  opts?: { includeChannelOnly?: boolean },
): ReplCommandRegistry {
  // includeChannelOnly defaults to true so the channel dispatcher and any
  // other caller keep the full command set; the terminal admin console
  // passes false to drop the agent-loop commands (only /stop today).
  const includeChannelOnly = opts?.includeChannelOnly ?? true
  const registry = new ReplCommandRegistry()
  // Built inside the function so command descriptions / usage strings pick
  // up the current locale (init.ts setLang runs before any dispatch).
  for (const command of buildBuiltinCommands()) {
    if (command.channelOnly && !includeChannelOnly) {
      continue
    }
    registry.register(command)
  }
  return registry
}

export const RENAMED_COMMANDS: Record<string, string> = {
  '/identity': '/user',
  '/permissions': '/rules',
}

function buildBuiltinCommands(): ReplCommand[] {
  return [
  {
    name: '/ui',
    usage: '/ui [model]',
    description: 'Open the Feishu visual configuration console',
    channelOnly: true,
    agentAdvisory:
      'When the user wants a visual UI for configuring endpoints, models, auth, or user settings.',
    agentUsage: [
      '/ui          Open the visual LightClaw configuration console in Feishu',
      '/ui model    Open the endpoint + model setup wizard directly',
    ].join('\n'),
    async handler(args, ctx) {
      const userId = ctx.userId ?? getCurrentUserId()
      if (!userId) {
        ctx.output.write(`${t('common.error.prefix')}${t('common.error.noActiveIdentity')}\n`)
        return
      }
      const coord = getFeishuVisualSetupCoordinator()
      if (!coord) {
        ctx.output.write('Visual UI is only available when the Feishu channel is running.\n')
        return
      }
      const action = args.trim().toLowerCase()
      try {
        if (action === 'model' || action === 'setup') {
          await coord.openModelSetup({ sessionId: ctx.sessionId, userId })
          ctx.output.write('已打开模型配置向导。\n')
          return
        }
        await coord.openHome({ sessionId: ctx.sessionId, userId })
        ctx.output.write('已打开 LightClaw 控制台。\n')
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        process.stderr.write(`visual-ui: open failed: ${formatFeishuErrorForLog(error, 'visual.setup.open')}\n`)
        ctx.output.write(`打开 LightClaw 控制台失败：${detail}\n`)
      }
    },
  },
  {
    name: '/help',
    usage: '/help [command]',
    description: t('cmd.help.desc'),
    async handler(args, ctx) {
      ctx.output.write(await formatHelp(args, ctx))
    },
  },
  {
    name: '/status',
    usage: '/status',
    description: t('cmd.status.desc'),
    async handler(_args, ctx) {
      ctx.output.write(await formatStatus(ctx))
    },
  },
  {
    name: '/stop',
    usage: '/stop',
    description: t('cmd.stop.desc'),
    channelOnly: true,
    async handler(_args, ctx) {
      // Phase 32: /stop aborts the in-flight turn for THIS session only.
      // ctx.sessionId is the terminal session id in REPL and the Feishu
      // Phase 26 sessionId for channel slash dispatch — both map directly
      // to the controller `beginQuery()` registered.
      const userId = ctx.userId ?? getCurrentUserId()
      const ledgerStop = userId
        ? await stopActiveTaskRunsForSession(userId, ctx.sessionId)
        : { waitingRunIds: [], abortedSessionIds: [] }
      const aborted = abortInFlightForSession(ctx.sessionId) ||
        ledgerStop.waitingRunIds.length > 0 ||
        ledgerStop.abortedSessionIds.length > 0
      const hasLedgerTally = ledgerStop.abortedSessionIds.length > 0 || ledgerStop.waitingRunIds.length > 0
      ctx.output.write(
        `${aborted
          ? (hasLedgerTally
              ? t('stop.abortedWithLedger', {
                  inFlight: String(ledgerStop.abortedSessionIds.length),
                  waiting: String(ledgerStop.waitingRunIds.length),
                })
              : t('stop.aborted'))
          : t('stop.nothing')}\n`,
      )
    },
  },
  {
    name: '/feedback',
    usage: t('cmd.feedback.usage'),
    description: t('cmd.feedback.desc'),
    visibleTo: 'user',
    agentAdvisory:
      'When the user wants to leave standing feedback for the admin (bug report / ' +
      'feature request / preference) that should outlive this conversation.',
    agentUsage: [
      '/feedback <text>   Record standing feedback for the admin. <text> is taken verbatim to end of line.',
    ].join('\n'),
    async handler(args, ctx) {
      const text = args.trim()
      if (!text) {
        ctx.output.write(`${t('common.error.prefix')}${t('feedback.usage')}\n`)
        return
      }
      const userId = ctx.userId ?? getCurrentUserId() ?? '__terminal__'
      try {
        await appendFeedback({
          ts: new Date().toISOString(),
          user: userId,
          channel: ctx.isChannel ? 'channel' : 'terminal',
          text,
        })
        ctx.output.write(`${t('feedback.thanks')}\n`)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        ctx.output.write(`${t('common.error.prefix')}${t('feedback.fail', { detail })}\n`)
      }
    },
  },
  {
    name: '/secret',
    usage: t('cmd.secret.usage'),
    description: t('cmd.secret.desc'),
    channelOnly: true,
    agentAdvisory:
      'When the user\'s task needs an API token, password, or credential ' +
      'you do not already have access to (GitHub push, HuggingFace download, ' +
      'third-party API calls). After they set a secret, some tools consume the ' +
      'stored value directly; use /secret enable only when you need to reference ' +
      'it as `$NAME` in Bash commands. BrainppCluster reads ' +
      'BRAINPP_ACCESS_KEY / BRAINPP_SECRET_KEY directly after /secret set.',
    agentUsage: [
      '/secret list                  List stored secrets with mask + enabled flag',
      '/secret status [NAME]         Inspect one secret, or all if NAME omitted',
      '/secret set <NAME> <VALUE>    Store a secret. NAME must match ^[A-Z][A-Z0-9_]{0,63}$.',
      '                                VALUE is taken verbatim to end of line (may contain spaces, $, quotes).',
      '/secret enable <NAME>         Activate injection of $NAME in Bash from next turn',
      '                                Not needed for BrainppCluster BRAINPP_ACCESS_KEY / BRAINPP_SECRET_KEY.',
      '/secret disable <NAME>        Deactivate without removing the value',
      '/secret remove <NAME>         Delete the stored entry',
    ].join('\n'),
    async handler(args, ctx) {
      ctx.output.write(await runSecretCommand(args, ctx))
    },
  },
  {
    name: '/cost',
    usage: '/cost',
    description: t('cmd.cost.desc'),
    visibleTo: 'admin',
    agentAdvisory:
      'When the user wants to inspect this month\'s token usage / cost, broken down by model and by paired user.',
    agentUsage: [
      '/cost                               Show this month\'s token usage, broken down by model and by paired user',
    ].join('\n'),
    async handler(_args, ctx) {
      ctx.output.write(await formatCost())
    },
  },
  {
    name: '/model',
    usage: t('cmd.model.usage'),
    description: t('cmd.model.desc'),
    agentAdvisory:
      'When the user explicitly asks to switch model or compare model behavior.',
    agentUsage: [
      '/model                 Show the current model and list every selectable model alias.',
      '/model <name>          Switch to a model alias (use a name from the bare-/model list).',
      '/model --clear-cache   Clear the current model\'s capability-probe cache (combine with <name> to clear that one).',
      '/model proxy           Show the current model endpoint proxy.',
      '/model proxy <proxy-url|-> Set or clear the current model endpoint proxy.',
      '/model proxy <name> <proxy-url|-> Set or clear the proxy for a named model endpoint.',
      '/model custom list     List user-owned custom models.',
      '/model custom templates Show OpenAI / Anthropic / Codex / self-hosted examples.',
      '/model custom param-help Show provider-specific request parameter examples.',
      '/model custom add ...  Add a user-owned custom model using an existing /endpoint.',
      '/model custom check <name> Check whether a custom model is reachable.',
    ].join('\n'),
    async handler(args, ctx) {
      const rawParts = args.trim().split(/\s+/).filter(Boolean)
      if (rawParts[0]?.toLowerCase() === 'custom') {
        ctx.output.write(await runModelCustomCommand(rawParts.slice(1).join(' '), ctx))
        return
      }
      if (rawParts[0]?.toLowerCase() === 'proxy') {
        ctx.output.write(runModelProxyCommand(rawParts.slice(1), ctx))
        return
      }
      const clearCache = rawParts.includes('--clear-cache')
      const modelParts = rawParts.filter(part => part !== '--clear-cache')
      const model = modelParts.join(' ')
      const registered = selectableModelNames(ctx.config, false)
      const formatList = (): string =>
        registered.length === 0
          ? '(none; configure a custom model with /endpoint and /model custom add)'
          : registered
          .map(name => {
            const entry = ctx.config.models[name]
            return `${name} (${entry.schema}, ${entry.endpoint} -> ${entry.upstreamModel})`
          })
          .join(', ')
      if (clearCache && modelParts.length === 0) {
        const current = getModel()
        const entry = ctx.config.models[current]
        if (!entry) {
          ctx.output.write(`${t('common.error.prefix')}${t('model.clearCache.notRegistered', { name: current })}\n`)
          return
        }
        const baseUrl = ctx.config.endpoints[entry.endpoint]?.baseUrl
        const removed = clearAllForModel({
          endpoint: entry.endpoint,
          baseUrl,
          upstreamModel: entry.upstreamModel,
        })
        clearPrechargeForModel({
          endpoint: entry.endpoint,
          baseUrl,
          upstreamModel: entry.upstreamModel,
        })
        ctx.output.write(
          `${t('model.clearCache.cleared', {
            name: current,
            endpoint: entry.endpoint,
            upstream: entry.upstreamModel,
            suffix: removed ? '' : t('model.clearCache.noEntry'),
          })}\n`,
        )
        return
      }
      if (!model) {
        const current = getModel()
        const currentEntry = ctx.config.models[current]
        const currentName = isSelectableModelFor(currentEntry, false) ? current : '(none)'
        ctx.output.write(`${t('model.current', { name: currentName })}\n`)
        ctx.output.write(`${t('model.available', { list: formatList() })}\n`)
        return
      }
      if (!isSelectableModelFor(ctx.config.models[model], false)) {
        ctx.output.write(`${t('common.error.prefix')}${t('model.unknown', { name: model })}\n`)
        ctx.output.write(`${t('model.available', { list: formatList() })}\n`)
        return
      }
      setModel(model)
      ctx.config.defaultModel = model
      if (clearCache) {
        const entry = ctx.config.models[model]
        const baseUrl = ctx.config.endpoints[entry.endpoint]?.baseUrl
        clearAllForModel({
          endpoint: entry.endpoint,
          baseUrl,
          upstreamModel: entry.upstreamModel,
        })
        clearPrechargeForModel({
          endpoint: entry.endpoint,
          baseUrl,
          upstreamModel: entry.upstreamModel,
        })
      }
      const callerId = getCurrentUserId()
      if (callerId) {
        setUserConfigOverrideField({ canonicalUser: callerId, key: 'defaultModel', value: model })
        setIdentityPreference({ canonicalUser: callerId, key: 'model', value: undefined })
      }
      ctx.output.write(`${t('model.set', { name: model })}${clearCache ? t('model.clearCache.alsoCleared') : ''}\n`)
      await ctx.persistMeta(ctx.messages.length)
    },
  },
  {
    name: '/endpoint',
    usage: '/endpoint <list|templates|add-key|add-codex|set|remove>',
    description: 'Manage user-owned custom model endpoints',
    agentAdvisory:
      'When the user needs to add or modify their own API endpoint / Codex auth endpoint before adding a custom model.',
    agentUsage: [
      '/endpoint list',
      '/endpoint templates',
      '/endpoint add-key <endpoint> <apiKeyRef> [--base-url <url>] [--proxy <url>]',
      '/endpoint add-codex <endpoint> [codex:<name>] [--base-url <url>] [--proxy <url>]',
      '/endpoint set <endpoint> [--base-url <url|->] [--proxy <url|->] [--api-key-ref <name>|--auth-ref codex:<name>]',
      '/endpoint remove <endpoint>',
    ].join('\n'),
    async handler(args, ctx) {
      ctx.output.write(await runEndpointCommand(args, ctx))
    },
  },
  {
    name: '/config',
    usage: t('cmd.config.usage'),
    description: t('cmd.config.desc'),
    agentAdvisory:
      'When the user wants to inspect or reset their per-user LightClaw config, ' +
      'or request a dataRoot change.',
    agentUsage: [
      '/config show',
      '/config reset [all|defaultModel|lang|permissionMode|endpoints|models|endpoint:<name>|model:<name>]',
      '/config set-home <absolute-daemon-visible-path>',
    ].join('\n'),
    async handler(args, ctx) {
      ctx.output.write(await runUserConfigCommand(args, ctx))
    },
  },
  {
    name: '/mode',
    usage: t('cmd.mode.usage'),
    description: t('cmd.mode.desc'),
    agentAdvisory:
      'When the user wants to change permission posture (default / autoEdit / planMode / yolo).',
    agentUsage: [
      '/mode                        Show the mode menu, the current mode, and the user\'s ceiling.',
      '/mode <read|ask|auto|yolo>   Set permission posture. read=read-only; ask=confirm writes/exec (default); auto=writes+web silent, commands still ask; yolo=all silent except ask/deny rules. Capped by the user\'s ceiling.',
    ].join('\n'),
    async handler(args, ctx) {
      const trimmed = args.trim()
      const userId = getCurrentUserId()
      const ceiling = userId ? await getUserPermissionCeiling(userId) : defaultPermissionCeiling()
      if (!trimmed) {
        const current = getPermissionMode()
        const lines: string[] = [t('mode.menuTitle')]
        for (const alias of MODE_ALIASES) {
          const isCurrent = alias === modeToAlias(current)
          const within = isModeWithinCeiling(parseMode(alias)!, ceiling)
          const marker = isCurrent
            ? t('mode.currentMarker')
            : (within ? '' : t('mode.aboveCeilingMarker'))
          lines.push(`  ${alias.padEnd(5)} ${t(`mode.${alias}.desc` as 'mode.read.desc')}${marker}`)
        }
        lines.push('', t('mode.ceilingLine', { ceiling: modeToAlias(ceiling) }), '')
        ctx.output.write(lines.join('\n'))
        return
      }
      const mode = parseMode(trimmed)
      if (!mode) {
        ctx.output.write(`${t('common.error.prefix')}${t('mode.unknown', { input: trimmed, aliases: MODE_ALIASES.join(' / ') })}\n`)
        return
      }
      if (!isModeWithinCeiling(mode, ceiling)) {
        ctx.output.write(`${t('common.error.prefix')}${t('mode.exceedCeiling', { mode: modeToAlias(mode), ceiling: modeToAlias(ceiling) })}\n`)
        return
      }
      setPermissionMode(mode)
      if (userId) {
        ctx.config.permissionMode = mode
        setUserConfigOverrideField({ canonicalUser: userId, key: 'permissionMode', value: mode })
        setIdentityPreference({ canonicalUser: userId, key: 'permissionMode', value: undefined })
      }
      const alias = modeToAlias(mode)
      const recap = t(`mode.${alias}.recap` as 'mode.read.recap')
      ctx.output.write(`${t('mode.set', { mode: alias })}\n${recap}\n`)
      await ctx.persistMeta(ctx.messages.length)
    },
  },
  {
    name: '/ceiling',
    usage: t('cmd.ceiling.usage'),
    description: t('cmd.ceiling.desc'),
    visibleTo: 'admin',
    agentAdvisory:
      'When the user wants to view or set a paired user\'s permission-mode ceiling — ' +
      'the most permissive mode (read / ask / auto / yolo) that user is allowed to run in. ' +
      'This caps permissions; it is not about spend or token usage (that is /cost).',
    agentUsage: [
      '/ceiling                              Show current permission-mode ceilings per user',
      '/ceiling <user> <read|ask|auto|yolo>  Set the permission-mode ceiling for a user',
    ].join('\n'),
    async handler(args, ctx) {
      const parts = args.trim().split(/\s+/).filter(Boolean)
      if (parts.length === 0) {
        ctx.output.write(await formatCeilingList())
        return
      }
      if (parts.length !== 2) {
        ctx.output.write(`${t('common.error.prefix')}${t('ceiling.usage')}\n`)
        return
      }
      const [name, modeText] = parts
      const mode = parseMode(modeText!)
      if (!mode) {
        ctx.output.write(`${t('common.error.prefix')}${t('ceiling.invalidMode', { input: modeText!, aliases: MODE_ALIASES.join(' / ') })}\n`)
        return
      }
      const result = await setUserPermissionCeiling(name!, mode)
      if (!result.ok) {
        ctx.output.write(`${t('common.error.prefix')}${t('ceiling.noSuchUser', { name: name! })}\n`)
        return
      }
      ctx.output.write(`${t('ceiling.set', { name: name!, mode: modeToAlias(mode) })}\n`)
    },
  },
  {
    name: '/user',
    usage: t('cmd.user.usage'),
    description: t('cmd.user.desc'),
    visibleTo: 'admin',
    agentAdvisory:
      'When the user wants to list paired channel users, inspect pairing state, ' +
      'or unpair someone.',
    agentUsage: [
      '/user list                          List all paired users (canonical id + channel handle)',
      '/user pending                       Show pending pairing requests',
      '/user approve <code> [--as <name>]  Approve a pending pairing request',
      '/user reject <code>                 Reject a pending pairing request',
      '/user unlink <channel:id>           Unlink one channel identity from its canonical user',
      '/user remove <name> [--purge]       Remove a canonical user; --purge also deletes user data',
      '/user set-home <name> <path>        Set a per-user dataRoot',
      '/user clear-home <name>             Clear the per-user dataRoot',
      '/user home-requests                 Show pending user dataRoot requests',
      '/user approve-home <name>           Approve a pending dataRoot request',
      '/user reject-home <name>            Reject a pending dataRoot request',
      '/user feedback [--page N]           Show standing user feedback for the admin',
    ].join('\n'),
    async handler(args, ctx) {
      ctx.output.write(await runUserCommand(args, ctx))
    },
  },
  {
    name: '/sandbox',
    usage: t('cmd.sandbox.usage'),
    description: t('cmd.sandbox.desc'),
    // Admin-only: status leaks deployment internals (image / container /
    // worker names); prefetch triggers a multi-GB image pull that should
    // not be a free button for end users; reset rebuilds a per-user
    // worker / container which is admin maintenance, not a user knob.
    // Sandbox is meant to be invisible to users — environment health
    // surfaces to admin via channel notices, not via slash commands.
    visibleTo: 'admin',
    agentAdvisory:
      'When the user wants to reset, inspect, or rebuild the sandbox runtime ' +
      '(container respawn / scratch wipe).',
    agentUsage: [
      '/sandbox status                    Show runtime backend, container/worker state, mount table',
      '/sandbox prefetch                  Start Docker image prefetch / readiness probe',
      '/sandbox reset                     Wipe and respawn the runtime (drops scratch, keeps workspace)',
    ].join('\n'),
    async handler(args, ctx) {
      const action = args.trim() || 'status'
      if (action === 'status') {
        const runtime = getRuntime()
        const lines: string[] = []
        if (runtime instanceof RlaunchRuntime) {
          // Rlaunch backend has its own readiness tracker (per-user worker
          // scheduling on the cluster). The docker-flavored ImageReadiness
          // tracker doesn't apply — the cluster pulls images server-side,
          // we never run `docker pull` locally. Reading ImageReadiness here
          // would always show `not-attempted` since nothing populates it.
          //
          // The tracker is only updated when isAvailable() / waitForRunning()
          // / runBrainctlExec() actually probes phase. preheat-on-startup
          // calls start() which leaves the tracker on `scheduling` until the
          // first real tool call lifts it to `ready`. Calling isAvailable()
          // here forces a phase probe so admin sees the live state instead
          // of a stale `scheduling` even when the cluster worker is healthy.
          // Caught + ignored: isAvailable() returns reason objects rather
          // than throwing, but a brainctl/network blip could still throw.
          await runtime.isAvailable().catch(() => {})
          const snap = runtime.workerSnapshot()
          lines.push(t('sandbox.titleRlaunch'))
          lines.push(t('sandbox.state', { state: snap.state }))
          if (snap.image) lines.push(t('sandbox.image', { image: snap.image }))
          if (snap.scheduleDurationMs !== undefined) {
            lines.push(t('sandbox.scheduleElapsed', { seconds: Math.round(snap.scheduleDurationMs / 1000) }))
          }
          if (snap.lastError) lines.push(t('sandbox.lastError', { error: snap.lastError }))
          lines.push(t('sandbox.workerUser', { name: snap.canonicalUser }))
          lines.push(t('sandbox.worker', { name: runtime.name ?? t('sandbox.workerNone') }))
        } else if (runtime instanceof DockerRuntime) {
          const snap = getImageReadiness().snapshot()
          lines.push(t('sandbox.title'))
          lines.push(t('sandbox.state', { state: snap.state }))
          if (snap.image) lines.push(t('sandbox.image', { image: snap.image }))
          if (snap.pullDurationMs !== undefined) {
            const seconds = Math.round(snap.pullDurationMs / 1000)
            lines.push(snap.state === 'ready'
              ? t('sandbox.pulledIn', { seconds })
              : t('sandbox.elapsed', { seconds }))
          }
          if (snap.lastError) lines.push(t('sandbox.lastError', { error: snap.lastError }))
          lines.push(t('sandbox.container', { name: runtime.containerName }))
        } else {
          // LocalRuntime: admin-only single-user mode, no worker / container
          // tracking applies — the readiness machinery is purely for the
          // isolated-backend code path (docker / rlaunch).
          lines.push(t('sandbox.titleLocal'))
          lines.push(t('sandbox.localActive'))
        }
        lines.push('')
        ctx.output.write(lines.join('\n'))
        return
      }
      if (action === 'prefetch') {
        const tracker = getImageReadiness()
        if (ctx.config.runtime.backend !== 'docker') {
          ctx.output.write(`${t('sandbox.prefetch.requireDocker')}\n`)
          return
        }
        const image = resolveDockerImage(ctx.config)
        tracker.retryIfFailed()
        if (tracker.state === 'ready') {
          ctx.output.write(`${t('sandbox.prefetch.alreadyReady', { image })}\n`)
          return
        }
        if (tracker.state === 'pulling') {
          ctx.output.write(`${t('sandbox.prefetch.inProgress', { image })}\n`)
          return
        }
        tracker.startPrefetch(image, {
          inspectOnly: !ctx.config.runtime.dockerSettings.autoPull,
          ...(ctx.config.runtime.driver === 'brainpp'
            ? { probe: brainppDockerImageProbe() }
            : {}),
        })
        ctx.output.write(`${t('sandbox.prefetch.started', { image })}\n`)
        return
      }
      if (action !== 'reset') {
        ctx.output.write(`${t('common.error.prefix')}${t('sandbox.usage')}\n`)
        return
      }
      const userId = getCurrentUserId()
      if (!userId) {
        ctx.output.write(`${t('common.error.prefix')}${t('common.error.noActiveIdentity')}\n`)
        return
      }
      const runtime = getRuntime()
      if (!(runtime instanceof DockerRuntime)) {
        if (runtime instanceof RlaunchRuntime) {
          await getRuntimePool().remove(userId)
          ctx.output.write(`${t('sandbox.reset.rlaunchDone')}\n`)
          return
        }
        ctx.output.write(`${t('sandbox.reset.localNothing')}\n`)
        return
      }
      const containerName = runtime.containerName
      const image = runtime.image || resolveDockerImage(ctx.config)
      await getRuntimePool().remove(userId)
      ctx.output.write(`${t('sandbox.reset.dockerDone', { container: containerName, image })}\n`)
    },
  },
  {
    name: '/feishu-workspace',
    usage: t('cmd.feishuWorkspace.usage'),
    description: t('cmd.feishuWorkspace.desc'),
    visibleTo: 'admin',
    agentAdvisory:
      'When the user wants to manage the Feishu cloud workspace root or ' +
      'per-user document folders.',
    agentUsage: [
      '/feishu-workspace status                    Show root folder + per-user folder tokens',
      '/feishu-workspace list                      List per-user folders with sizes',
      '/feishu-workspace orphans                   List folders for unpaired canonical users',
      '/feishu-workspace delete <canonical>        Delete an unpaired user folder',
    ].join('\n'),
    async handler(args, ctx) {
      ctx.output.write(await runFeishuWorkspaceCommand(args))
    },
  },
  {
    name: '/mount',
    usage: t('cmd.mount.usage'),
    description: t('cmd.mount.desc'),
    channelOnly: true,
    agentAdvisory:
      'When the user references a host path outside the current workspace mount, ' +
      'or a gpfs path that the agent cannot see — they need to mount it before ' +
      'you can Read / Edit / Bash inside.',
    agentUsage: [
      '/mount list                          Show currently mounted paths',
      '/mount add <absolute-gpfs-path...> [--ro|--rw]',
      '                                     Mount host gpfs path into sandbox at the same path. Default mode is --ro.',
      '/mount remove <absolute-gpfs-path...>',
      '                                     Unmount; sandbox restart applied next turn.',
    ].join('\n'),
    async handler(args, ctx) {
      ctx.output.write(await runMountCommand(args, ctx, {
        restartRlaunch: () => restartCurrentRlaunchRuntime(ctx),
      }))
    },
  },
  {
    name: '/rules',
    usage: t('cmd.rules.usage'),
    description: t('cmd.rules.desc'),
    agentAdvisory:
      'When the user wants to pre-approve or deny a recurring permission prompt ' +
      '(e.g. always allow `Bash(git:*)`).',
    agentUsage: [
      '/rules list                                Show currently active permission rules',
      '/rules revoke <n>                          Remove a rule by number from /rules list',
      '/rules revoke all                          Remove all current user permission rules',
      '/rules ask <rule>                          Force a matching action to ask again',
    ].join('\n'),
    async handler(args, ctx) {
      const trimmed = args.trim()
      const [head, ...rest] = trimmed.split(/\s+/)
      const sub = head || 'list'
      const userId = getCurrentUserId()
      if (sub === 'list') {
        ctx.output.write(formatRulesList())
        return
      }
      if (sub === 'revoke') {
        if (!userId) {
          ctx.output.write(`${t('common.error.prefix')}${t('common.error.noActiveIdentity')}\n`)
          return
        }
        const target = rest[0]
        if (!target) {
          ctx.output.write(`${t('common.error.prefix')}${t('rules.revokeUsage')}\n`)
          return
        }
        if (target === 'all') {
          const before = getIdentityRules().length
          clearIdentityRules(userId)
          setIdentityRules([])
          ctx.output.write(
            before === 0
              ? `${t('rules.revokedAllEmpty')}\n`
              : `${t('rules.revokedAll', { count: before })}\n`,
          )
          return
        }
        const n = Number.parseInt(target, 10)
        const sorted = sortRulesForDisplay(getIdentityRules())
        if (!Number.isInteger(n) || n < 1 || n > sorted.length) {
          ctx.output.write(`${t('common.error.prefix')}${t('rules.revokeNoSuch', { n: target })}\n`)
          return
        }
        const victim = sorted[n - 1]!
        removeIdentityRule({ canonicalUser: userId, rule: victim })
        setIdentityRules(loadIdentityRules(userId))
        ctx.output.write(
          `${t('rules.revokedOne', { behavior: victim.behavior, rule: formatRule(victim.value) })}\n\n${formatRulesList()}`,
        )
        return
      }
      if (sub === 'ask') {
        const ruleText = rest.join(' ').trim()
        if (!ruleText) {
          ctx.output.write(`${t('common.error.prefix')}${t('rules.askUsage')}\n`)
          return
        }
        if (!userId) {
          ctx.output.write(`${t('common.error.prefix')}${t('common.error.noActiveIdentity')}\n`)
          return
        }
        let value
        try {
          value = parseRule(ruleText)
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          ctx.output.write(`${t('common.error.prefix')}${detail}\n`)
          return
        }
        const rule: PermissionRule = { source: 'identity', behavior: 'ask', value }
        appendIdentityRules({ canonicalUser: userId, rules: [rule] })
        setIdentityRules(loadIdentityRules(userId))
        ctx.output.write(`${t('rules.askRegistered', { rule: formatRule(value) })}\n`)
        return
      }
      ctx.output.write(`${t('common.error.prefix')}${t('rules.usage')}\n`)
    },
  },
  {
    name: '/auth',
    usage: t('cmd.auth.usage'),
    description: t('cmd.auth.desc'),
    agentAdvisory:
      'When the daemon needs provider credentials set up or refreshed ' +
      '(anthropic / openai / openai-auth / codex), or the user wants to manage their own Codex authRef.',
    agentUsage: [
      '/auth codex list                    List current user Codex authRefs',
      '/auth codex import --from <path>    Import current user Codex auth from daemon-readable auth.json',
      '/auth codex status [name]           Show current user Codex auth status without tokens',
      '/auth codex refresh [name]          Refresh current user Codex auth',
      '/auth codex logout [name]           Remove current user Codex auth',
      '/auth list                         Show current credential state per provider',
      '/auth import codex                 Import Codex OAuth credentials from ~/.codex/auth.json',
      '/auth logout codex [--purge]       Remove stored Codex token; --purge also removes auto-registered config',
    ].join('\n'),
    async handler(args, ctx) {
      const trimmed = args.trim()
      if (trimmed.startsWith('codex') || !ctx.isAdmin) {
        ctx.output.write(await runUserAuthCommand(trimmed, ctx.userId ?? getCurrentUserId()))
        return
      }
      ctx.output.write(await runAuthCommand(args, ctx.config))
    },
  },
  {
    name: '/skill',
    usage: t('cmd.skill.usage'),
    description: t('cmd.skill.desc'),
    agentAdvisory:
      'When the user wants to inspect their installed skills or delete one of their own user skills.',
    agentUsage: [
      '/skill list',
      '/skill view <name>',
      '/skill delete <name>',
    ].join('\n'),
    async handler(args, ctx) {
      ctx.output.write(await runSkillCommand(args, {
        userId: ctx.userId ?? getCurrentUserId(),
        cwd: ctx.config.paths?.workspace ?? process.cwd(),
      }))
    },
  },
  ]
}

const BEHAVIOR_RANK: Record<PermissionRule['behavior'], number> = {
  deny: 0,
  ask: 1,
  allow: 2,
}

function sortRulesForDisplay(rules: readonly PermissionRule[]): PermissionRule[] {
  return [...rules].sort((a, b) => {
    if (a.behavior !== b.behavior) {
      return BEHAVIOR_RANK[a.behavior] - BEHAVIOR_RANK[b.behavior]
    }
    return formatRule(a.value).localeCompare(formatRule(b.value))
  })
}

function formatRulesList(): string {
  const sorted = sortRulesForDisplay(getIdentityRules())
  if (sorted.length === 0) {
    return `${t('rules.empty')}\n`
  }
  const indexWidth = String(sorted.length).length
  const lines = [t('rules.listTitle')]
  for (const [i, rule] of sorted.entries()) {
    const idx = String(i + 1).padStart(indexWidth, ' ')
    lines.push(`  [${idx}] ${rule.behavior.padEnd(5, ' ')} ${formatRule(rule.value)}`)
  }
  lines.push(t('rules.listFooter'))
  return lines.join('\n')
}

async function formatCeilingList(): Promise<string> {
  const identities = await listIdentities()
  const names = Object.keys(identities).sort()
  if (names.length === 0) {
    return `${t('ceiling.empty')}\n`
  }
  const lines = [t('ceiling.listTitle')]
  const defaultCeiling = defaultPermissionCeiling()
  for (const name of names) {
    const ceiling = identities[name]!.permissionCeiling ?? defaultCeiling
    const marker = (await isAdmin(name)) ? t('status.identitiesAdmin') : ''
    lines.push(`  ${name}${marker} -> ${modeToAlias(ceiling)}`)
  }
  lines.push(t('ceiling.listFooter'))
  return lines.join('\n')
}

async function formatHelp(args: string, ctx: ReplContext): Promise<string> {
  // The terminal console hides the agent-loop commands, so /help must too.
  const registry = createBuiltinReplRegistry({ includeChannelOnly: ctx.isChannel })
  const visibleCommands = registry.list(Boolean(ctx.isAdmin))
  const requested = normalizeHelpCommandName(args)
  if (requested) {
    return color(ctx, formatCommandHelp(requested, registry, ctx))
  }
  const userCmds = visibleCommands.filter(c => (c.visibleTo ?? 'all') !== 'admin')
  const adminCmds = visibleCommands.filter(c => c.visibleTo === 'admin')
  // Layout differs by surface. The Feishu channel shows command NAMES and
  // descriptions and points at /help <command> for exact syntax; the terminal
  // admin console keeps each command's full `usage` inline because it is a
  // slash-only surface. Channel uses a `name: description` colon layout
  // (feishu IM wraps long lines, destroying column alignment); the terminal
  // keeps a padEnd-aligned table since fixed-width fonts make it readable.
  const formatRow = ctx.isChannel
    ? (c: ReplCommand) => `  ${c.name}: ${c.description}`
    : ((): ((c: ReplCommand) => string) => {
        const usageWidth = Math.max(...visibleCommands.map(c => c.usage.length), 10)
        return c => `  ${c.usage.padEnd(usageWidth, ' ')}  ${c.description}`
      })()
  const lines: string[] = [
    t('help.title'),
    '',
    ...userCmds.map(formatRow),
  ]
  if (ctx.isAdmin && adminCmds.length > 0) {
    lines.push('', t('help.adminTitle'), '')
    for (const c of adminCmds) {
      lines.push(formatRow(c))
    }
  }
  lines.push('')
  if (ctx.isChannel) {
    lines.push(t('help.usageHint'))
  }
  lines.push(t('help.statusHint'), '')
  return color(ctx, lines.join('\n'))
}

function normalizeHelpCommandName(args: string): string | undefined {
  const first = args.trim().split(/\s+/).filter(Boolean)[0]
  if (!first) return undefined
  return first.startsWith('/') ? first : `/${first}`
}

function formatCommandHelp(
  name: string,
  registry: ReplCommandRegistry,
  ctx: ReplContext,
): string {
  const command = registry.find(name)
  const visible = command ? isCommandVisibleToContext(command, ctx) : false
  if (!command || !visible) {
    return `${t('common.error.prefix')}${t('help.unknownCommand', { name })}\n`
  }
  const visibility = command.visibleTo ?? 'all'
  const detail = command.agentUsage?.trim() || command.usage
  const lines = [
    t('help.detailTitle', { name: command.name }),
    '',
    command.description,
    t('help.detailVisibility', { visibility: t(`help.visibility.${visibility}` as 'help.visibility.all') }),
    '',
    t('help.detailUsage'),
    `  ${command.usage}`,
  ]
  if (detail && detail !== command.usage) {
    lines.push('', t('help.detailSubcommands'))
    for (const line of detail.split('\n')) {
      lines.push(line.trim() ? `  ${line}` : '')
    }
  }
  lines.push('')
  return lines.join('\n')
}

function isCommandVisibleToContext(command: ReplCommand, ctx: ReplContext): boolean {
  const visibility = command.visibleTo ?? 'all'
  if (visibility === 'admin') return Boolean(ctx.isAdmin)
  if (visibility === 'user') return !ctx.isAdmin
  return true
}

function runModelProxyCommand(parts: string[], ctx: ReplContext): string {
  const usage = [
    'Usage:',
    '  /model proxy',
    '  /model proxy <model>',
    '  /model proxy <proxy-url|->',
    '  /model proxy <model> <proxy-url|->',
    '',
  ].join('\n')
  if (parts.length > 2) return usage

  const currentModel = getModel() || ctx.config.defaultModel
  let modelName = currentModel
  let nextProxy: string | undefined
  if (parts.length === 1) {
    const only = parts[0]!
    if (ctx.config.models[only] && !looksLikeProxyValue(only)) {
      modelName = only
    } else {
      nextProxy = only
    }
  } else if (parts.length === 2) {
    modelName = parts[0]!
    nextProxy = parts[1]!
  }

  const entry = ctx.config.models[modelName]
  if (!isSelectableModelFor(entry, false)) {
    return `${t('common.error.prefix')}${t('model.unknown', { name: modelName || '(none)' })}\n`
  }
  const endpointName = entry.endpoint
  const endpoint = ctx.config.endpoints[endpointName]
  if (!endpoint) {
    return `${t('common.error.prefix')}model "${modelName}" references missing endpoint "${endpointName}".\n`
  }
  if (nextProxy === undefined) {
    const proxy = endpoint.proxy ? '(set)' : '(none)'
    return [
      'Model proxy:',
      `  model=${modelName}`,
      `  endpoint=${endpointName}`,
      `  proxy=${proxy}`,
      '',
      usage,
    ].join('\n')
  }

  const userId = ctx.userId ?? getCurrentUserId()
  if (!userId) {
    return `${t('common.error.prefix')}${t('common.error.noActiveIdentity')}\n`
  }

  let normalizedProxy: string | undefined
  try {
    normalizedProxy = nextProxy === '-' ? undefined : normalizeProxyUrl(nextProxy)
    updateUserConfigOverride(userId, current => {
      const currentEndpoint = current.endpoints?.[endpointName]
      if (!currentEndpoint) {
        throw new Error(`endpoint "${endpointName}" is not in the current user config; use /endpoint set ${endpointName} --proxy <url> instead`)
      }
      const endpoints = { ...(current.endpoints ?? {}) }
      const nextEndpoint = { ...currentEndpoint }
      if (nextProxy === '-') delete nextEndpoint.proxy
      else nextEndpoint.proxy = normalizedProxy
      endpoints[endpointName] = nextEndpoint
      return { ...current, endpoints }
    })
  } catch (error) {
    return `${t('common.error.prefix')}${error instanceof Error ? error.message : String(error)}\n`
  }

  if (nextProxy === '-') delete endpoint.proxy
  else endpoint.proxy = normalizedProxy
  clearProviderCacheForEndpoint(endpointName)
  clearPrechargeForModel({
    endpoint: endpointName,
    baseUrl: endpoint.baseUrl,
    upstreamModel: entry.upstreamModel,
  })
  const action = nextProxy === '-' ? 'Cleared' : 'Updated'
  const proxy = nextProxy === '-' ? '(none)' : '(set)'
  return `${action} proxy for model "${modelName}" endpoint "${endpointName}": ${proxy}. Run /model custom check ${modelName} if needed.\n`
}

function looksLikeProxyValue(value: string): boolean {
  return value === '-' || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
}

async function formatStatus(ctx: ReplContext): Promise<string> {
  const userId = getCurrentUserId()
  const ceiling = userId ? await getUserPermissionCeiling(userId) : defaultPermissionCeiling()
  const adminFlag = userId && (await isAdmin(userId)) ? t('status.adminFlag') : ''
  const channelLabel = ctx.isChannel ? 'channel' : 'terminal'
  const totals = getUsageTotals()
  const sessionTok = totals.inputTokens + totals.outputTokens
  const lines: string[] = [
    t('status.you', { user: userId ?? '(none)', adminFlag, channel: channelLabel }),
    t('status.modeLine', { mode: modeToAlias(getPermissionMode()), ceiling: modeToAlias(ceiling) }),
    t('status.modelLine', { model: getModel() }),
    t('status.sessionLine', { id: ctx.sessionId, msgs: ctx.messages.length, tok: sessionTok }),
  ]
  if (ctx.isAdmin) {
    const identities = await listIdentities()
    const names = Object.keys(identities).sort()
    if (names.length > 1) {
      lines.push('', t('status.identitiesTitle'))
      const defaultCeiling = defaultPermissionCeiling()
      for (const name of names) {
        const m = (await isAdmin(name)) ? t('status.identitiesAdmin') : ''
        const c = identities[name]!.permissionCeiling ?? defaultCeiling
        lines.push(t('status.identitiesLine', { name, adminFlag: m, ceiling: modeToAlias(c) }))
      }
    }
  }
  // Dispatch chain tree is admin-only — it surfaces internal scheduling
  // structure (role / sessionId / depth / privilege-monotonic / chain ids)
  // that ordinary users have no decision use for. Same admin/user split as
  // the "Identities" block above; admin still sees the full tree.
  if (ctx.isAdmin && userId) {
    lines.push('', ...formatDispatchChainStatus(getSignalRouter().getActiveChainsForUser(userId)))
  }
  lines.push('')
  return color(ctx, lines.join('\n'))
}

function formatDispatchChainStatus(chains: ChainView[]): string[] {
  const lines = [t('status.dispatch.heading')]
  if (chains.length === 0) {
    lines.push(t('status.dispatch.empty'))
    return lines
  }
  for (const chain of chains) {
    lines.push(`Chain ${chain.chainId} (${Math.max(0, Date.now() - chain.root.startedAt)}ms)`)
    lines.push(...formatDispatchChainNodes(chain.tree))
  }
  return lines
}

function formatDispatchChainNodes(nodes: ChainTreeNode[]): string[] {
  const children = new Map<string, ChainTreeNode[]>()
  for (const node of nodes) {
    const parent = node.parentDispatchId ?? ''
    const list = children.get(parent) ?? []
    list.push(node)
    children.set(parent, list)
  }
  for (const list of children.values()) {
    list.sort((a, b) => a.dispatchId.localeCompare(b.dispatchId))
  }
  const lines: string[] = []
  const visit = (node: ChainTreeNode, prefix: string, isLast: boolean) => {
    const branch = node.depth === 0 ? '' : `${prefix}${isLast ? '└─ ' : '├─ '}`
    const key = node.status === 'running'
      ? 'status.dispatch.tree_node_running'
      : 'status.dispatch.tree_node_done'
    lines.push(`${branch}${t(key, {
      depth: node.depth,
      role: node.role,
      sessionId: node.sessionId,
      elapsed: node.elapsed,
    })}`)
    const nextPrefix = node.depth === 0 ? '' : `${prefix}${isLast ? '   ' : '│  '}`
    const childList = children.get(node.dispatchId) ?? []
    childList.forEach((child, index) => visit(child, nextPrefix, index === childList.length - 1))
  }
  const roots = children.get('') ?? []
  roots.forEach((root, index) => visit(root, '', index === roots.length - 1))
  return lines
}

async function runUserCommand(rawArgs: string, ctx: ReplContext): Promise<string> {
  await rebuildReverseIndex()
  const args = rawArgs.trim().split(/\s+/).filter(Boolean)
  const action = args.shift()
  switch (action) {
    case 'list':
      return userList()
    case 'pending':
      return userPending()
    case 'approve':
      return userApprove(args)
    case 'reject':
      return userReject(args)
    case 'unlink':
      return userUnlink(args)
    case 'remove':
      return userRemove(args)
    case 'set-home':
      return userSetHome(args, ctx.config)
    case 'clear-home':
      return userClearHome(args)
    case 'home-requests':
      return userHomeRequests()
    case 'approve-home':
      return userApproveHome(args, ctx.config)
    case 'reject-home':
      return userRejectHome(args)
    case 'feedback':
      return userFeedback(args)
    default: {
      const adminId = await getAdmin()
      const isLocal = getConfig().runtime.backend === 'local'
      const header = isLocal && adminId
        ? t('user.usage.localHeader', { admin: adminId })
        : t('user.usage.header')
      const approve = isLocal && adminId
        ? t('user.usage.approveLocal', { admin: adminId })
        : t('user.usage.approveGeneric')
      return `${header}\n${t('user.usage.lines', { approve })}`
    }
  }
}

async function userFeedback(args: string[]): Promise<string> {
  const pageIdx = args.indexOf('--page')
  const page = pageIdx >= 0 ? Math.max(1, Number.parseInt(args[pageIdx + 1] ?? '1', 10) || 1) : 1
  const pageSize = 20
  const all = await readAllFeedback()
  if (all.length === 0) {
    return `${t('user.feedback.empty')}\n`
  }
  const totalPages = Math.ceil(all.length / pageSize)
  if (page > totalPages) {
    return `${t('common.error.prefix')}${t('user.feedback.pageOutOfRange', { page, total: totalPages })}\n`
  }
  const slice = all.slice((page - 1) * pageSize, page * pageSize)
  const lines = slice.map(r =>
    `  ${r.ts.slice(0, 19)} ${r.user}@${r.channel}: ${truncate(r.text, 80)}`,
  )
  return `${t('user.feedback.title', { page, total: totalPages, count: all.length })}\n${lines.join('\n')}\n`
}

function truncate(text: string, maxLen: number): string {
  const oneline = text.replace(/\s+/g, ' ').trim()
  if (oneline.length <= maxLen) return oneline
  return oneline.slice(0, maxLen - 1) + '…'
}

async function formatCost(): Promise<string> {
  const now = new Date()
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
  const records: UsageRecord[] = []
  for await (const rec of readUsage({ sinceTs: monthStart })) {
    records.push(rec)
  }
  if (records.length === 0) {
    return `${t('cost.empty')}\n`
  }
  const total = records.reduce((acc, r) => acc + r.input + r.output, 0)
  const byModel = new Map<string, number>()
  const byUser = new Map<string, number>()
  let freshTok = 0
  let cacheRead = 0
  let cacheCreate = 0
  for (const r of records) {
    const tok = r.input + r.output
    byModel.set(r.model, (byModel.get(r.model) ?? 0) + tok)
    byUser.set(r.user, (byUser.get(r.user) ?? 0) + tok)
    cacheRead += r.cacheRead
    cacheCreate += r.cacheCreate
    if (r.kind === 'fresh') freshTok += tok
  }
  const fmt = (n: number): string => formatTokens(n)
  const lines: string[] = [
    t('cost.thisMonth', { total: fmt(total), cacheRead: fmt(cacheRead), cacheCreate: fmt(cacheCreate) }),
    '',
    t('cost.byModel'),
    ...[...byModel.entries()].sort((a, b) => b[1] - a[1]).map(([m, n]) => `    ${m}: ${fmt(n)}`),
    '',
    t('cost.byUser'),
    ...[...byUser.entries()].sort((a, b) => b[1] - a[1]).map(([u, n]) => `    ${u}: ${fmt(n)}`),
  ]
  if (freshTok > 0) {
    lines.push('', t('cost.freshSubset', { tok: fmt(freshTok), percent: Math.round(freshTok * 100 / total) }))
  }
  lines.push('')
  return lines.join('\n')
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

/**
 * In LocalRuntime, only the admin canonical user can be bound to a channel
 * sender — any other identity would be rejected at runtime acquire time
 * (see init.ts:LocalRuntimeAdminOnlyError). Reject upfront at approve / link
 * time so the operator gets immediate, actionable feedback instead of
 * approving + linking + then watching the user receive a single-user-mode
 * rejection in Feishu. Admin not yet wizarded → no constraint
 * (wizard path runs before any pairing can happen).
 */
async function rejectNonAdminInLocal(name: string): Promise<string | null> {
  if (getConfig().runtime.backend !== 'local') {
    return null
  }
  const adminId = await getAdmin()
  if (!adminId || name === adminId) {
    return null
  }
  return `${t('user.localOnlyReject', { name, admin: adminId })}\n`
}

async function userList(): Promise<string> {
  const identities = await listIdentities()
  const names = Object.keys(identities).sort()
  if (names.length === 0) {
    return `${t('user.list.empty')}\n`
  }
  const lines: string[] = []
  const defaultCeiling = defaultPermissionCeiling()
  for (const name of names) {
    const record = identities[name]
    const marker = await isAdmin(name) ? t('status.identitiesAdmin') : ''
    lines.push(`${name}${marker} ceiling=${modeToAlias(record.permissionCeiling ?? defaultCeiling)}`)
    if (record.dataRoot) {
      lines.push(`  dataRoot=${record.dataRoot}`)
    }
    for (const channel of ['terminal', 'feishu'] as const) {
      for (const peerId of record.channels[channel]) {
        lines.push(`  - ${channel}:${peerId}`)
      }
    }
  }
  return `${lines.join('\n')}\n`
}

async function userSetHome(args: string[], config: LightClawConfig): Promise<string> {
  const [name, rawPath, ...extra] = args
  if (!name || !rawPath || extra.length > 0) {
    return 'Usage: /user set-home <name> <absolute-daemon-visible-path>\n'
  }
  if (!(await getIdentity(name))) {
    return `${t('user.remove.noSuch', { name })}\n`
  }
  const validation = await validateUserDataRootPath(rawPath, config)
  if (!validation.ok) {
    return `${t('common.error.prefix')}${validation.reason}\n`
  }
  await setUserDataRoot(name, validation.path)
  return [
    `Set ${name} dataRoot=${validation.path}`,
    'Restart the user sandbox (/sandbox reset or rlaunch worker restart) before relying on the new mount table.',
    '',
  ].join('\n')
}

async function userClearHome(args: string[]): Promise<string> {
  const [name, ...extra] = args
  if (!name || extra.length > 0) {
    return 'Usage: /user clear-home <name>\n'
  }
  const result = await setUserDataRoot(name, undefined)
  if (!result.ok) {
    return `${t('user.remove.noSuch', { name })}\n`
  }
  return [
    `Cleared ${name} dataRoot; defaulting back to users/<canonical>.`,
    'Restart the user sandbox (/sandbox reset or rlaunch worker restart) before relying on the new mount table.',
    '',
  ].join('\n')
}

async function userHomeRequests(): Promise<string> {
  const requests = await listDataRootRequests()
  if (requests.length === 0) {
    return 'No pending dataRoot requests.\n'
  }
  return `${[
    'Pending dataRoot requests:',
    ...requests.map(request =>
      `  ${request.canonicalUser}: ${request.normalizedPath} updated=${request.updatedAt}`,
    ),
    '',
  ].join('\n')}`
}

async function userApproveHome(args: string[], config: LightClawConfig): Promise<string> {
  const [name, ...extra] = args
  if (!name || extra.length > 0) {
    return 'Usage: /user approve-home <name>\n'
  }
  const result = await approveDataRootRequest({ canonicalUser: name, config })
  if (!result.ok) {
    return `${t('common.error.prefix')}${result.reason}\n`
  }
  return [
    `Approved ${name} dataRoot=${result.request.normalizedPath}`,
    'Restart the user sandbox (/sandbox reset or rlaunch worker restart) before relying on the new mount table.',
    '',
  ].join('\n')
}

async function userRejectHome(args: string[]): Promise<string> {
  const [name, ...extra] = args
  if (!name || extra.length > 0) {
    return 'Usage: /user reject-home <name>\n'
  }
  const removed = await rejectDataRootRequest(name)
  return removed
    ? `Rejected pending dataRoot request for ${name}.\n`
    : `No pending dataRoot request for ${name}.\n`
}

async function userPending(): Promise<string> {
  const pending = await listPending()
  if (pending.length === 0) {
    return `${t('user.pending.empty')}\n`
  }
  const lines = [t('user.pending.header')]
  for (const item of pending) {
    lines.push([
      item.code.padEnd(8, ' '),
      item.channel.padEnd(8, ' '),
      item.peerId.slice(0, 40).padEnd(40, ' '),
      (item.displayName || '-').slice(0, 16).padEnd(16, ' '),
      formatAge(item.createdAt),
    ].join(' '))
  }
  return `${lines.join('\n')}\n`
}

type ParsedApproveArgs =
  | { ok: true; code: string; asName: string | undefined }
  | { ok: false }

function parseApproveArgs(args: string[]): ParsedApproveArgs {
  // Accepted forms:
  //   /user approve <code>
  //   /user approve <code> --as <name>
  // --as overrides the auto-derived canonical name; useful for binding an IM
  // sender into an existing identity (typically the admin) instead of always
  // creating a fresh `<base>_<userId>` user.
  if (args.length === 0) {
    return { ok: false }
  }
  const code = args[0]
  if (!code) {
    return { ok: false }
  }
  if (args.length === 1) {
    return { ok: true, code, asName: undefined }
  }
  if (args.length === 3 && args[1] === '--as' && args[2]) {
    return { ok: true, code, asName: args[2] }
  }
  return { ok: false }
}

export async function userApprove(args: string[]): Promise<string> {
  const parsed = parseApproveArgs(args)
  if (!parsed.ok) {
    return `${t('user.approve.usage')}\n`
  }
  const { code, asName } = parsed
  // Validate --as name BEFORE consuming the pending code, so a typo doesn't
  // burn the pairing entry.
  if (asName !== undefined && !isValidIdentityName(asName)) {
    return `${t('user.approve.invalidName', { name: asName })}\n`
  }
  const entry = await approveCode(code)
  if (!entry) {
    return `${t('user.approve.noSuchCode', { code })}\n`
  }
  const link = `${entry.channel}:${entry.peerId}` as SenderKey
  const name = asName ?? deriveCanonicalName({
    name: entry.displayName,
    email: entry.email,
    openId: entry.peerId,
    userId: entry.userId,
  })
  const reject = await rejectNonAdminInLocal(name)
  if (reject) {
    return reject
  }
  const boundTo = lookupBySender(link)
  if (boundTo && boundTo !== name) {
    return `${t('user.approve.alreadyBound', { link, name: boundTo })}\n`
  }
  const created = await createUser(name)
  if (!created.ok && created.reason !== 'exists') {
    return `${t('user.approve.invalidName', { name })}\n`
  }
  const linked = await addLink(name, link)
  if (!linked.ok) {
    return linked.reason === 'already-bound'
      ? `${t('user.approve.alreadyBound', { link, name: linked.boundTo ?? '?' })}\n`
      : `${t('user.remove.noSuch', { name })}\n`
  }
  preheatAndWelcomeOnApproval(name, link, {
    applicantText: entry.lastApplicantText,
    applicantChatId: entry.lastApplicantChatId,
    applicantChatType: entry.lastApplicantChatType,
    applicantThreadId: entry.lastApplicantThreadId,
    applicantMessageId: entry.lastApplicantMessageId,
  })
  const created_or_updated = created.ok ? t('user.approve.created', { name }) : t('user.approve.updated', { name })
  return `${created_or_updated}\n${t('user.approve.linked', { link, name })}\n`
}

async function userReject(args: string[]): Promise<string> {
  const code = args[0]
  if (!code) {
    return `${t('user.reject.usage')}\n`
  }
  const result = await rejectCode(code)
  return result.ok
    ? `${t('user.reject.done', { code })}\n`
    : `${t('user.reject.noSuchCode', { code })}\n`
}

async function userUnlink(args: string[]): Promise<string> {
  const [rawLink] = args
  if (!rawLink) {
    return `${t('user.unlink.usage')}\n`
  }
  try {
    parseSenderKey(rawLink)
  } catch (error) {
    return `${error instanceof Error ? error.message : String(error)}\n`
  }
  const boundTo = lookupBySender(rawLink as SenderKey)
  if (!boundTo) {
    return `${t('user.unlink.notBound', { link: rawLink })}\n`
  }
  const result = await removeLink(boundTo, rawLink as SenderKey)
  return result.ok
    ? `${t('user.unlink.done', { link: rawLink, name: boundTo })}\n`
    : `${t('user.unlink.notLinked', { link: rawLink })}\n`
}

async function userRemove(args: string[]): Promise<string> {
  const name = args[0]
  if (!name) {
    return `${t('user.remove.usage')}\n`
  }
  if ((await getAdmin()) === name) {
    return `${t('user.remove.refuseAdmin')}\n`
  }
  const result = await removeUser(name, { purge: args.includes('--purge') })
  if (!result.ok) {
    return `${t('user.remove.noSuch', { name })}\n`
  }
  const cleanup = await getRuntimePool().purgeUser(name, getConfig())
  let response = `${t('user.remove.done', { name })}\n`
  if (cleanup.rlaunchWorker) {
    response += `${t('user.remove.cleanupRlaunch', { worker: cleanup.rlaunchWorker })}\n`
  }
  if (cleanup.dockerContainer) {
    response += `${t('user.remove.cleanupDocker', { container: cleanup.dockerContainer })}\n`
  }
  return response
}

function firstLine(text: string): string {
  return text.split('\n').map(line => line.trim()).find(Boolean) ?? text
}

function color(ctx: ReplContext, text: string): string {
  return ctx.isChannel ? text : chalk.gray(text)
}

function defaultPermissionCeiling(): PermissionMode {
  return getConfig().permissionCeiling
}

function formatAge(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000))
  if (seconds < 60) {
    return `${seconds}s ago`
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return `${minutes}m ago`
  }
  return `${Math.floor(minutes / 60)}h ago`
}
