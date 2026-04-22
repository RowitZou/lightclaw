import type { Interface } from 'node:readline/promises'

import chalk from 'chalk'

import { addSessionRule } from '../state.js'
import { parseRule } from './rules.js'
import type { PermissionDecision, PermissionRule, RiskLevel } from './types.js'

export async function askUserApproval(input: {
  rl: Interface
  toolName: string
  riskLevel: RiskLevel
  inputPreview: string
}): Promise<PermissionDecision> {
  const { rl, toolName, riskLevel, inputPreview } = input
  process.stdout.write(
    [
      '',
      chalk.yellow('Permission required'),
      `  Tool: ${chalk.cyan(toolName)}  Risk: ${chalk.magenta(riskLevel)}`,
      `  ${inputPreview}`,
      `  [y] allow once   [n] deny once`,
      `  [A] always allow ${toolName}   [D] always deny ${toolName}`,
      '',
    ].join('\n'),
  )

  const answer = (await rl.question('permission> ')).trim()
  switch (answer) {
    case 'y':
    case 'Y':
      return { behavior: 'allow' }
    case 'A': {
      const rule: PermissionRule = {
        source: 'session',
        behavior: 'allow',
        value: parseRule(toolName),
      }
      addSessionRule(rule)
      return { behavior: 'allow', matchedRule: rule }
    }
    case 'D': {
      const rule: PermissionRule = {
        source: 'session',
        behavior: 'deny',
        value: parseRule(toolName),
      }
      addSessionRule(rule)
      return {
        behavior: 'deny',
        reason: `Permission denied: user denied ${toolName} and added a session deny rule.`,
        matchedRule: rule,
      }
    }
    case 'n':
    case 'N':
    default:
      return {
        behavior: 'deny',
        reason: `Permission denied: user denied ${toolName}.`,
      }
  }
}
