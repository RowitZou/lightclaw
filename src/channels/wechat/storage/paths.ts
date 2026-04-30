import path from 'node:path'

import { lightclawHome } from '../../../paths.js'

export function wechatStateDir(): string {
  return path.resolve(
    process.env.LIGHTCLAW_STATE_DIR ?? path.join(lightclawHome(), 'state'),
    'wechat',
  )
}
