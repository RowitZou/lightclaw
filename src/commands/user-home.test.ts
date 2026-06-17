import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'
import { afterEach, beforeEach, describe, it } from 'node:test'

import type { LightClawConfig } from '../config.js'
import { createUser, getIdentity } from '../identity/store.js'
import { userHome } from '../identity/paths.js'
import { setLang } from '../i18n/index.js'
import { setLightclawHomeOverride } from '../paths.js'
import { createBuiltinReplRegistry } from './builtin.js'
import type { ReplContext } from './registry.js'

let home = ''
let gpfsRoot = ''

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'lightclaw-user-home-command-'))
  gpfsRoot = path.join(home, 'gpfs')
  mkdirSync(gpfsRoot, { recursive: true })
  setLightclawHomeOverride(home)
  setLang('en')
  writeHomeConfig()
})

afterEach(() => {
  setLang('cn')
  setLightclawHomeOverride(undefined)
  rmSync(home, { recursive: true, force: true })
})

describe('/user set-home', () => {
  it('sets dataRoot after daemon-visible and gpfs-prefix validation', async () => {
    await createUser('alice')
    const dataRoot = path.join(gpfsRoot, 'alice-root')
    mkdirSync(dataRoot, { recursive: true })

    const output = await dispatchUserCommand(`/user set-home alice ${dataRoot}`)

    assert.match(output, /Set alice dataRoot=/)
    assert.equal((await getIdentity('alice'))?.dataRoot, dataRoot)
    assert.equal(userHome('alice'), dataRoot)
  })

  it('rejects cluster dataRoot paths outside gpfsMounts', async () => {
    await createUser('alice')
    const outside = path.join(home, 'outside-root')
    mkdirSync(outside, { recursive: true })

    const output = await dispatchUserCommand(`/user set-home alice ${outside}`)

    assert.match(output, /Error: .*gpfsMounts/)
    assert.equal((await getIdentity('alice'))?.dataRoot, undefined)
  })

  it('clears a previously configured dataRoot', async () => {
    await createUser('alice')
    const dataRoot = path.join(gpfsRoot, 'alice-root')
    mkdirSync(dataRoot, { recursive: true })
    await dispatchUserCommand(`/user set-home alice ${dataRoot}`)

    const output = await dispatchUserCommand('/user clear-home alice')

    assert.match(output, /Cleared alice dataRoot/)
    assert.equal((await getIdentity('alice'))?.dataRoot, undefined)
  })
})

async function dispatchUserCommand(command: string): Promise<string> {
  const chunks: string[] = []
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk))
      callback()
    },
  })
  await createBuiltinReplRegistry().dispatch(command, {
    config: clusterConfig(),
    sessionId: 's-user-home',
    createdAt: Date.now(),
    messages: [],
    output,
    userId: 'admin',
    isAdmin: true,
    isChannel: true,
    getActiveTools: () => [],
    setActiveTools() {},
    async persistMeta() {},
  } satisfies ReplContext)
  return chunks.join('')
}

function writeHomeConfig(): void {
  writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({
      endpoints: { fake: { apiKey: 'sk-fake' } },
      models: { fake: { endpoint: 'fake', schema: 'anthropic', upstreamModel: 'fake' } },
      defaultModel: 'fake',
      permissionCeiling: 'yolo',
      runtime: {
        backend: 'cluster',
        driver: 'brainpp',
        clusterSettings: {
          image: 'img',
          chargedGroup: 'grp',
          namespace: 'ns',
          gpfsMounts: [{ hostPrefix: gpfsRoot, mountPrefix: 'gpfs://gpfs1' }],
        },
      },
    }),
  )
}

function clusterConfig(): LightClawConfig {
  return {
    runtime: {
      backend: 'cluster',
      clusterSettings: {
        gpfsMounts: [{ hostPrefix: gpfsRoot, mountPrefix: 'gpfs://gpfs1' }],
      },
    },
  } as unknown as LightClawConfig
}
