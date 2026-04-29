import type { Interface } from 'node:readline/promises'

import chalk from 'chalk'

import { addSessionRule } from '../state.js'
import { formatRule } from './rules.js'
import type {
  PermissionDecision,
  PermissionRule,
  PermissionRuleValue,
  RiskLevel,
} from './types.js'

type ApprovalOption =
  | { kind: 'allow_once' }
  | { kind: 'allow_rule'; rule: PermissionRuleValue }
  | { kind: 'deny' }

export async function askUserApproval(input: {
  rl: Interface
  toolName: string
  riskLevel: RiskLevel
  inputPreview: string
  suggestedRules: PermissionRuleValue[]
}): Promise<PermissionDecision> {
  const { rl, toolName, riskLevel, inputPreview, suggestedRules } = input
  const options = buildOptions(suggestedRules)
  process.stdout.write(formatPrompt(toolName, riskLevel, inputPreview, options))

  const answer = (await rl.question('permission> ')).trim()
  const choice = resolveChoice(answer, options)
  return applyChoice(choice, toolName)
}

function buildOptions(suggested: PermissionRuleValue[]): ApprovalOption[] {
  const out: ApprovalOption[] = [{ kind: 'allow_once' }]
  for (const rule of suggested) {
    out.push({ kind: 'allow_rule', rule })
  }
  out.push({ kind: 'deny' })
  return out
}

function formatPrompt(
  toolName: string,
  riskLevel: RiskLevel,
  inputPreview: string,
  options: ApprovalOption[],
): string {
  const lines: string[] = [
    '',
    chalk.yellow('Permission required'),
    `  Tool: ${chalk.cyan(toolName)}  Risk: ${chalk.magenta(riskLevel)}`,
    `  ${inputPreview}`,
    '',
    '  How would you like to handle this and similar requests?',
  ]
  options.forEach((opt, index) => {
    const idx = index + 1
    lines.push(`  [${idx}] ${describeOption(opt, toolName)}`)
  })
  lines.push(
    `  ${chalk.gray('(legacy keys: y=1, a=last allow option, n=deny)')}`,
    '',
  )
  return lines.join('\n')
}

function describeOption(opt: ApprovalOption, toolName: string): string {
  switch (opt.kind) {
    case 'allow_once':
      return 'Allow once'
    case 'allow_rule':
      return `Allow ${formatRule(opt.rule)} for the rest of this session`
    case 'deny':
      return `Deny (do not run ${toolName} this time)`
  }
}

function resolveChoice(
  answer: string,
  options: ApprovalOption[],
): ApprovalOption {
  const lower = answer.toLowerCase()
  if (lower === '' || lower === 'y') {
    return options[0]!
  }
  if (lower === 'n') {
    return options[options.length - 1]!
  }
  if (lower === 'a') {
    // Legacy `[a]` was tool-wide allow; the suggestion array is precise→broad,
    // so the last allow_rule is the broadest (tool-only) entry — equivalent.
    for (let i = options.length - 1; i >= 0; i--) {
      const opt = options[i]
      if (opt && opt.kind === 'allow_rule') {
        return opt
      }
    }
    return options[0]!
  }

  const numeric = Number(lower)
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= options.length) {
    return options[numeric - 1]!
  }

  // Anything we don't understand defaults to deny — safer than guessing.
  return options[options.length - 1]!
}

function applyChoice(
  choice: ApprovalOption,
  toolName: string,
): PermissionDecision {
  switch (choice.kind) {
    case 'allow_once':
      return { behavior: 'allow' }
    case 'allow_rule': {
      const rule: PermissionRule = {
        source: 'session',
        behavior: 'allow',
        value: choice.rule,
      }
      addSessionRule(rule)
      process.stdout.write(
        chalk.gray(
          `  (run /permissions clear to revoke ${formatRule(choice.rule)})\n`,
        ),
      )
      return { behavior: 'allow', matchedRule: rule }
    }
    case 'deny':
      return {
        behavior: 'deny',
        reason: `Permission denied: user denied ${toolName}.`,
      }
  }
}
