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
    for (const name of ['/feedback', '/model', '/mode', '/mount', '/rules', '/secret']) {
      assert.match(output, new RegExp(`^${escapeRegExp(name)}\\s\\s`, 'm'))
    }
    for (const name of ['/auth', '/ceiling', '/cost', '/feishu-workspace', '/sandbox', '/user']) {
      assert.doesNotMatch(output, new RegExp(`^${escapeRegExp(name)}\\s\\s`, 'm'))
    }
    for (const name of ['/help', '/status', '/stop']) {
      assert.doesNotMatch(output, new RegExp(`^${escapeRegExp(name)}\\s\\s`, 'm'))
    }
    assert.deepEqual(commandNames(output), ['/feedback', '/mode', '/model', '/mount', '/rules', '/secret'])
  })

  it('lists admin advisory commands and excludes user-only feedback', async () => {
    await setAdmin('admin')
    const output = await callCatalogAs('admin')

    assert.match(output, /current user is admin/)
    for (const name of [
      '/auth',
      '/ceiling',
      '/cost',
      '/feishu-workspace',
      '/model',
      '/mode',
      '/mount',
      '/rules',
      '/sandbox',
      '/secret',
      '/user',
    ]) {
      assert.match(output, new RegExp(`^${escapeRegExp(name)}\\s\\s`, 'm'))
    }
    assert.doesNotMatch(output, /^\/feedback\s\s/m)
    assert.equal(commandNames(output).length, 11)
  })

  it('formats each entry with description, usage block, advisory, and blank separator', async () => {
    const output = await callCatalogAs('alice')
    assert.match(output, /\/mount  Manage per-user dynamic rlaunch mounts\n  Usage:\n    \/mount list/)
    assert.match(output, /  Suggest when: When the user references a host path outside/)
    assert.match(output, /\n\n\/rules  /)
  })

  it('renders the full multi-line agentUsage for each advisory command', async () => {
    const output = await callCatalogAs('alice')

    assert.match(output, /^    \/secret set <NAME> <VALUE>/m)
    assert.match(output, /^    \/secret enable <NAME>/m)
    // Bug 6 regression: bare /model lists selectable models, so the catalog
    // must document that form — not just `/model <name>` — or the agent can
    // neither name the available models nor tell the user how to list them.
    assert.match(output, /^    \/model {2,}Show the current model and list/m)
    assert.match(output, /^    \/model <name> {2,}Switch to a model alias/m)
  })

  it('passes through backticks, quotes, and dollar signs in advisory and usage text', async () => {
    const output = await callCatalogAs('alice')

    assert.match(output, /`Bash\(git:\*\)`/)
    assert.match(output, /\$NAME/)
    assert.match(output, /VALUE is taken verbatim to end of line \(may contain spaces, \$, quotes\)\./)
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
