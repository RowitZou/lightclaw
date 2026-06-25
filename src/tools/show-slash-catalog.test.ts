import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { setAdmin } from '../identity/store.js'
import { setLang } from '../i18n/index.js'
import { setLightclawHomeOverride } from '../paths.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'
import { showSlashCatalogTool } from './show-slash-catalog.js'

let testHome = ''

describe('ShowSlashCatalog tool', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'lightclaw-show-slash-catalog-'))
    testHome = home
    setLightclawHomeOverride(home)
    setLang('en')
  })

  afterEach(() => {
    setLang('cn')
    setLightclawHomeOverride(undefined)
    testHome = ''
    rmSync(home, { recursive: true, force: true })
  })

  it('lists non-admin advisory commands and skips commands without advisory', async () => {
    const output = await callCatalogAs('alice')

    assert.match(output, /Slash commands \(chat only\):/)
    // PR5.9 B6: surviving non-admin advisory commands are /config /system
    // /feedback. The retired top-level names are gone.
    for (const name of ['/config', '/feedback', '/system']) {
      assert.match(output, new RegExp(`^${escapeRegExp(name)}\\s\\s`, 'm'))
    }
    for (const name of [
      '/auth', '/ceiling', '/cost', '/feishu-workspace', '/sandbox', '/user',
      '/model', '/mode', '/mount', '/rules', '/secret', '/admin',
    ]) {
      assert.doesNotMatch(output, new RegExp(`^${escapeRegExp(name)}\\s\\s`, 'm'))
    }
    for (const name of ['/help', '/status', '/stop']) {
      assert.doesNotMatch(output, new RegExp(`^${escapeRegExp(name)}\\s\\s`, 'm'))
    }
    assert.deepEqual(commandNames(output), ['/config', '/feedback', '/system'])
  })

  it('lists admin advisory commands including /feedback (now open to all)', async () => {
    await setAdmin('admin')
    const output = await callCatalogAs('admin')

    assert.match(output, /current user is admin/)
    // Surviving admin advisory commands are /admin /config /system; /feedback
    // is now visibleTo:'all' (admin uses it too), so it appears here as well.
    for (const name of ['/admin', '/config', '/feedback', '/system']) {
      assert.match(output, new RegExp(`^${escapeRegExp(name)}\\s\\s`, 'm'))
    }
    for (const name of [
      '/auth', '/ceiling', '/cost', '/feishu-workspace',
      '/model', '/mode', '/mount', '/rules', '/sandbox', '/secret', '/user',
    ]) {
      assert.doesNotMatch(output, new RegExp(`^${escapeRegExp(name)}\\s\\s`, 'm'))
    }
    assert.deepEqual(commandNames(output), ['/admin', '/config', '/feedback', '/system'])
  })

  it('formats each entry with description, usage block, advisory, and blank separator', async () => {
    const output = await callCatalogAs('alice')
    assert.match(output, /\/system  Manage runtime resources \(keys \/ mounts \/ data\)\n  Usage:\n    \/system key/)
    assert.match(output, /  Suggest when: When the user needs to manage runtime resources/)
    assert.match(output, /\n\n\/system  /)
  })

  it('renders the full multi-line agentUsage for each advisory command', async () => {
    const output = await callCatalogAs('alice')

    // /system absorbs the secret (key) and mount surfaces.
    assert.match(output, /^    \/system key set <NAME> <VALUE\.\.\.>/m)
    assert.match(output, /^    \/system key enable\|disable <NAME>/m)
    assert.match(output, /^    \/system mount add <gpfs-path\.\.\.>/m)
  })

  it('passes through backticks, quotes, and dollar signs in advisory and usage text', async () => {
    await setAdmin('admin')
    const output = await callCatalogAs('admin')

    // The /admin endpoint advisory documents codex provider config; the
    // /system key usage carries $NAME injection.
    assert.match(output, /\$NAME/)
  })
})

async function callCatalogAs(userId: string): Promise<string> {
  const ctx = createSessionContext({
    cwd: '/',
    model: 'test-model',
    sessionsDir: path.join(testHome, 'sessions'),
    memoryDir: path.join(testHome, 'memory'),
    currentUserId: userId,
  })
  const result = await runWithSessionContext(ctx, async () =>
    showSlashCatalogTool.call({}, {} as never),
  )
  return result.output
}

function commandNames(output: string): string[] {
  return output
    .split('\n')
    .filter(line => line.startsWith('/'))
    .map(line => line.split(/\s+/, 1)[0]!)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
