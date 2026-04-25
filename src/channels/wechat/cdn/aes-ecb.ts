import crypto from 'node:crypto'

export function aesEcbDecrypt(ciphertext: Buffer, key: Buffer): Buffer {
  if (key.length !== 16) {
    throw new Error(`AES-128-ECB requires 16-byte key, got ${key.length}`)
  }
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null)
  decipher.setAutoPadding(true)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}
