import { stdin as input, stdout as output } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { userInfo } from 'node:os'

import chalk from 'chalk'

import { t } from './i18n/index.js'
import {
  addLink,
  createUser,
  getAdmin,
  lookupBySender,
  rebuildReverseIndex,
  setAdmin,
} from './identity/store.js'
import type { SenderKey } from './identity/types.js'

/**
 * `firstRun` is true only when this call created the admin (no admin existed
 * on disk). cli.ts threads it into the terminal banner so the freshly set-up
 * operator gets the full orientation block instead of the steady-state line.
 */
export async function ensureAdminInitialized(options?: {
  interactive?: boolean
}): Promise<{ adminName: string; firstRun: boolean }> {
  await rebuildReverseIndex()
  const existingAdmin = await getAdmin()
  if (existingAdmin) {
    return { adminName: existingAdmin, firstRun: false }
  }

  if (options?.interactive === false || !input.isTTY) {
    throw new Error('LightClaw identity is not initialized. Run `lightclaw` in an interactive terminal first.')
  }

  output.write(chalk.cyan(`${t('wizard.notInitialized')}\n\n`))
  const osUser = userInfo().username || 'admin'
  const rl = createInterface({ input, output, terminal: true })
  try {
    const answer = await rl.question(t('wizard.adminNamePrompt', { default: osUser }))
    const adminName = answer.trim() || osUser
    const created = await createUser(adminName)
    if (!created.ok && created.reason !== 'exists') {
      throw new Error(t('wizard.invalidName', { name: adminName }))
    }
    await setAdmin(adminName)
    await addLink(adminName, `terminal:${osUser}` as SenderKey)
    output.write(chalk.green(`${t('wizard.created', { name: adminName, link: osUser })}\n\n`))
    return { adminName, firstRun: true }
  } finally {
    rl.close()
  }
}

export async function resolveTerminalUserId(): Promise<string> {
  await rebuildReverseIndex()
  const osUser = userInfo().username || 'unknown'
  const link = `terminal:${osUser}` as SenderKey
  const userId = lookupBySender(link)
  if (!userId) {
    throw new Error(`Terminal user '${osUser}' is not bound to any LightClaw identity.`)
  }
  return userId
}

