import type { Interface } from 'node:readline/promises'

import chalk from 'chalk'

import { getCurrentUserId, setIdentityRules } from '../state.js'
import { appendIdentityRules, loadIdentityRules } from './storage.js'
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
    chalk.yellow('权限请求'),
    `  工具：${chalk.cyan(toolName)}   风险：${chalk.magenta(riskLevel)}`,
    `  ${inputPreview}`,
    '',
    `  [1] 批准`,
    `  [2] ${middleLabel}`,
    `  [3] 拒绝`,
    `  ${chalk.gray('(兼容快捷键：y=1，a=2，n=3)')}`,
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
      const userId = getCurrentUserId()
      const installed: PermissionRule[] = suggestedRules.map(value => ({
        source: 'identity' as const,
        behavior: 'allow' as const,
        value,
      }))
      if (userId) {
        appendIdentityRules({ canonicalUser: userId, rules: installed })
        setIdentityRules(loadIdentityRules(userId))
      }
      const verbose = formatRuleListVerbose(suggestedRules)
      process.stdout.write(
        chalk.gray(
          userId
            ? `  （已持久化授权：${verbose}；发送 /permissions clear 撤回）\n`
            : `  （未持久化：当前无 identity 上下文；本次仍允许）\n`,
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
