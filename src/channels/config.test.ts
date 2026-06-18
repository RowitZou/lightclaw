import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

import { setLightclawHomeOverride } from '../paths.js'
import { loadChannelConfig } from './config.js'

let tmpHome = ''
const ENV_KEYS = [
  'FEISHU_APP_ID',
  'FEISHU_APP_SECRET',
  'FEISHU_ENCRYPT_KEY',
  'FEISHU_VERIFICATION_TOKEN',
  'FEISHU_PROXY',
  'LIGHTCLAW_FEISHU_PERMISSION_MODE',
  'LIGHTCLAW_FEISHU_TRANSPORT',
  'LIGHTCLAW_FEISHU_TYPING_REACTION',
  'LIGHTCLAW_FEISHU_STREAMING_REPLY',
  'LIGHTCLAW_FEISHU_PARENT_FETCH_TIMEOUT_MS',
] as const
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-channels-config-'))
  setLightclawHomeOverride(tmpHome)
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  setLightclawHomeOverride(undefined)
  rmSync(tmpHome, { recursive: true, force: true })
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = savedEnv[key]
    }
  }
})

describe('loadChannelConfig', () => {
  it('reads feishu config from config.json channels section', () => {
    writeJson('config.json', {
      channels: {
        feishu: {
          enabled: true,
          appId: 'cli_app',
          appSecret: 'cli_secret',
          transport: 'webhook',
          requireMention: false,
          cloudSpace: { uploadsFolderName: 'Uploads' },
        },
      },
    })

    const config = loadChannelConfig()
    assert.equal(config.feishu.enabled, true)
    assert.equal(config.feishu.appId, 'cli_app')
    assert.equal(config.feishu.appSecret, 'cli_secret')
    assert.equal(config.feishu.transport, 'webhook')
    assert.equal(config.feishu.requireMention, false)
    assert.equal(config.feishu.streamingReply, false)
    assert.equal(config.feishu.cloudSpace?.uploadsFolderName, 'Uploads')
  })

  it('falls back to legacy channels.json and warns once', () => {
    writeJson('channels.json', {
      feishu: { enabled: true, appId: 'legacy_app', appSecret: 'legacy_secret' },
    })
    const writes = captureStderr(() => {
      assert.equal(loadChannelConfig().feishu.appId, 'legacy_app')
      assert.equal(loadChannelConfig().feishu.appSecret, 'legacy_secret')
    })

    assert.equal(writes.length, 1)
    assert.match(writes[0] ?? '', /Deprecated config: .*channels\.json/)
  })

  it('does not read legacy channels.json when config.json has channels', () => {
    writeJson('config.json', {
      channels: {
        feishu: { enabled: true, appId: 'config_app' },
      },
    })
    writeJson('channels.json', {
      feishu: { enabled: true, appId: 'legacy_app' },
    })

    const writes = captureStderr(() => {
      const config = loadChannelConfig()
      assert.equal(config.feishu.appId, 'config_app')
    })
    assert.deepEqual(writes, [])
  })

  it('uses defaults when neither config file has channel config', () => {
    const config = loadChannelConfig()
    assert.equal(config.feishu.enabled, false)
    assert.equal(config.feishu.transport, 'ws')
    assert.equal(config.feishu.permissionMode, 'acceptEdits')
    assert.equal(config.feishu.streamingReply, false)
  })

  it('reads channels.feishu.streamingReply and allows env override', () => {
    writeJson('config.json', {
      channels: { feishu: { enabled: true, streamingReply: true } },
    })
    assert.equal(loadChannelConfig().feishu.streamingReply, true)

    process.env.LIGHTCLAW_FEISHU_STREAMING_REPLY = 'false'
    assert.equal(loadChannelConfig().feishu.streamingReply, false)
  })

  it('feishu permissionMode falls back to the top-level config.permissionMode', () => {
    writeJson('config.json', {
      permissionMode: 'yolo',
      channels: { feishu: { enabled: true, appId: 'app' } },
    })
    assert.equal(loadChannelConfig().feishu.permissionMode, 'bypassPermissions')
  })

  it('explicit channels.feishu.permissionMode overrides the top-level default', () => {
    writeJson('config.json', {
      permissionMode: 'yolo',
      channels: { feishu: { enabled: true, appId: 'app', permissionMode: 'read' } },
    })
    assert.equal(loadChannelConfig().feishu.permissionMode, 'plan')
  })
})

function writeJson(fileName: string, body: unknown): void {
  writeFileSync(path.join(tmpHome, fileName), JSON.stringify(body), 'utf8')
}

function captureStderr(fn: () => void): string[] {
  const original = process.stderr.write
  const writes: string[] = []
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    writes.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  try {
    fn()
  } finally {
    process.stderr.write = original
  }
  return writes
}
