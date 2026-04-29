import type { Interface } from 'node:readline/promises'

import chalk from 'chalk'

import { addSessionRule } from '../state.js'
import {
  formatRuleListVerbose,
  formatSuggestionLabel,
} from './suggestions.js'
import type {
  PermissionDecision,
  PermissionRule,
  PermissionRuleValue,
  RiskLevel,
} from './types.js'

type ChoiceKind = 'allow_once' | 'allow_rules' | 'deny'

export async function askUserApproval(input: {
  rl: Interface
  toolName: string
  riskLevel: RiskLevel
  inputPreview: string
  suggestedRules: PermissionRuleValue[]
}): Promise<PermissionDecision> {
  const { rl, toolName, riskLevel, inputPreview, suggestedRules } = input
  const middleLabel = formatSuggestionLabel(suggestedRules, toolName)
  process.stdout.write(formatPrompt(toolName, riskLevel, inputPreview, middleLabel))

  const answer = (await rl.question('permission> ')).trim().toLowerCase()
  const choice = resolveChoice(answer)
  return applyChoice(choice, toolName, suggestedRules)
}

function formatPrompt(
  toolName: string,
  riskLevel: RiskLevel,
  inputPreview: string,
  middleLabel: string,
): string {
  return [
    '',
    chalk.yellow('Permission required'),
    `  Tool: ${chalk.cyan(toolName)}  Risk: ${chalk.magenta(riskLevel)}`,
    `  ${inputPreview}`,
    '',
    `  [1] Allow once`,
    `  [2] ${middleLabel}（本会话同类放行）`,
    `  [3] Deny (do not run ${toolName} this time)`,
    `  ${chalk.gray('(legacy keys: y=1, a=2, n=3)')}`,
    '',
  ].join('\n')
}

function resolveChoice(answer: string): ChoiceKind {
  if (answer === '' || answer === '1' || answer === 'y') return 'allow_once'
  if (answer === '2' || answer === 'a') return 'allow_rules'
  if (answer === '3' || answer === 'n') return 'deny'
  // Anything we don't understand defaults to deny — safer than guessing.
  return 'deny'
}

function applyChoice(
  choice: ChoiceKind,
  toolName: string,
  suggestedRules: PermissionRuleValue[],
): PermissionDecision {
  switch (choice) {
    case 'allow_once':
      return { behavior: 'allow' }
    case 'allow_rules': {
      const installed: PermissionRule[] = []
      for (const value of suggestedRules) {
        const rule: PermissionRule = {
          source: 'session',
          behavior: 'allow',
          value,
        }
        addSessionRule(rule)
        installed.push(rule)
      }
      const verbose = formatRuleListVerbose(suggestedRules)
      process.stdout.write(
        chalk.gray(
          `  (run /permissions clear to revoke ${verbose})\n`,
        ),
      )
      // Surface the matched rule so audit log reflects which scope unblocked
      // this call. Pick the first rule — they share semantics for this turn.
      return { behavior: 'allow', matchedRule: installed[0] }
    }
    case 'deny':
      return {
        behavior: 'deny',
        reason: `Permission denied: user denied ${toolName}.`,
      }
  }
}
