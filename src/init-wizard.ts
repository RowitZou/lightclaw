import { stdin as input, stdout as output } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { userInfo } from 'node:os'

import chalk from 'chalk'

import {
  addLink,
  createUser,
  getAdmin,
  lookupBySender,
  rebuildReverseIndex,
  setAdmin,
} from './identity/store.js'
import type { SenderKey } from './identity/types.js'

export async function ensureAdminInitialized(options?: {
  interactive?: boolean
}): Promise<string> {
  await rebuildReverseIndex()
  const existingAdmin = await getAdmin()
  if (existingAdmin) {
    return existingAdmin
  }

  if (options?.interactive === false || !input.isTTY) {
    throw new Error('LightClaw identity is not initialized. Run `lightclaw` in an interactive terminal first.')
  }

  output.write(chalk.cyan('LightClaw is not initialized. Setting up first admin.\n\n'))
  const osUser = userInfo().username || 'admin'
  const rl = createInterface({ input, output, terminal: true })
  try {
    const answer = await rl.question(`Admin canonical name (default: ${osUser}): `)
    const adminName = answer.trim() || osUser
    const created = await createUser(adminName)
    if (!created.ok && created.reason !== 'exists') {
      throw new Error(`Invalid admin identity name: ${adminName}`)
    }
    await setAdmin(adminName)
    await addLink(adminName, `terminal:${osUser}` as SenderKey)
    output.write(chalk.green(`Created admin user '${adminName}' and linked terminal:${osUser}.\n\n`))
    return adminName
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

