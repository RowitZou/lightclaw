import { homedir } from 'node:os'
import path from 'node:path'

export function wechatStateDir(): string {
  return path.resolve(
    process.env.LIGHTCLAW_STATE_DIR ?? path.join(homedir(), '.lightclaw', 'state'),
    'wechat',
  )
}
