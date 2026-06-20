import type { LightClawConfig } from '../config.js'
import { t } from '../i18n/index.js'
import { RlaunchRuntime } from '../runtime/index.js'
import {
  getCurrentUserId,
  getRuntime,
  getRuntimePool,
  setRuntime,
} from '../state.js'
import type { ReplContext } from './registry.js'

export async function restartRlaunchRuntimeForUser(input: {
  userId: string
  config: LightClawConfig
}): Promise<string> {
  const next = getRuntimePool().swapRlaunchRuntime(input.userId, input.config)
  await next.start()
  return next.name ?? t('sandbox.workerNone')
}

export async function restartCurrentRlaunchRuntime(ctx: ReplContext): Promise<string> {
  const userId = ctx.userId ?? getCurrentUserId()
  if (!userId) {
    throw new Error(t('common.error.noActiveIdentity'))
  }
  const current = getRuntime()
  if (!(current instanceof RlaunchRuntime)) {
    throw new Error(t('mount.requiresRlaunchRuntime'))
  }
  const next = getRuntimePool().swapRlaunchRuntime(userId, ctx.config)
  setRuntime(next)
  await next.start()
  return next.name ?? t('sandbox.workerNone')
}
