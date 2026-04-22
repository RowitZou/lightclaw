import chalk from 'chalk'

import { initializeApp } from './init.js'
import { parsePermissionMode } from './config.js'
import { parseRule } from './permission/rules.js'
import type { PermissionMode, PermissionRule } from './permission/types.js'
import { getProvider } from './provider/index.js'
import { startRepl } from './repl.js'
import { getLatestSessionId } from './session/listing.js'
import { loadMeta } from './session/storage.js'
import { setCliArgRules } from './state.js'
import { allTools, getEnabledTools } from './tools.js'
import type { ProviderName } from './types.js'

type CliArgs = {
  help: boolean
  model?: string
  provider?: ProviderName
  prompt?: string
  resume?: string | true
  noMemory: boolean
  permissionMode?: PermissionMode
  allow: string[]
  deny: string[]
  dangerouslyBypass: boolean
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    help: false,
    noMemory: false,
    allow: [],
    deny: [],
    dangerouslyBypass: false,
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

    if (arg === '--provider') {
      const provider = argv[index + 1]
      if (provider === 'anthropic' || provider === 'openai') {
        args.provider = provider
      }
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

    if (arg === '--no-memory') {
      args.noMemory = true
      continue
    }

    if (arg === '--permission-mode') {
      const mode = parsePermissionMode(argv[index + 1])
      if (mode) {
        args.permissionMode = mode
      }
      index += 1
      continue
    }

    if (arg === '--allow') {
      const rule = argv[index + 1]
      if (rule) {
        args.allow.push(rule)
      }
      index += 1
      continue
    }

    if (arg === '--deny') {
      const rule = argv[index + 1]
      if (rule) {
        args.deny.push(rule)
      }
      index += 1
      continue
    }

    if (arg === '--dangerously-bypass') {
      args.dangerouslyBypass = true
      args.permissionMode = 'bypassPermissions'
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
  lightclaw --provider anthropic
  lightclaw --resume
  lightclaw --resume <session-id>
  lightclaw --no-memory
  lightclaw --permission-mode plan
  lightclaw --allow "Bash(git status:*)" --deny "Bash(rm:*)"

Options:
  -h, --help             Show help
  -p, --prompt           Run a single prompt and exit
      --model            Override configured model
      --provider         Override provider: anthropic or openai
      --resume           Resume the latest or a specific saved session
      --no-memory        Disable auto-memory extraction and memory index injection
      --permission-mode  Set mode: default, acceptEdits, bypassPermissions, plan
      --allow            Add a CLI allow rule (repeatable)
      --deny             Add a CLI deny rule (repeatable)
      --dangerously-bypass
                         Allow all tool calls unless denied by rule
`)
}

function parseCliRules(args: CliArgs): PermissionRule[] {
  const rules: PermissionRule[] = []
  for (const text of args.allow) {
    rules.push({ source: 'cliArg', behavior: 'allow', value: parseRule(text) })
  }
  for (const text of args.deny) {
    rules.push({ source: 'cliArg', behavior: 'deny', value: parseRule(text) })
  }

  return rules
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }
  if (args.provider) {
    process.env.LIGHTCLAW_PROVIDER = args.provider
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
    lastExtractedAt: resumeMeta?.lastExtractedAt,
    todos: resumeMeta?.todos,
    permissionMode: args.permissionMode ?? resumeMeta?.permissionMode,
  })
  setCliArgRules(parseCliRules(args))
  if (args.dangerouslyBypass) {
    console.error(chalk.red('--dangerously-bypass: all tool calls will be allowed unless an explicit deny rule matches.'))
  }
  if (args.noMemory) {
    config.autoMemory = false
  }
  const provider = getProvider(config)
  await startRepl({
    config,
    tools: getEnabledTools(provider, allTools),
    initialPrompt: args.prompt,
    resumeSessionId,
  })
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
