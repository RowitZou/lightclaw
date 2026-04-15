import { initializeApp } from './init.js'
import { startRepl } from './repl.js'
import { allTools } from './tools.js'

type CliArgs = {
  help: boolean
  model?: string
  prompt?: string
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

Options:
  -h, --help       Show help
  -p, --prompt     Run a single prompt and exit
      --model      Override configured model
`)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }

  const config = initializeApp({
    model: args.model,
  })
  await startRepl({
    config,
    tools: allTools,
    initialPrompt: args.prompt,
  })
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})