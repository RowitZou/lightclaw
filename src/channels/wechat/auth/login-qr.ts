import { randomUUID } from 'node:crypto'

import { apiGetFetch } from '../api/api.js'
import { saveWechatAccount } from '../storage/accounts.js'

const FIXED_BASE_URL = 'https://ilinkai.weixin.qq.com'
const DEFAULT_ILINK_BOT_TYPE = '3'
const ACTIVE_LOGIN_TTL_MS = 5 * 60_000
const QR_LONG_POLL_TIMEOUT_MS = 35_000
const MAX_QR_REFRESH_COUNT = 3

type ActiveLogin = {
  sessionKey: string
  qrcode: string
  qrcodeUrl: string
  startedAt: number
}

type QrStartResult = {
  qrcodeUrl?: string
  sessionKey: string
  message: string
}

type QrWaitResult = {
  connected: boolean
  botToken?: string
  accountId?: string
  baseUrl?: string
  userId?: string
  message: string
}

type QRCodeResponse = {
  qrcode?: string
  qrcode_img_content?: string
}

type StatusResponse = {
  status?: 'wait' | 'scaned' | 'confirmed' | 'expired' | 'scaned_but_redirect'
  bot_token?: string
  ilink_bot_id?: string
  baseurl?: string
  ilink_user_id?: string
}

const activeLogins = new Map<string, ActiveLogin>()

export async function startWechatLoginWithQr(input: {
  apiBaseUrl?: string
  botType?: string
} = {}): Promise<QrStartResult> {
  purgeExpiredLogins()
  const sessionKey = randomUUID()
  const apiBaseUrl = input.apiBaseUrl ?? FIXED_BASE_URL
  try {
    const qr = await fetchQRCode(apiBaseUrl, input.botType ?? DEFAULT_ILINK_BOT_TYPE)
    if (!qr.qrcode || !qr.qrcode_img_content) {
      return { sessionKey, message: '微信登录失败：服务端未返回二维码。' }
    }
    activeLogins.set(sessionKey, {
      sessionKey,
      qrcode: qr.qrcode,
      qrcodeUrl: qr.qrcode_img_content,
      startedAt: Date.now(),
    })
    return {
      qrcodeUrl: qr.qrcode_img_content,
      sessionKey,
      message: '使用微信扫描以下二维码，以完成连接。',
    }
  } catch (error) {
    return { sessionKey, message: `微信登录启动失败: ${String(error)}` }
  }
}

export async function waitForWechatLogin(input: {
  sessionKey: string
  apiBaseUrl?: string
  timeoutMs?: number
  botType?: string
}): Promise<QrWaitResult> {
  const apiBaseUrl = input.apiBaseUrl ?? FIXED_BASE_URL
  const timeoutMs = Math.max(input.timeoutMs ?? 480_000, 1000)
  const deadline = Date.now() + timeoutMs
  let login = activeLogins.get(input.sessionKey)
  if (!login || !isFresh(login)) {
    activeLogins.delete(input.sessionKey)
    return { connected: false, message: '当前没有进行中的登录，请重新开始。' }
  }

  let qrRefreshCount = 1
  let scannedPrinted = false
  while (Date.now() < deadline) {
    const status = await pollQRStatus(apiBaseUrl, login.qrcode)
    if (status.status === 'scaned' && !scannedPrinted) {
      process.stdout.write('\n已扫码，请在微信继续确认...\n')
      scannedPrinted = true
    }
    if (status.status === 'confirmed') {
      activeLogins.delete(input.sessionKey)
      if (!status.bot_token || !status.ilink_bot_id) {
        return { connected: false, message: '登录失败：服务端未返回 bot token。' }
      }
      return {
        connected: true,
        botToken: status.bot_token,
        accountId: status.ilink_bot_id,
        baseUrl: status.baseurl ?? apiBaseUrl,
        userId: status.ilink_user_id,
        message: '与微信连接成功。',
      }
    }
    if (status.status === 'scaned_but_redirect') {
      activeLogins.delete(input.sessionKey)
      return { connected: false, message: '登录需要 IDC redirect；v1 暂不跟随，请重试。' }
    }
    if (status.status === 'expired') {
      qrRefreshCount += 1
      if (qrRefreshCount > MAX_QR_REFRESH_COUNT) {
        activeLogins.delete(input.sessionKey)
        return { connected: false, message: '二维码多次过期，请重新开始登录。' }
      }
      process.stdout.write(`\n二维码已过期，正在刷新...(${qrRefreshCount}/${MAX_QR_REFRESH_COUNT})\n`)
      const qr = await fetchQRCode(apiBaseUrl, input.botType ?? DEFAULT_ILINK_BOT_TYPE)
      if (!qr.qrcode || !qr.qrcode_img_content) {
        activeLogins.delete(input.sessionKey)
        return { connected: false, message: '刷新二维码失败：服务端未返回二维码。' }
      }
      login = {
        sessionKey: input.sessionKey,
        qrcode: qr.qrcode,
        qrcodeUrl: qr.qrcode_img_content,
        startedAt: Date.now(),
      }
      activeLogins.set(input.sessionKey, login)
      scannedPrinted = false
      await printQr(qr.qrcode_img_content)
    }
    await sleep(1000)
  }

  activeLogins.delete(input.sessionKey)
  return { connected: false, message: '登录超时，请重试。' }
}

export async function runWechatLoginCli(): Promise<void> {
  console.log('正在启动微信扫码登录...\n')
  const start = await startWechatLoginWithQr()
  if (!start.qrcodeUrl) {
    console.error(start.message)
    process.exitCode = 1
    return
  }
  await printQr(start.qrcodeUrl)
  console.log('\n请用微信扫描以上二维码，并在手机上确认。')
  console.log('如果二维码无法显示，请用浏览器打开此链接：')
  console.log(`${start.qrcodeUrl}\n`)

  const result = await waitForWechatLogin({ sessionKey: start.sessionKey })
  if (!result.connected || !result.botToken) {
    console.error(result.message)
    process.exitCode = 1
    return
  }
  await saveWechatAccount('default', {
    token: result.botToken,
    baseUrl: result.baseUrl ?? FIXED_BASE_URL,
    userId: result.userId,
  })
  console.log('\n与微信连接成功。')
  console.log('账户信息已保存到 ~/.lightclaw/state/wechat/accounts/default.json')
}

async function fetchQRCode(apiBaseUrl: string, botType: string): Promise<QRCodeResponse> {
  const raw = await apiGetFetch({
    baseUrl: apiBaseUrl,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    label: 'fetchQRCode',
  })
  return JSON.parse(raw) as QRCodeResponse
}

async function pollQRStatus(apiBaseUrl: string, qrcode: string): Promise<StatusResponse> {
  try {
    const raw = await apiGetFetch({
      baseUrl: apiBaseUrl,
      endpoint: `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
      timeoutMs: QR_LONG_POLL_TIMEOUT_MS,
      label: 'pollQRStatus',
    })
    return JSON.parse(raw) as StatusResponse
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { status: 'wait' }
    }
    process.stderr.write(`wechat login: poll failed, retrying: ${String(error)}\n`)
    return { status: 'wait' }
  }
}

async function printQr(qrcodeUrl: string): Promise<void> {
  const qrcodeTerminal = await import('qrcode-terminal')
  await new Promise<void>(resolve => {
    qrcodeTerminal.default.generate(qrcodeUrl, { small: true }, output => {
      console.log(output)
      resolve()
    })
  })
}

function purgeExpiredLogins(): void {
  for (const [key, login] of activeLogins) {
    if (!isFresh(login)) {
      activeLogins.delete(key)
    }
  }
}

function isFresh(login: ActiveLogin): boolean {
  return Date.now() - login.startedAt < ACTIVE_LOGIN_TTL_MS
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
