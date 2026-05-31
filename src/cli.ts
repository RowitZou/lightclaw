import { existsSync } from 'node:fs'
import { stdin as processStdin } from 'node:process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadChannelConfig } from './channels/config.js'
import { resumePendingTurns } from './channels/feishu/resume.js'
import { listChannels } from './channels/registry.js'
import { runTerminalOneShot } from './channels/terminal-run.js'
import type { ChannelHandle } from './channels/types.js'
import { drainPendingBackgroundTasks, getBackgroundTaskScheduler } from './background-task/scheduler.js'
import {
  clampPermissionModeToCeiling,
  isHomeConfigPath,
  readExternalConfigFile,
  resolveStartupHome,
  syncExternalConfig,
} from './config-bootstrap.js'
import { initializeApp, stopNetworkBridgeSafely } from './init.js'
import { initializeHooks } from './hooks/index.js'
import { ensureAdminInitialized, resolveTerminalUserId } from './init-wizard.js'
import { runConfigWizard } from './config-wizard.js'
import { cleanupMcp, initializeMcp } from './mcp/index.js'
import { drainPendingDream, releaseConsolidationLocksOnShutdown } from './memory/dream/dream.js'
import { drainPendingExtraction } from './memory/extract.js'
import type { LightClawConfig } from './config.js'
import { lightclawHome, setLightclawHomeOverride } from './paths.js'
import {
  acquireProcessLock,
  LightClawAlreadyRunningError,
} from './process-lock.js'
import { startRepl } from './repl.js'
import { runWithSessionContext } from './session-context.js'
import { getRuntimePool } from './state.js'
import { VERSION } from './version.js'

type CliCommand =
  | { kind: 'daemon' }
  | { kind: 'run'; promptParts: string[]; stdin: boolean }

type CliArgs = {
  help: boolean
  home?: string
  config?: string
  command: CliCommand
  error?: string
}

let shuttingDown = false
// Captured by `main()` after config bootstrap so the signal-handler shutdown
// path (registered at module load, long before config exists) can reach the
// same memoryRoot the daemon runs against. Stays undefined if a signal fires
// before bootstrap completes, in which case the consolidate-lock release is
// skipped — same outcome as pre-fix behavior.
let configForShutdown: LightClawConfig | undefined

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
  if (configForShutdown) {
    await releaseConsolidationLocksOnShutdown(configForShutdown).catch(error => {
      process.stderr.write(`consolidate-lock release failed: ${String(error)}\n`)
    })
  }
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
  await stopNetworkBridgeSafely().catch(error => {
    process.stderr.write(`network bridge stop failed: ${String(error)}\n`)
  })
  process.exit(0)
}

process.on('SIGINT', () => {
  void gracefulShutdown('SIGINT')
})
process.on('SIGTERM', () => {
  void gracefulShutdown('SIGTERM')
})

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { help: false, command: { kind: 'daemon' } }

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

    if (arg === '--config') {
      const value = argv[index + 1]
      if (!value) {
        return { ...args, error: '--config requires a value' }
      }
      args.config = value
      index += 1
      continue
    }

    if (arg === 'run') {
      return parseRunArgs(argv.slice(index + 1), args)
    }

    return {
      ...args,
      error: arg.startsWith('-') ? `unknown flag: ${arg}` : `unknown argument: ${arg}`,
    }
  }

  return args
}

function parseRunArgs(argv: string[], base: CliArgs): CliArgs {
  const promptParts: string[] = []
  let readStdin = false

  for (const arg of argv) {
    if (arg === '--stdin') {
      readStdin = true
      continue
    }
    if (arg === '--help' || arg === '-h') {
      return { ...base, help: true, command: { kind: 'run', promptParts, stdin: readStdin } }
    }
    if (arg.startsWith('-')) {
      return { ...base, error: `unknown run flag: ${arg}` }
    }
    promptParts.push(arg)
  }

  if (promptParts.length === 0 && !readStdin) {
    return { ...base, error: 'run requires a prompt or --stdin' }
  }

  return { ...base, command: { kind: 'run', promptParts, stdin: readStdin } }
}

function printHelp(): void {
  console.log(`LightClaw v${VERSION}

Usage:
  lightclaw
  lightclaw --home <dir>
  lightclaw --config <file>
  lightclaw run <prompt...>
  lightclaw run --stdin [prompt...]

Starts the LightClaw daemon: the enabled channels (Feishu) plus a
slash-only terminal admin console. Use \`lightclaw run\` for a one-shot
long-task dogfood turn from the terminal.

Options:
  -h, --help      Show help
      --home      Override LightClaw home directory (default ~/.lightclaw)
      --config    Read an external config file and sync it into <home>/config.json

Run command:
  run <prompt...>       Execute one normal LightClaw turn and print replies to stdout
  run --stdin [prompt]  Append stdin to the argv prompt before executing

Environment:
  LIGHTCLAW_HOME             Coarse data root (sessions / memory / config / identity / workspaces / state)
                            External config may also set a "home" field when --home/LIGHTCLAW_HOME are absent.
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

  // Apply startup path decisions before any code path resolves a
  // LightClaw-rooted path (process lock, identity store, channels).
  if (args.config) {
    const external = readExternalConfigFile(args.config)
    const home = resolveStartupHome({ homeFlag: args.home, externalHome: external.home })
    setLightclawHomeOverride(home)
    if (!isHomeConfigPath(args.config)) {
      syncExternalConfig(external, home)
    }
  } else if (args.home) {
    setLightclawHomeOverride(args.home)
  }

  const homeConfigPath = path.join(lightclawHome(), 'config.json')
  if (!args.config && !existsSync(homeConfigPath)) {
    if (!process.stdin.isTTY) {
      throw new Error(
        `No config found at ${homeConfigPath}. Run LightClaw in an interactive terminal to create one, or pass --config <file>.`,
      )
    }
    await runConfigWizard({ homeFlag: args.home })
  }
  clampPermissionModeToCeiling()

  // Mutual exclusion: refuse to start if another LightClaw is already
  // running. Multiple instances would race the same dedup file, sessions
  // dir, identity store, and (for channels) the same Feishu ws
  // subscription, all of which assume a single owner.
  acquireProcessLock()

  await ensureAdminInitialized({ interactive: args.command.kind !== 'run' })
  const currentUserId = await resolveTerminalUserId()

  if (args.command.kind === 'run') {
    const runCommand = args.command
    const { config, sessionContext } = await initializeApp({
      sessionId: 'terminal-run',
      currentUserId,
      channel: 'terminal',
      watchUserDefinedAgents: false,
    })
    configForShutdown = config
    await runWithSessionContext(sessionContext, async () => {
      await initializeHooks(config)
      await initializeMcp(config)
      try {
        const prompt = await resolveRunPrompt(runCommand)
        await runTerminalOneShot(prompt)
      } finally {
        await drainPendingExtraction(60_000)
        await drainPendingDream(60_000)
        await releaseConsolidationLocksOnShutdown(config).catch(error => {
          process.stderr.write(`consolidate-lock release failed: ${String(error)}\n`)
        })
        await drainPendingBackgroundTasks(60_000)
        await getBackgroundTaskScheduler().stop()
        await cleanupMcp().catch(error => {
          process.stderr.write(`mcp cleanup failed: ${String(error)}\n`)
        })
        await getRuntimePool().releaseAll().catch(error => {
          process.stderr.write(`runtime pool release failed: ${String(error)}\n`)
        })
        await stopNetworkBridgeSafely().catch(error => {
          process.stderr.write(`network bridge stop failed: ${String(error)}\n`)
        })
      }
    })
    return
  }

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
  configForShutdown = config
  await runWithSessionContext(sessionContext, async () => {
    await initializeHooks(config)
    await initializeMcp(config)
    const channelHandles = await startEnabledChannels()
    // Resume any turns a previous daemon crash interrupted mid-flight. Fire-
    // and-forget: each resume re-enters the agent loop and can take a while,
    // and the daemon must stay responsive to new inbounds meanwhile.
    void resumePendingTurns().catch(error => {
      process.stderr.write(
        `[crash-resume] scan failed: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      )
    })
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
      await releaseConsolidationLocksOnShutdown(config).catch(error => {
        process.stderr.write(`consolidate-lock release failed: ${String(error)}\n`)
      })
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
      await stopNetworkBridgeSafely().catch(error => {
        process.stderr.write(`network bridge stop failed: ${String(error)}\n`)
      })
    }
  })
}

async function resolveRunPrompt(command: Extract<CliCommand, { kind: 'run' }>): Promise<{
  prompt: string
  source: 'argv' | 'stdin' | 'argv+stdin'
}> {
  const argvPrompt = command.promptParts.join(' ').trim()
  if (!command.stdin) {
    return { prompt: argvPrompt, source: 'argv' }
  }
  const stdinPrompt = await readStdinText()
  const prompt = [argvPrompt, stdinPrompt.trim()].filter(Boolean).join('\n\n')
  return {
    prompt,
    source: argvPrompt ? 'argv+stdin' : 'stdin',
  }
}

function readStdinText(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    processStdin.setEncoding('utf8')
    processStdin.on('data', chunk => {
      data += chunk
    })
    processStdin.on('end', () => resolve(data))
    processStdin.on('error', reject)
    processStdin.resume()
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

export function isCliEntrypoint(metaUrl = import.meta.url, argvPath = process.argv[1]): boolean {
  if (!argvPath) return false
  return path.resolve(argvPath) === fileURLToPath(metaUrl)
}

if (isCliEntrypoint()) {
  main().catch(error => {
    if (error instanceof LightClawAlreadyRunningError) {
      console.error(error.message)
    } else {
      console.error(error instanceof Error ? error.message : String(error))
    }
    process.exitCode = 1
  })
}
