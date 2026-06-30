// Self-update: `/admin version update` pulls the deployment checkout up to its upstream,
// rebuilds, verifies the new bundle, then asks the supervisor to relaunch.
//
// Design (see info/env.md "Self-update / supervisor"):
//   - Build BEFORE exit. git pull + pnpm build + a `--help` smoke-check all run
//     while the OLD daemon is still serving. Any failure aborts WITHOUT
//     restarting, so a broken build never takes the daemon down — the running
//     process keeps its in-memory code until a verified build is in place.
//   - Restart is an exit, not an in-process re-exec: we drop a restart-sentinel,
//     trigger gracefulShutdown with UPDATE_RESTART_EXIT_CODE, and the external
//     supervisor (run.sh / systemd) relaunches `node dist/cli.js`
//     onto the freshly-built dist. On next boot announceRestartIfPending() reads
//     the sentinel and DMs the admin a "now running <newBuild>" confirmation —
//     closing the loop the admin can't otherwise see (the bot just goes quiet
//     across the restart).
//   - No hot-reload: Feishu ws subscriptions, in-memory ALS state, and runtime
//     worker pools cannot transfer across processes, so a full restart is the
//     honest unit. Durability (TaskRun ledger resume, bg-task reschedule,
//     session transcripts) makes that restart cheap.

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { getAdminFeishuOpenId, getFeishuOpenIdForUser } from './identity/store.js'
import { t } from './i18n/index.js'
import { lightclawHome } from './paths.js'
import { triggerUpdateRestart } from './restart-coordinator.js'
import { getFeishuSender } from './channels/feishu/sender-registry.js'
import { buildSystemNoticeCard, type SystemNoticeKind } from './channels/feishu/system-notice.js'
import { runProcess } from './runtime/process.js'
import { getBuildId, repoRoot, VERSION } from './version.js'

// git ops are quick; pnpm install/build can be slow on a cold node_modules or a
// large dep change — OpenClaw budgets 30min for the same step, mirror it.
const GIT_TIMEOUT_MS = 60_000
const BUILD_TIMEOUT_MS = 30 * 60_000
const STEP_MAX_BUFFER_BYTES = 8 * 1024 * 1024
// Let the slash reply (and its card) flush to Feishu before we tear the process
// down. The admin sees "rebuilt, restarting…"; the restart-sentinel then DMs the
// confirmation on next boot.
const RESTART_FLUSH_DELAY_MS = 2_500
// Keep failure tails bounded so a long build log doesn't blow the chat card.
const ERROR_TAIL_CHARS = 1_500

function sentinelPath(): string {
  return path.join(lightclawHome(), 'restart-sentinel.json')
}

export type RestartSentinel = {
  requestedAt: string
  fromVersion: string
  fromBuildId: string
  toBuildId: string
  byUser?: string
}

export function writeRestartSentinel(sentinel: RestartSentinel): void {
  writeFileSync(sentinelPath(), `${JSON.stringify(sentinel, null, 2)}\n`, { mode: 0o600 })
}

/** Read the sentinel and delete it in one shot (it is single-use: consumed by
 *  the boot that follows the restart it recorded). Returns null when absent or
 *  unreadable — a corrupt sentinel must not block startup. */
export function readAndClearRestartSentinel(): RestartSentinel | null {
  const file = sentinelPath()
  if (!existsSync(file)) {
    return null
  }
  let parsed: RestartSentinel | null = null
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as RestartSentinel
  } catch {
    parsed = null
  }
  try {
    unlinkSync(file)
  } catch {
    // already gone — fine
  }
  return parsed
}

// ── git state classification (pure, unit-tested) ─────────────────────────────

export type GitState =
  | { kind: 'up-to-date'; sha: string }
  | { kind: 'dirty' }
  | { kind: 'diverged'; behind: number; ahead: number }
  | { kind: 'updatable'; fromSha: string; toSha: string; behind: number }

/** Decide what `/admin version update` should do from the observed git facts. Refuses a
 *  dirty tree (a pull would clobber local edits) and a diverged branch (local
 *  commits the upstream lacks — not a fast-forward; admin must resolve by hand).
 *  Only a clean, strictly-behind branch is updatable. */
export function classifyGitState(input: {
  dirty: boolean
  behind: number
  ahead: number
  headSha: string
  upstreamSha: string
}): GitState {
  if (input.dirty) {
    return { kind: 'dirty' }
  }
  if (input.behind === 0) {
    // Nothing upstream to pull (a purely-ahead local branch is still "up to
    // date" w.r.t. what an update could fetch).
    return { kind: 'up-to-date', sha: input.headSha }
  }
  if (input.ahead > 0) {
    return { kind: 'diverged', behind: input.behind, ahead: input.ahead }
  }
  return { kind: 'updatable', fromSha: input.headSha, toSha: input.upstreamSha, behind: input.behind }
}

// ── subprocess helpers ───────────────────────────────────────────────────────

// git / pnpm inherit process.env on purpose: the deployment shell exports
// http_proxy (bashrc), and git fetch / pnpm install need it to reach the
// network. This is the shell-tool proxy plane, distinct from the daemon's
// internal-HTTP plane that ignores ambient proxy env (CLAUDE.md rule 4).
async function git(args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  const result = await runProcess('git', ['-C', repoRoot, ...args], {
    env: process.env,
    timeoutMs: GIT_TIMEOUT_MS,
    maxBufferBytes: STEP_MAX_BUFFER_BYTES,
    limitMessage: 'git output truncated',
  })
  return { ok: result.exitCode === 0, out: result.stdout.trim(), err: result.stderr.trim() }
}

async function buildStep(
  command: string,
  args: string[],
): Promise<{ ok: boolean; out: string; err: string }> {
  const result = await runProcess(command, args, {
    cwd: repoRoot,
    env: process.env,
    timeoutMs: BUILD_TIMEOUT_MS,
    maxBufferBytes: STEP_MAX_BUFFER_BYTES,
    limitMessage: 'build output truncated',
  })
  return { ok: result.exitCode === 0, out: result.stdout.trim(), err: result.stderr.trim() }
}

function tail(text: string): string {
  return text.length > ERROR_TAIL_CHARS ? `…${text.slice(-ERROR_TAIL_CHARS)}` : text
}

/** Observe the current checkout's state relative to its tracking upstream.
 *  Returns null + an error string when git itself fails (no upstream set, not a
 *  repo, fetch unreachable). */
async function collectGitState(): Promise<{ state: GitState } | { error: string }> {
  const fetched = await git(['fetch', '--quiet'])
  if (!fetched.ok) {
    return { error: t('admin.update.gitFailed', { detail: tail(fetched.err || 'git fetch failed') }) }
  }
  const head = await git(['rev-parse', '--short=12', 'HEAD'])
  const upstream = await git(['rev-parse', '--short=12', '@{u}'])
  if (!head.ok || !upstream.ok) {
    return {
      error: t('admin.update.gitFailed', {
        detail: tail(upstream.err || head.err || 'no tracking upstream for HEAD'),
      }),
    }
  }
  const status = await git(['status', '--porcelain'])
  if (!status.ok) {
    return { error: t('admin.update.gitFailed', { detail: tail(status.err || 'git status failed') }) }
  }
  const behind = await git(['rev-list', '--count', 'HEAD..@{u}'])
  const ahead = await git(['rev-list', '--count', '@{u}..HEAD'])
  if (!behind.ok || !ahead.ok) {
    return { error: t('admin.update.gitFailed', { detail: tail(behind.err || ahead.err || 'rev-list failed') }) }
  }
  const state = classifyGitState({
    dirty: status.out.length > 0,
    behind: Number.parseInt(behind.out, 10) || 0,
    ahead: Number.parseInt(ahead.out, 10) || 0,
    headSha: head.out,
    upstreamSha: upstream.out,
  })
  return { state }
}

// ── the command ──────────────────────────────────────────────────────────────

export type RunUpdateOptions = {
  /** Preview the version delta without pulling / building / restarting. */
  dryRun?: boolean
  /** Canonical user id of the admin who invoked it (recorded in the sentinel). */
  byUser?: string
}

/** Outcome of `/admin version update`: the localized notice text plus the severity that
 *  colors its system-notice card — `error` (red) for failures, `warning`
 *  (orange) for refusals the admin must resolve, `info` (blue) for success /
 *  preview / already-current. */
export type UpdateResult = { text: string; severity: SystemNoticeKind }

/** Execute the `update` verb of `/admin version`. On the success path it ALSO
 *  schedules the restart (after a short flush delay); the returned text is the
 *  "rebuilt, restarting…" notice. */
export async function runUpdate(options: RunUpdateOptions = {}): Promise<UpdateResult> {
  const probe = await collectGitState()
  if ('error' in probe) {
    return { text: `${probe.error}\n`, severity: 'error' }
  }
  const { state } = probe

  if (state.kind === 'dirty') {
    return { text: `${t('admin.update.dirty')}\n`, severity: 'warning' }
  }
  if (state.kind === 'up-to-date') {
    return { text: `${t('admin.update.upToDate', { sha: state.sha })}\n`, severity: 'info' }
  }
  if (state.kind === 'diverged') {
    return {
      text: `${t('admin.update.diverged', { ahead: state.ahead, behind: state.behind })}\n`,
      severity: 'warning',
    }
  }

  // updatable
  if (options.dryRun) {
    return {
      text: `${t('admin.update.dryRun', { from: state.fromSha, to: state.toSha, behind: state.behind })}\n`,
      severity: 'info',
    }
  }

  // Fast-forward to the fetched upstream (no second network round-trip).
  const merged = await git(['merge', '--ff-only', '@{u}'])
  if (!merged.ok) {
    return {
      text: `${t('admin.update.gitFailed', { detail: tail(merged.err || 'fast-forward merge failed') })}\n`,
      severity: 'error',
    }
  }

  // Install to match the (possibly updated) lockfile, then build. A failure here
  // leaves the running daemon on its old in-memory code; we do NOT restart.
  const installed = await buildStep('pnpm', ['install', '--frozen-lockfile'])
  if (!installed.ok) {
    return {
      text: `${t('admin.update.installFailed', { detail: tail(installed.err || installed.out) })}\n`,
      severity: 'error',
    }
  }
  const built = await buildStep('pnpm', ['build'])
  if (!built.ok) {
    return {
      text: `${t('admin.update.buildFailed', { detail: tail(built.err || built.out) })}\n`,
      severity: 'error',
    }
  }
  // Smoke-check the freshly built bundle before betting the restart on it.
  const verified = await buildStep('node', ['dist/cli.js', '--help'])
  if (!verified.ok) {
    return {
      text: `${t('admin.update.verifyFailed', { detail: tail(verified.err || verified.out) })}\n`,
      severity: 'error',
    }
  }

  const toBuildId = (await git(['rev-parse', '--short=12', 'HEAD'])).out || state.toSha
  writeRestartSentinel({
    requestedAt: new Date().toISOString(),
    fromVersion: VERSION,
    fromBuildId: getBuildId(),
    toBuildId,
    byUser: options.byUser,
  })

  // Schedule the restart so this reply (and its card) reaches Feishu first. If
  // no supervisor handler is installed (shouldn't happen in a running daemon),
  // the sentinel still records the intent and the admin sees the notice.
  setTimeout(() => {
    triggerUpdateRestart()
  }, RESTART_FLUSH_DELAY_MS).unref?.()

  return {
    text: `${t('admin.update.restarting', { from: getBuildId(), to: toBuildId })}\n`,
    severity: 'info',
  }
}

/** Called once at startup (after channels are up) with the sentinel consumed
 *  earlier in boot (cli.ts reads it BEFORE channels start so the WS transport's
 *  stale-event floor can be set from it — see restart-window.ts). If the
 *  previous shutdown was a `/admin version update` restart, DM the admin a confirmation
 *  that the daemon came back on the new build. Best-effort: a missing sender /
 *  admin binding / send failure is swallowed (the restart already happened; the
 *  notice is a courtesy). */
export async function announceRestart(sentinel: RestartSentinel | null): Promise<void> {
  if (!sentinel) {
    return
  }
  const sender = getFeishuSender()
  if (!sender) {
    return
  }
  // Route the confirmation to the admin who ran `/admin version update` — not a
  // broadcast to every admin. `byUser` is the invoker's canonical id; fall back
  // to the primary admin only for legacy sentinels that predate the field.
  const openId =
    (sentinel.byUser ? await getFeishuOpenIdForUser(sentinel.byUser).catch(() => null) : null) ??
    (await getAdminFeishuOpenId().catch(() => null))
  if (!openId) {
    return
  }
  const card = buildSystemNoticeCard({
    kind: 'info',
    content: t('admin.update.restartDone', {
      version: VERSION,
      from: sentinel.fromBuildId,
      to: getBuildId(),
    }),
  })
  await sender.sendInteractiveCardToOpenId(openId, card).catch(() => {
    // restart already landed; the confirmation DM is a courtesy, not load-bearing
  })
}
