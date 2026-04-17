import { initializeApp } from './init.js'
import { startRepl } from './repl.js'
import { getLatestSessionId } from './session/listing.js'
import { loadMeta } from './session/storage.js'
import { allTools } from './tools.js'

type CliArgs = {
  help: boolean
  model?: string
  prompt?: string
  resume?: string | true
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    help: false,
  }
  const positionals: string[] = []

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      args.help = true
      continue
    }

    if (arg === '--model') {
      args.model = argv[index + 1]
      index += 1
      continue
    }

    if (arg === '--prompt' || arg === '-p') {
      args.prompt = argv[index + 1]
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

    positionals.push(arg)
  }

  if (!args.prompt && positionals.length > 0) {
    args.prompt = positionals.join(' ')
  }

  return args
}

function printHelp(): void {
  console.log(`LightClaw v0.1.0

Usage:
  lightclaw
  lightclaw --prompt "Explain this project"
  lightclaw --model claude-sonnet-4-20250514
  lightclaw --resume
  lightclaw --resume <session-id>

Options:
  -h, --help       Show help
  -p, --prompt     Run a single prompt and exit
      --model      Override configured model
      --resume     Resume the latest or a specific saved session
`)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }

  let resumeSessionId: string | undefined
  let resumeMeta = null
  if (args.resume) {
    resumeSessionId =
      args.resume === true ? await getLatestSessionId() ?? undefined : args.resume

    if (!resumeSessionId) {
      console.error('No previous session found.')
      process.exitCode = 1
      return
    }

    resumeMeta = await loadMeta(resumeSessionId)
  }

  const config = initializeApp({
    cwd: resumeMeta?.cwd,
    model: args.model ?? resumeMeta?.model,
    sessionId: resumeSessionId,
    resumedFrom: resumeSessionId ?? null,
    compactionCount: resumeMeta?.compactionCount,
  })
  await startRepl({
    config,
    tools: allTools,
    initialPrompt: args.prompt,
    resumeSessionId,
  })
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})