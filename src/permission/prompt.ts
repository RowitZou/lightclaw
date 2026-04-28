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
      `  [y] allow once   [a] always allow ${toolName} (this session)   [n] deny once`,
      '',
    ].join('\n'),
  )

  const answer = (await rl.question('permission> ')).trim()
  switch (answer) {
    case 'y':
    case 'Y':
      return { behavior: 'allow' }
    case 'a':
    case 'A': {
      const rule: PermissionRule = {
        source: 'session',
        behavior: 'allow',
        value: parseRule(toolName),
      }
      addSessionRule(rule)
      process.stdout.write(
        chalk.gray(`  (run /permissions clear to revoke this session rule)\n`),
      )
      return { behavior: 'allow', matchedRule: rule }
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
