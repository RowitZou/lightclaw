import { loadChannelConfig } from './channels/config.js'
import { listChannels } from './channels/registry.js'
import type { ChannelHandle } from './channels/types.js'
import { initializeApp } from './init.js'
import { initializeHooks } from './hooks/index.js'
import { ensureAdminInitialized, resolveTerminalUserId } from './init-wizard.js'
import { initializeMcp } from './mcp/index.js'
import { getProvider } from './provider/index.js'
import { startRepl } from './repl.js'
import { getLatestSessionId } from './session/listing.js'
import { loadMeta } from './session/storage.js'
import { getAllTools, getEnabledTools } from './tools.js'

type CliArgs = {
  help: boolean
  prompt?: string
  resume?: string | true
  error?: string
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { help: false }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      args.help = true
      continue
    }

    if (arg === '--prompt' || arg === '-p') {
      const value = argv[index + 1]
      if (!value) {
        return { ...args, error: '--prompt requires a value' }
      }
      args.prompt = value
      index += 1
      continue
    }

    if (arg === '--resume') {
      const nextArg = argv[index + 1]
      if (nextArg && !nextArg.startsWith('-')) {
        args.resume = nextArg
        index += 1
      } else {
        args.resume = true
      }
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
  lightclaw --prompt "Help me plan today"
  lightclaw --resume
  lightclaw --resume <session-id>

Options:
  -h, --help      Show help
  -p, --prompt    Run a single prompt and exit
      --resume    Resume the latest or a specific saved session

Environment:
  LIGHTCLAW_NO_MEMORY=1  Disable auto-memory extraction and memory index injection
  LIGHTCLAW_NO_MCP=1     Disable MCP client startup and MCP tool injection
  LIGHTCLAW_NO_HOOKS=1   Disable hook loading
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

  await ensureAdminInitialized({ interactive: !args.prompt })
  const currentUserId = await resolveTerminalUserId()

  let resumeSessionId: string | undefined
  let resumeMeta = null
  if (args.resume) {
    resumeSessionId =
      args.resume === true ? await getLatestSessionId(currentUserId) ?? undefined : args.resume
    if (!resumeSessionId) {
      console.error('No previous session found.')
      process.exitCode = 1
      return
    }
    resumeMeta = await loadMeta(resumeSessionId)
  } else if (!args.prompt) {
    resumeSessionId = await getLatestSessionId(currentUserId) ?? undefined
    resumeMeta = resumeSessionId ? await loadMeta(resumeSessionId) : null
  }

  const channelHandles = args.prompt ? [] : await startEnabledChannels()
  try {
    const config = await initializeApp({
      model: resumeMeta?.model,
      sessionId: resumeSessionId,
      resumedFrom: resumeSessionId ?? null,
      compactionCount: resumeMeta?.compactionCount,
      lastExtractedAt: resumeMeta?.lastExtractedAt,
      todos: resumeMeta?.todos,
      permissionMode: resumeMeta?.permissionMode,
      currentUserId: resumeMeta?.userId ?? currentUserId,
    })
    await initializeHooks(config)
    await initializeMcp(config)
    const provider = getProvider(config)
    await startRepl({
      config,
      tools: getEnabledTools(provider, getAllTools()),
      initialPrompt: args.prompt,
      resumeSessionId,
    })
  } finally {
    for (const handle of channelHandles.reverse()) {
      await handle.stop().catch(error => {
        process.stderr.write(`channel stop failed: ${String(error)}\n`)
      })
    }
  }
}

async function startEnabledChannels(): Promise<ChannelHandle[]> {
  const config = loadChannelConfig()
  const channels = listChannels(config).filter(channel => {
    if (channel.id === 'feishu') {
      return config.feishu.enabled
    }
    if (channel.id === 'wechat') {
      return Boolean(config.wechat?.enabled)
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
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
