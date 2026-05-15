import { loadChannelConfig } from './channels/config.js'
import { listChannels } from './channels/registry.js'
import type { ChannelHandle } from './channels/types.js'
import { drainPendingBackgroundTasks, getBackgroundTaskScheduler } from './background-task/scheduler.js'
import { initializeApp } from './init.js'
import { initializeHooks } from './hooks/index.js'
import { ensureAdminInitialized, resolveTerminalUserId } from './init-wizard.js'
import { cleanupMcp, initializeMcp } from './mcp/index.js'
import { drainPendingDream } from './memory/dream/dream.js'
import { drainPendingExtraction } from './memory/extract.js'
import { setLightclawHomeOverride } from './paths.js'
import {
  acquireProcessLock,
  LightClawAlreadyRunningError,
} from './process-lock.js'
import { startRepl } from './repl.js'
import { runWithSessionContext } from './session-context.js'
import { getRuntimePool } from './state.js'

type CliArgs = {
  help: boolean
  home?: string
  error?: string
}

let shuttingDown = false

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return
  }
  shuttingDown = true
  process.stderr.write(`[lightclaw] received ${signal}, draining background work...\n`)
  await drainPendingExtraction(60_000).catch(error => {
    process.stderr.write(`memory extraction drain failed: ${String(error)}\n`)
  })
  await drainPendingDream(60_000).catch(error => {
    process.stderr.write(`auto-dream drain failed: ${String(error)}\n`)
  })
  await drainPendingBackgroundTasks(60_000).catch(error => {
    process.stderr.write(`background task drain failed: ${String(error)}\n`)
  })
  await getBackgroundTaskScheduler().stop().catch(error => {
    process.stderr.write(`background scheduler stop failed: ${String(error)}\n`)
  })
  // Release cluster runtimes (rlaunch workers, docker containers) before
  // exit. init.ts's parallel cleanup also calls releaseAll, but its hard
  // cap can fire before the brainctl/docker stop calls return — having
  // cli.ts await it here is the deterministic path.
  await getRuntimePool().releaseAll().catch(error => {
    process.stderr.write(`runtime pool release failed: ${String(error)}\n`)
  })
  process.exit(0)
}

process.on('SIGINT', () => {
  void gracefulShutdown('SIGINT')
})
process.on('SIGTERM', () => {
  void gracefulShutdown('SIGTERM')
})

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { help: false }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      args.help = true
      continue
    }

    if (arg === '--home') {
      const value = argv[index + 1]
      if (!value) {
        return { ...args, error: '--home requires a value' }
      }
      args.home = value
      index += 1
      continue
    }

    return {
      ...args,
      error: arg.startsWith('-') ? `unknown flag: ${arg}` : `unknown argument: ${arg}`,
    }
  }

  return args
}

function printHelp(): void {
  console.log(`LightClaw v0.1.0

Usage:
  lightclaw
  lightclaw --home <dir>

Starts the LightClaw daemon: the enabled channels (Feishu) plus a
slash-only terminal admin console. The agent is reached through the
channels — the terminal no longer runs an interactive agent session.

Options:
  -h, --help      Show help
      --home      Override LightClaw home directory (default ~/.lightclaw)

Environment:
  LIGHTCLAW_HOME             Coarse data root (sessions / memory / config / identity / workspaces / state)
  LIGHTCLAW_WORKSPACE_ROOT   Per-user workspace root (overrides <home>/workspaces)
  LIGHTCLAW_NO_MEMORY=1      Disable auto-memory extraction and memory index injection
  LIGHTCLAW_NO_MCP=1         Disable MCP client startup and MCP tool injection
  LIGHTCLAW_NO_HOOKS=1       Disable hook loading
  LIGHTCLAW_RUNTIME_BACKEND=local|docker
  LIGHTCLAW_DOCKER_IMAGE=<image>  Override DockerRuntime image
`)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }
  if (args.error) {
    console.error(args.error)
    console.error('Run `lightclaw --help` for usage.')
    process.exitCode = 1
    return
  }

  // Apply --home before any code path resolves a LightClaw-rooted path
  // (process lock, identity store, channels). lightclawHome() is lazy, so
  // setting the override here is sufficient.
  if (args.home) {
    setLightclawHomeOverride(args.home)
  }

  // Mutual exclusion: refuse to start if another LightClaw is already
  // running. Multiple instances would race the same dedup file, sessions
  // dir, identity store, and (for channels) the same Feishu ws
  // subscription, all of which assume a single owner.
  acquireProcessLock()

  await ensureAdminInitialized({ interactive: true })
  const currentUserId = await resolveTerminalUserId()

  // Order matters: initializeApp must run BEFORE startEnabledChannels so the
  // channel runner doesn't try to bootstrap the app itself (without a
  // currentUserId, which would acquire a ghost "__terminal__" runtime).
  // The terminal is a slash-only admin console with no transcript, so it
  // takes a fixed, readable session id and no resumed session state.
  const { config, sessionContext } = await initializeApp({
    sessionId: 'terminal-console',
    currentUserId,
    channel: 'terminal',
  })
  await runWithSessionContext(sessionContext, async () => {
    await initializeHooks(config)
    await initializeMcp(config)
    const channelHandles = await startEnabledChannels()
    try {
      await startRepl({ config })
    } finally {
      // Ctrl-D exits the admin console and unwinds here. (Ctrl-C / SIGTERM
      // go through gracefulShutdown / installSignalHandlers instead, which
      // own their own runtime release + process.exit.) This is the daemon's
      // clean-exit path: drain background work, stop the scheduler and
      // channels, then tear down MCP servers and the runtime pool — the
      // last two used to live in repl.ts before it became a plain console.
      await drainPendingExtraction(60_000)
      await drainPendingDream(60_000)
      await drainPendingBackgroundTasks(60_000)
      await getBackgroundTaskScheduler().stop()
      for (const handle of channelHandles.reverse()) {
        await handle.stop().catch(error => {
          process.stderr.write(`channel stop failed: ${String(error)}\n`)
        })
      }
      await cleanupMcp().catch(error => {
        process.stderr.write(`mcp cleanup failed: ${String(error)}\n`)
      })
      await getRuntimePool().releaseAll().catch(error => {
        process.stderr.write(`runtime pool release failed: ${String(error)}\n`)
      })
    }
  })
}

async function startEnabledChannels(): Promise<ChannelHandle[]> {
  const config = loadChannelConfig()
  const channels = listChannels(config).filter(channel => {
    if (channel.id === 'feishu') {
      return config.feishu.enabled
    }
    return true
  })

  const handles: ChannelHandle[] = []
  for (const channel of channels) {
    process.stderr.write(`channel ${channel.id}: starting\n`)
    handles.push(await channel.start())
  }
  return handles
}

main().catch(error => {
  if (error instanceof LightClawAlreadyRunningError) {
    console.error(error.message)
  } else {
    console.error(error instanceof Error ? error.message : String(error))
  }
  process.exitCode = 1
})
