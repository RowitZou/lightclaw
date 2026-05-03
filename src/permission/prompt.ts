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
  /**
   * When true, the prompt only renders [1] approve once / [3] deny — the
   * persistence option is intentionally suppressed. Selecting "2" / "a" /
   * "批准所有" in this mode is degraded to allow-once with a warning so the
   * user's intent (allow this command) is honored without stamping a
   * permanent rule for `rm` / `sudo` / pipe-to-shell. Computed in
   * permission/index.ts via isHighRiskAsk and passed through.
   */
  highRisk?: boolean
}): Promise<PermissionDecision> {
  const { rl, toolName, riskLevel, inputPreview, suggestedRules } = input
  const highRisk = Boolean(input.highRisk)
  const middleLabel = formatSuggestionLabel(suggestedRules, toolName)
  process.stdout.write(
    formatPrompt(toolName, riskLevel, inputPreview, middleLabel, highRisk),
  )

  const answer = (await rl.question('permission> ')).trim().toLowerCase()
  const choice = resolveChoice(answer, highRisk)
  return applyChoice(choice, toolName, suggestedRules)
}

function formatPrompt(
  toolName: string,
  riskLevel: RiskLevel,
  inputPreview: string,
  middleLabel: string,
  highRisk: boolean,
): string {
  if (highRisk) {
    return [
      '',
      chalk.red('⚠️  权限请求（高危）'),
      `  工具：${chalk.cyan(toolName)}   风险：${chalk.magenta(riskLevel)}`,
      `  ${inputPreview}`,
      chalk.gray(
        '  此操作含高风险子命令（rm / sudo / pipe-to-shell 等），不能持久化。',
      ),
      '',
      `  [1] 批准本次`,
      `  [3] 拒绝`,
      chalk.gray('  （兼容快捷键：y=1，n=3；输入 2 / a 会被降级为"仅这次"。）'),
      '',
    ].join('\n')
  }
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

function resolveChoice(answer: string, highRisk: boolean): ChoiceKind {
  if (answer === '' || answer === '1' || answer === 'y') return 'allow_once'
  if (answer === '2' || answer === 'a') {
    if (highRisk) {
      // Quietly downgrade — applyChoice prints the explanatory line via the
      // 'allow_once_high_risk_downgrade' branch below.
      process.stdout.write(
        chalk.gray(
          '  （高危规则不能持久化，已按"仅这次"批准）\n',
        ),
      )
      return 'allow_once'
    }
    return 'allow_rules'
  }
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
