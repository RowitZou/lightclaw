import type { Interface } from 'node:readline/promises'

import chalk from 'chalk'

import { t } from '../i18n/index.js'
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

  const answer = (await rl.question(t('permission.terminal.promptInput'))).trim().toLowerCase()
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
      chalk.red(t('permission.terminal.headerHighRisk')),
      t('permission.terminal.toolRisk', { tool: chalk.cyan(toolName), risk: chalk.magenta(riskLevel) }),
      t('permission.terminal.preview', { preview: inputPreview }),
      chalk.gray(t('permission.terminal.highRiskExplain')),
      '',
      t('permission.terminal.choice1Allow'),
      t('permission.terminal.choice3'),
      chalk.gray(t('permission.terminal.shortcutsHighRisk')),
      '',
    ].join('\n')
  }
  return [
    '',
    chalk.yellow(t('permission.terminal.header')),
    t('permission.terminal.toolRisk', { tool: chalk.cyan(toolName), risk: chalk.magenta(riskLevel) }),
    t('permission.terminal.preview', { preview: inputPreview }),
    '',
    t('permission.terminal.choice1Approve'),
    t('permission.terminal.choice2', { label: middleLabel }),
    t('permission.terminal.choice3'),
    `  ${chalk.gray(t('permission.terminal.shortcuts'))}`,
    '',
  ].join('\n')
}

function resolveChoice(answer: string, highRisk: boolean): ChoiceKind {
  if (answer === '' || answer === '1' || answer === 'y') return 'allow_once'
  if (answer === '2' || answer === 'a') {
    if (highRisk) {
      // Quietly downgrade — applyChoice prints the explanatory line via the
      // 'allow_once_high_risk_downgrade' branch below.
      process.stdout.write(chalk.gray(`${t('permission.terminal.downgradeHighRisk')}\n`))
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
      process.stdout.write(chalk.gray(
        userId
          ? `${t('permission.terminal.allowedPersisted', { verbose })}\n`
          : `${t('permission.terminal.allowedNoPersist')}\n`,
      ))
      // Surface the matched rule so audit log reflects which scope unblocked
      // this call. Pick the first rule — they share semantics for this turn.
      return { behavior: 'allow', matchedRule: installed[0] }
    }
    case 'deny':
      return {
        behavior: 'deny',
        reason: t('permission.terminal.deniedByUser', { tool: toolName }),
      }
  }
}
