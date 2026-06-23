import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import AdmZip from 'adm-zip'

import {
  identityPermissionsPath,
  rlaunchMountsPath,
  userConfigPath,
  userMemoryRoot,
  userSecretsPath,
  userSessionsRoot,
  userSkillsRoot,
} from '../identity/paths.js'
import { setLightclawHomeOverride } from '../paths.js'

import { exportUserData, importUserData } from './archive.js'

const USER = 'alice'
let homeA = ''
let homeB = ''

async function seed(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, content, 'utf8')
}

beforeEach(async () => {
  homeA = await mkdtemp(path.join(tmpdir(), 'lightclaw-sysdata-a-'))
  homeB = await mkdtemp(path.join(tmpdir(), 'lightclaw-sysdata-b-'))
})

afterEach(async () => {
  setLightclawHomeOverride(undefined)
  await rm(homeA, { recursive: true, force: true })
  await rm(homeB, { recursive: true, force: true })
})

describe('system-data export/import round-trip', () => {
  it('packs memory / skills / mounts and restores them onto another home', async () => {
    setLightclawHomeOverride(homeA)
    await seed(path.join(userMemoryRoot(USER), 'fact.md'), '# a fact')
    await seed(path.join(userMemoryRoot(USER), 'webSearcher', 'note.md'), '# role note')
    await seed(path.join(userSkillsRoot(USER), 'my-skill', 'SKILL.md'), '# skill')
    await seed(rlaunchMountsPath(USER), '{"mounts":["/gpfs/x"]}')
    const { buffer, manifest, componentsPacked } = await exportUserData(USER)

    assert.equal(manifest.secretsIncluded, false)
    assert.ok(componentsPacked.includes('memory'))
    assert.ok(componentsPacked.includes('skills'))
    assert.ok(componentsPacked.includes('mounts'))

    setLightclawHomeOverride(homeB)
    const result = await importUserData(USER, buffer)
    assert.ok(result.applied.includes('memory'))
    assert.ok(result.applied.includes('skills'))
    assert.ok(result.applied.includes('mounts'))

    assert.equal(await readFile(path.join(userMemoryRoot(USER), 'fact.md'), 'utf8'), '# a fact')
    assert.equal(
      await readFile(path.join(userMemoryRoot(USER), 'webSearcher', 'note.md'), 'utf8'),
      '# role note',
    )
    assert.equal(await readFile(path.join(userSkillsRoot(USER), 'my-skill', 'SKILL.md'), 'utf8'), '# skill')
    assert.equal(await readFile(rlaunchMountsPath(USER), 'utf8'), '{"mounts":["/gpfs/x"]}')
    // The memory index is framework-regenerated after import.
    assert.ok(existsSync(path.join(userMemoryRoot(USER), 'MEMORY.md')))
  })
})

describe('system-data secrets / config invariants', () => {
  it('never packs secrets.json', async () => {
    setLightclawHomeOverride(homeA)
    await seed(path.join(userMemoryRoot(USER), 'fact.md'), '# a fact')
    await seed(userSecretsPath(USER), '{"secrets":{"BYO_KEY_1":{"value":"sk-REAL"}}}')
    const { buffer, manifest } = await exportUserData(USER)

    assert.equal(manifest.secretsIncluded, false)
    const names = new AdmZip(buffer).getEntries().map(e => e.entryName)
    assert.ok(!names.some(n => n.includes('secrets')))
    assert.ok(!Buffer.concat([buffer]).includes(Buffer.from('sk-REAL')))
  })

  it('packs config.json for backup but never imports it (keeps the target config)', async () => {
    setLightclawHomeOverride(homeA)
    await seed(userConfigPath(USER), '{"workspace":"/from/archive"}')
    await seed(path.join(userMemoryRoot(USER), 'fact.md'), '# a fact')
    const { buffer, manifest } = await exportUserData(USER)
    assert.ok(manifest.components.includes('config'))

    setLightclawHomeOverride(homeB)
    await seed(userConfigPath(USER), '{"workspace":"/local/keep"}')
    const result = await importUserData(USER, buffer)

    assert.ok(result.skipped.includes('config'))
    assert.ok(!result.applied.includes('config'))
    // Target config untouched — the user's own config (and key refs) preserved.
    assert.equal(await readFile(userConfigPath(USER), 'utf8'), '{"workspace":"/local/keep"}')
  })
})

describe('system-data merge vs replace', () => {
  async function exportMemoryArchive(): Promise<Buffer> {
    setLightclawHomeOverride(homeA)
    await seed(path.join(userMemoryRoot(USER), 'from-archive.md'), '# archive')
    const { buffer } = await exportUserData(USER)
    return buffer
  }

  it('merge (default) keeps target-only files', async () => {
    const buffer = await exportMemoryArchive()
    setLightclawHomeOverride(homeB)
    await seed(path.join(userMemoryRoot(USER), 'target-only.md'), '# target')

    await importUserData(USER, buffer) // merge

    assert.ok(existsSync(path.join(userMemoryRoot(USER), 'target-only.md')))
    assert.ok(existsSync(path.join(userMemoryRoot(USER), 'from-archive.md')))
  })

  it('replace removes target-only files inside the component subtree', async () => {
    const buffer = await exportMemoryArchive()
    setLightclawHomeOverride(homeB)
    await seed(path.join(userMemoryRoot(USER), 'target-only.md'), '# target')

    await importUserData(USER, buffer, { replace: true })

    assert.ok(!existsSync(path.join(userMemoryRoot(USER), 'target-only.md')))
    assert.ok(existsSync(path.join(userMemoryRoot(USER), 'from-archive.md')))
  })

  it('replace does not touch components the archive does not carry', async () => {
    const buffer = await exportMemoryArchive() // memory only
    setLightclawHomeOverride(homeB)
    await seed(path.join(userSkillsRoot(USER), 'keep', 'SKILL.md'), '# keep')

    await importUserData(USER, buffer, { replace: true })

    assert.ok(existsSync(path.join(userSkillsRoot(USER), 'keep', 'SKILL.md')))
  })
})

describe('system-data sessions opt-in + manifest validation', () => {
  it('omits sessions unless withSessions is set', async () => {
    setLightclawHomeOverride(homeA)
    await seed(path.join(userMemoryRoot(USER), 'fact.md'), '# a fact')
    await seed(path.join(userSessionsRoot(USER), 'feishu_dm_x', 'transcript.jsonl'), '{}')

    const without = await exportUserData(USER)
    assert.ok(!without.componentsPacked.includes('sessions'))
    assert.equal(without.manifest.includesSessions, false)

    const withSessions = await exportUserData(USER, { withSessions: true })
    assert.ok(withSessions.componentsPacked.includes('sessions'))
    assert.equal(withSessions.manifest.includesSessions, true)
  })

  it('rejects an archive with no manifest', async () => {
    const zip = new AdmZip()
    zip.addFile('memory/x.md', Buffer.from('# x'))
    setLightclawHomeOverride(homeB)
    await assert.rejects(() => importUserData(USER, zip.toBuffer()), /manifest\.json missing/)
  })

  it('rejects a future archive version', async () => {
    setLightclawHomeOverride(homeA)
    await seed(path.join(userMemoryRoot(USER), 'fact.md'), '# a fact')
    const { buffer } = await exportUserData(USER)
    // Rewrite the manifest with a bumped version.
    const zip = new AdmZip(buffer)
    const manifest = JSON.parse(zip.getEntry('manifest.json')!.getData().toString('utf8'))
    manifest.version = 999
    zip.updateFile('manifest.json', Buffer.from(JSON.stringify(manifest)))
    setLightclawHomeOverride(homeB)
    await assert.rejects(() => importUserData(USER, zip.toBuffer()), /newer than this LightClaw/)
  })

  // permissions.json is a file component — confirm it round-trips as overwrite.
  it('overwrites file components (permissions) on import', async () => {
    setLightclawHomeOverride(homeA)
    await seed(identityPermissionsPath(USER), '{"allow":["Bash(ls:*)"]}')
    const { buffer } = await exportUserData(USER)

    setLightclawHomeOverride(homeB)
    await seed(identityPermissionsPath(USER), '{"allow":["OLD"]}')
    const result = await importUserData(USER, buffer)

    assert.ok(result.applied.includes('permissions'))
    assert.equal(await readFile(identityPermissionsPath(USER), 'utf8'), '{"allow":["Bash(ls:*)"]}')
  })
})
