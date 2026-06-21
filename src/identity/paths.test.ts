import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { setLightclawHomeOverride } from '../paths.js'
import { userConfigPath, userHome, userWorkspaceOverride, workspaceFor } from './paths.js'

let tmpHome = ''
let oldWorkspaceRoot: string | undefined

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-paths-'))
  setLightclawHomeOverride(tmpHome)
  oldWorkspaceRoot = process.env.LIGHTCLAW_WORKSPACE_ROOT
  delete process.env.LIGHTCLAW_WORKSPACE_ROOT
})

afterEach(() => {
  setLightclawHomeOverride(undefined)
  if (oldWorkspaceRoot === undefined) {
    delete process.env.LIGHTCLAW_WORKSPACE_ROOT
  } else {
    process.env.LIGHTCLAW_WORKSPACE_ROOT = oldWorkspaceRoot
  }
  rmSync(tmpHome, { recursive: true, force: true })
})

function writeUserOverride(user: string, workspace: unknown): void {
  const file = userConfigPath(user)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ workspace }), 'utf8')
}

describe('userWorkspaceOverride', () => {
  it('returns undefined when no config.json exists', () => {
    assert.equal(userWorkspaceOverride('alice'), undefined)
  })

  it('returns undefined for a blank / non-string workspace', () => {
    writeUserOverride('alice', '   ')
    assert.equal(userWorkspaceOverride('alice'), undefined)
    writeUserOverride('alice', 42)
    assert.equal(userWorkspaceOverride('alice'), undefined)
  })

  it('returns the resolved absolute override when set', () => {
    writeUserOverride('alice', '/data/collab/alice')
    assert.equal(userWorkspaceOverride('alice'), '/data/collab/alice')
  })

  it('returns undefined on corrupt JSON rather than throwing', () => {
    const file = userConfigPath('alice')
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, '{ not json', 'utf8')
    assert.equal(userWorkspaceOverride('alice'), undefined)
  })
})

describe('workspaceFor priority', () => {
  it('uses the per-user override when present (highest priority)', () => {
    process.env.LIGHTCLAW_WORKSPACE_ROOT = path.join(tmpHome, 'pool')
    writeUserOverride('alice', '/data/collab/alice')
    assert.equal(workspaceFor('alice'), '/data/collab/alice')
  })

  it('uses <configured>/<u> when no override but paths.workspace is set', () => {
    const pool = path.join(tmpHome, 'pool')
    process.env.LIGHTCLAW_WORKSPACE_ROOT = pool
    assert.equal(workspaceFor('alice'), path.join(pool, 'alice'))
  })

  it('falls back to userHome/workspace when neither override nor pool', () => {
    assert.equal(workspaceFor('alice'), path.join(userHome('alice'), 'workspace'))
  })
})
