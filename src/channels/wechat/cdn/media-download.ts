import { fetch as undiciFetch } from 'undici'

import { getWechatDispatcher } from '../api/api.js'
import { aesEcbDecrypt } from './aes-ecb.js'

export async function fetchAndDecryptMedia(input: {
  cdnBaseUrl: string
  encryptQueryParam: string
  aesKey: string
  aesKeyEncoding?: 'base64' | 'hex'
  fullUrl?: string
  timeoutMs?: number
}): Promise<Buffer> {
  const url = input.fullUrl?.trim() || `${stripTrailingSlash(input.cdnBaseUrl)}/${input.encryptQueryParam}`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), input.timeoutMs ?? 30_000)
  try {
    const res = await undiciFetch(url, {
      signal: ctrl.signal,
      dispatcher: getWechatDispatcher(),
    })
    if (!res.ok) {
      throw new Error(`CDN fetch ${res.status}: ${url}`)
    }
    const ciphertext = Buffer.from(await res.arrayBuffer())
    const key = Buffer.from(input.aesKey, input.aesKeyEncoding ?? 'base64')
    return aesEcbDecrypt(ciphertext, key)
  } finally {
    clearTimeout(timer)
  }
}

function stripTrailingSlash(input: string): string {
  return input.endsWith('/') ? input.slice(0, -1) : input
}
