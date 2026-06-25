import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import type { LightClawConfig } from '../config.js'
import { setLang } from '../i18n/index.js'
import { setLightclawHomeOverride } from '../paths.js'
import type { Runtime } from '../runtime/index.js'
import { loadUserSecrets } from '../secrets/store.js'
import { loadUserRlaunchMounts } from '../runtime/rlaunch-mounts.js'
import type { ChannelFileSender } from '../session-context.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'
import { createBuiltinReplRegistry } from './builtin.js'
import { runSystemCommand } from './system.js'

/** Build an ALS SessionContext exposing a channel file sender / runtime so the
 *  `--feishu` data paths (getChannelFileSender / getRuntimeIfInitialized) work. */
function makeFeishuCtx(extra: { channelFileSender?: ChannelFileSender; runtime?: Runtime }) {
  return createSessionContext({
    cwd: tmpHome,
    model: 'sonnet',
    config: makeConfig(),
    sessionsDir: path.join(tmpHome, 'sessions'),
    memoryDir: path.join(tmpHome, 'memory'),
    currentUserId: 'alice',
    sessionId: 'feishu:dm:x',
    permissionMode: 'default',
    permissionCeiling: 'bypassPermissions',
    ...extra,
  })
}

let tmpHome = ''
let gpfsRoot = ''
let workspaceRoot = ''
let oldWorkspaceRoot: string | undefined

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-system-command-'))
  gpfsRoot = path.join(tmpHome, 'gpfs')
  workspaceRoot = path.join(gpfsRoot, 'workspaces')
  mkdirSync(path.join(workspaceRoot, 'alice'), { recursive: true })
  setLightclawHomeOverride(tmpHome)
  oldWorkspaceRoot = process.env.LIGHTCLAW_WORKSPACE_ROOT
  process.env.LIGHTCLAW_WORKSPACE_ROOT = workspaceRoot
  setLang('en')
})

afterEach(() => {
  setLang('cn')
  setLightclawHomeOverride(undefined)
  if (oldWorkspaceRoot === undefined) {
    delete process.env.LIGHTCLAW_WORKSPACE_ROOT
  } else {
    process.env.LIGHTCLAW_WORKSPACE_ROOT = oldWorkspaceRoot
  }
  rmSync(tmpHome, { recursive: true, force: true })
})

// Minimal cluster config so the mount runner reaches its list / remove paths
// (mirrors mount.test.ts:makeConfig). `key` delegation does not read config.
function makeConfig(): LightClawConfig {
  return {
    runtime: {
      driver: 'brainpp',
      backend: 'cluster',
      clusterSettings: {
        gpfsMounts: [{ hostPrefix: gpfsRoot, mountPrefix: 'gpfs://gpfs1' }],
      },
    },
  } as unknown as LightClawConfig
}

describe('/system command', () => {
  it('routes `key set` to the real secret runner and persists the value', async () => {
    const value = 'ghp_real_value_$with"chars and spaces'
    const out = await runSystemCommand(`key set GH_TOKEN ${value}`, {
      config: makeConfig(),
      userId: 'alice',
    })
    assert.match(out, /Secret GH_TOKEN saved/)
    // Persisted via the real secret store, proving /system reached the runner.
    assert.equal(loadUserSecrets('alice').GH_TOKEN.value, value)
  })

  it('routes `key` (bare) to the secret list path and `key rm` to removal', async () => {
    await runSystemCommand('key set API val', { config: makeConfig(), userId: 'alice' })
    // Bare key shows the textified card: the saved key with its enabled state.
    assert.match(
      await runSystemCommand('key', { config: makeConfig(), userId: 'alice' }),
      /API（disabled）/,
    )
    assert.match(
      await runSystemCommand('key rm API', { config: makeConfig(), userId: 'alice' }),
      /removed/,
    )
    assert.equal('API' in loadUserSecrets('alice'), false)
  })

  it('routes `mount` (bare / list) to the textified card, add/rm to the runner', async () => {
    // Bare + list are the show path → textified card (its title repeats the
    // command path, and the empty state shows there are no mounts yet).
    assert.match(
      await runSystemCommand('mount', { config: makeConfig(), userId: 'alice' }),
      /\/system mount/,
    )
    assert.match(
      await runSystemCommand('mount list', { config: makeConfig(), userId: 'alice' }),
      /No paths mounted yet/,
    )
  })

  it('routes `mount rm <path>` to the mount remove path', async () => {
    const dataPath = path.join(gpfsRoot, 'datasets')
    mkdirSync(dataPath, { recursive: true })
    const deps = { restartRlaunch: async () => 'worker-1' }
    await runSystemCommand(`mount add ${dataPath}`, { config: makeConfig(), userId: 'alice' }, deps)
    assert.deepEqual(loadUserRlaunchMounts('alice'), [{ path: dataPath, mode: 'ro' }])

    const removed = await runSystemCommand(
      `mount rm ${dataPath}`,
      { config: makeConfig(), userId: 'alice' },
      deps,
    )
    assert.match(removed, /Unmounted:/)
    assert.deepEqual(loadUserRlaunchMounts('alice'), [])
  })

  it('prints the hub overview card for bare and unknown nouns without side effects', async () => {
    const cards: unknown[] = []
    const ctx = {
      config: makeConfig(),
      userId: 'alice',
      setCommandListCard: (spec: unknown) => cards.push(spec),
    }
    const bare = await runSystemCommand('', ctx)
    // Terminal fallback text lists every noun + the footer hint.
    assert.match(bare, /\/system key/)
    assert.match(bare, /\/system mount/)
    assert.match(bare, /\/system data/)
    assert.match(bare, /just ask LightClaw|直接问 LightClaw/)
    // Channel card spec carries the same nouns as a rows section.
    assert.equal(cards.length, 1)
    const spec = cards[0] as { sections: Array<{ rows: ReadonlyArray<readonly [string, string]> }> }
    const commands = spec.sections[0].rows.map(r => r[0])
    assert.deepEqual(commands, ['/system key', '/system mount', '/system data'])

    const unknown = await runSystemCommand('bogus verb', ctx)
    assert.match(unknown, /\/system key/)
    assert.equal(cards.length, 2)
  })

  it('prints data noun-verb usage on bare invocation', async () => {
    const bare = await runSystemCommand('data', { config: makeConfig(), userId: 'alice' })
    assert.match(bare, /\/system data export/)
    assert.match(bare, /\/system data import/)
  })

  it('export writes a zip and warns secrets are excluded; import round-trips', async () => {
    // Seed a memory file + a config for alice so there is something to export.
    const memDir = path.join(tmpHome, 'users', 'alice', 'memory')
    mkdirSync(memDir, { recursive: true })
    writeFileSync(path.join(memDir, 'fact.md'), '# remembered', 'utf8')
    writeFileSync(path.join(tmpHome, 'users', 'alice', 'config.json'), '{"workspace":"/x"}', 'utf8')

    const dest = path.join(tmpHome, 'backup.zip')
    const exportOut = await runSystemCommand(`data export --path ${dest}`, {
      config: makeConfig(),
      userId: 'alice',
    })
    assert.match(exportOut, /Exported/)
    assert.match(exportOut, /secrets are NOT included/)
    assert.equal(existsSync(dest), true)

    // import without --y prints a preview and does nothing.
    const preview = await runSystemCommand(`data import --path ${dest}`, {
      config: makeConfig(),
      userId: 'alice',
    })
    assert.match(preview, /merge mode/)

    // Wipe the memory file, then import it back with --y.
    rmSync(path.join(memDir, 'fact.md'))
    const importOut = await runSystemCommand(`data import --path ${dest} --y`, {
      config: makeConfig(),
      userId: 'alice',
    })
    assert.match(importOut, /Imported: .*memory/)
    assert.match(importOut, /config was not imported/)
    assert.equal(existsSync(path.join(memDir, 'fact.md')), true)
  })

  it('export with no data reports nothing to export; missing import file is reported', async () => {
    assert.match(
      await runSystemCommand(`data export --path ${path.join(tmpHome, 'x.zip')}`, {
        config: makeConfig(),
        userId: 'bob',
      }),
      /Nothing to export/,
    )
    assert.match(
      await runSystemCommand(`data import --path ${path.join(tmpHome, 'nope.zip')} --y`, {
        config: makeConfig(),
        userId: 'alice',
      }),
      /Archive not found/,
    )
  })

  it('export --feishu without a channel sender reports unavailable', async () => {
    const out = await runWithSessionContext(makeFeishuCtx({}), () =>
      runSystemCommand('data export --feishu', { config: makeConfig(), userId: 'alice' }),
    )
    assert.match(out, /Feishu file transport is unavailable/)
  })

  it('import --feishu with no attachment asks for the file', async () => {
    const out = await runWithSessionContext(makeFeishuCtx({}), () =>
      runSystemCommand('data import --feishu --y', {
        config: makeConfig(),
        userId: 'alice',
        attachmentPaths: [],
      }),
    )
    assert.match(out, /No attachment found/)
  })

  it('export --feishu sends a zip via the sender; import --feishu reads an attached zip', async () => {
    const memDir = path.join(tmpHome, 'users', 'alice', 'memory')
    mkdirSync(memDir, { recursive: true })
    writeFileSync(path.join(memDir, 'fact.md'), '# feishu', 'utf8')

    let sentBuffer: Buffer | undefined
    const sender: ChannelFileSender = {
      channelId: 'feishu',
      async sendFile(file) {
        sentBuffer = file.content
        return { kind: 'im-attachment' }
      },
    }
    const exportOut = await runWithSessionContext(makeFeishuCtx({ channelFileSender: sender }), () =>
      runSystemCommand('data export --feishu', { config: makeConfig(), userId: 'alice' }),
    )
    assert.match(exportOut, /sent to this chat/)
    assert.match(exportOut, /secrets are NOT included/)
    assert.ok(sentBuffer && sentBuffer.length > 0)

    // Wipe, then import the captured zip back through a fake runtime read.
    rmSync(path.join(memDir, 'fact.md'))
    const zipPath = '/workspace/.lightclaw/inbox/oc_chat/backup.zip'
    const runtime = {
      fs: {
        async readFile(p: string) {
          assert.equal(p, zipPath)
          return sentBuffer!
        },
      },
    } as unknown as Runtime
    const importOut = await runWithSessionContext(makeFeishuCtx({ runtime }), () =>
      runSystemCommand('data import --feishu --y', {
        config: makeConfig(),
        userId: 'alice',
        attachmentPaths: [zipPath],
      }),
    )
    assert.match(importOut, /Imported: .*memory/)
    assert.equal(existsSync(path.join(memDir, 'fact.md')), true)
  })

  it('key rm: unreferenced key deletes with NO --y', async () => {
    await runSystemCommand('key set LONE val', { config: makeConfig(), userId: 'alice' })
    assert.equal('LONE' in loadUserSecrets('alice'), true)
    const out = await runSystemCommand('key rm LONE', { config: makeConfig(), userId: 'alice' })
    assert.match(out, /removed/)
    assert.equal('LONE' in loadUserSecrets('alice'), false)
  })

  it('key rm: referenced key requires --y (no --y = preview, no delete)', async () => {
    const { setUserSecret } = await import('../secrets/store.js')
    const { writeUserConfig } = await import('../config/user-override.js')
    setUserSecret('alice', 'API_KEY', 'sk-real')
    // Bind an endpoint to that key so the rm cascades.
    writeUserConfig('alice', { endpoints: { ep: { type: 'openai', apiKeyRef: 'API_KEY' } } })

    const preview = await runSystemCommand('key rm API_KEY', { config: makeConfig(), userId: 'alice' })
    assert.match(preview, /\bep\b/, 'preview lists the dependent endpoint')
    assert.match(preview, /--y/)
    assert.equal('API_KEY' in loadUserSecrets('alice'), true, 'no --y must not delete')

    const done = await runSystemCommand('key rm API_KEY --y', { config: makeConfig(), userId: 'alice' })
    assert.match(done, /removed/)
    assert.equal('API_KEY' in loadUserSecrets('alice'), false)
  })

  it('data import requires --y (no --y = preview, no action)', async () => {
    // Build a real archive so the confirm gate (not the not-found path) is exercised.
    const memDir = path.join(tmpHome, 'users', 'alice', 'memory')
    mkdirSync(memDir, { recursive: true })
    writeFileSync(path.join(memDir, 'fact.md'), '# x', 'utf8')
    const dest = path.join(tmpHome, 'gate.zip')
    await runSystemCommand(`data export --path ${dest}`, { config: makeConfig(), userId: 'alice' })

    const preview = await runSystemCommand(`data import --path ${dest}`, { config: makeConfig(), userId: 'alice' })
    assert.match(preview, /--y/)
    const done = await runSystemCommand(`data import --path ${dest} --y`, { config: makeConfig(), userId: 'alice' })
    assert.match(done, /Imported/)
  })

  it('registers /system as channel-only (hidden from the terminal console)', () => {
    const channelRegistry = createBuiltinReplRegistry({ includeChannelOnly: true })
    const terminalRegistry = createBuiltinReplRegistry({ includeChannelOnly: false })

    const command = channelRegistry.find('/system')
    assert.ok(command)
    assert.equal(command.channelOnly, true)
    assert.match(command.agentUsage ?? '', /\/system key set <NAME>/)
    assert.equal(terminalRegistry.find('/system'), undefined)
  })
})

describe('system usage fallbacks render the structured card', () => {
  it('/system key set with no value → key card, not Usage text', async () => {
    const out = await runSystemCommand('key set GH_TOKEN', { config: makeConfig(), userId: 'alice' })
    assert.doesNotMatch(out, /^Usage:/m)
    assert.match(out, /\/system key set/)
  })

  it('/system mount bogusverb → mount card', async () => {
    const out = await runSystemCommand('mount bogusverb', { config: makeConfig(), userId: 'alice' })
    assert.doesNotMatch(out, /^Usage:/m)
    assert.match(out, /\/system mount add/)
  })
})
