import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { tmpdir } from 'node:os'

import {
  expandHomePath,
  lightclawHome,
  setLightclawHomeOverride,
} from './paths.js'
import {
  identityPermissionsPath,
  rlaunchMountsPath,
  userBackgroundTasksPath,
  userCompletedBackgroundTasksPath,
  userFeishuUploadsPath,
  userFeishuWorkspacePath,
  userHome,
  userMemoryRoot,
  userSessionsRoot,
  userPreferencesPath,
  userSecretsPath,
  userSkillsRoot,
  usersRoot,
  userTaskRunsRoot,
  workspaceFor,
  workspaceRoot,
} from './identity/paths.js'

describe('expandHomePath', () => {
  it('expands `~` alone', () => {
    assert.equal(expandHomePath('~'), homedir())
  })

  it('expands `~/foo` to <home>/foo', () => {
    assert.equal(expandHomePath('~/foo'), path.join(homedir(), 'foo'))
  })

  it('expands ${HOME}/foo', () => {
    assert.equal(expandHomePath('${HOME}/foo'), path.join(homedir(), 'foo'))
  })

  it('passes absolute paths through unchanged', () => {
    assert.equal(expandHomePath('/tmp/x'), '/tmp/x')
  })

  it('passes relative paths through unchanged (no leading ~)', () => {
    assert.equal(expandHomePath('foo/bar'), 'foo/bar')
  })
})

describe('lightclawHome', () => {
  let savedEnv: string | undefined

  beforeEach(() => {
    savedEnv = process.env.LIGHTCLAW_HOME
    delete process.env.LIGHTCLAW_HOME
    setLightclawHomeOverride(undefined)
  })

  afterEach(() => {
    if (savedEnv !== undefined) {
      process.env.LIGHTCLAW_HOME = savedEnv
    } else {
      delete process.env.LIGHTCLAW_HOME
    }
    setLightclawHomeOverride(undefined)
  })

  it('defaults to ~/.lightclaw', () => {
    assert.equal(lightclawHome(), path.join(homedir(), '.lightclaw'))
  })

  it('honors LIGHTCLAW_HOME env var', () => {
    process.env.LIGHTCLAW_HOME = '/tmp/from-env'
    assert.equal(lightclawHome(), '/tmp/from-env')
  })

  it('CLI override beats env', () => {
    process.env.LIGHTCLAW_HOME = '/tmp/from-env'
    setLightclawHomeOverride('/tmp/from-cli')
    assert.equal(lightclawHome(), '/tmp/from-cli')
  })

  it('expands ~ in env var', () => {
    process.env.LIGHTCLAW_HOME = '~/foo'
    assert.equal(lightclawHome(), path.join(homedir(), 'foo'))
  })

  it('expands ${HOME} in CLI override', () => {
    setLightclawHomeOverride('${HOME}/cli-home')
    assert.equal(lightclawHome(), path.join(homedir(), 'cli-home'))
  })

  it('resolves relative to absolute', () => {
    process.env.LIGHTCLAW_HOME = './rel'
    assert.equal(lightclawHome(), path.resolve('./rel'))
  })
})

describe('per-user storage paths', () => {
  let savedWorkspaceRoot: string | undefined

  beforeEach(() => {
    savedWorkspaceRoot = process.env.LIGHTCLAW_WORKSPACE_ROOT
    delete process.env.LIGHTCLAW_WORKSPACE_ROOT
  })

  afterEach(() => {
    setLightclawHomeOverride(undefined)
    if (savedWorkspaceRoot === undefined) {
      delete process.env.LIGHTCLAW_WORKSPACE_ROOT
    } else {
      process.env.LIGHTCLAW_WORKSPACE_ROOT = savedWorkspaceRoot
    }
  })

  it('stores runtime state under <home>/users/<canonical>', () => {
    setLightclawHomeOverride('/tmp/lightclaw-home')

    assert.equal(usersRoot(), '/tmp/lightclaw-home/users')
    assert.equal(userHome('alice@example.com'), '/tmp/lightclaw-home/users/alice_example_com')
    assert.equal(identityPermissionsPath('alice'), '/tmp/lightclaw-home/users/alice/permissions.json')
    assert.equal(rlaunchMountsPath('alice'), '/tmp/lightclaw-home/users/alice/rlaunch-mounts.json')
    assert.equal(userSecretsPath('alice'), '/tmp/lightclaw-home/users/alice/secrets.json')
    assert.equal(userPreferencesPath('alice'), '/tmp/lightclaw-home/users/alice/preferences.json')
    assert.equal(userSkillsRoot('alice'), '/tmp/lightclaw-home/users/alice/skills')
    assert.equal(userSessionsRoot('alice'), '/tmp/lightclaw-home/users/alice/sessions')
    assert.equal(userMemoryRoot('alice'), '/tmp/lightclaw-home/users/alice/memory')
    assert.equal(userTaskRunsRoot('alice'), '/tmp/lightclaw-home/users/alice/taskruns')
    assert.equal(userBackgroundTasksPath('alice'), '/tmp/lightclaw-home/users/alice/bg-tasks.json')
    assert.equal(userCompletedBackgroundTasksPath('alice'), '/tmp/lightclaw-home/users/alice/bg-tasks-completed.jsonl')
    assert.equal(userFeishuWorkspacePath('alice'), '/tmp/lightclaw-home/users/alice/feishu-workspace.json')
    assert.equal(userFeishuUploadsPath('alice'), '/tmp/lightclaw-home/users/alice/feishu-uploads.json')
  })

  it('defaults workspaces to the user tree unless an explicit root is configured', () => {
    setLightclawHomeOverride('/tmp/lightclaw-home')

    assert.equal(workspaceRoot(), '/tmp/lightclaw-home/users')
    assert.equal(workspaceFor('alice'), '/tmp/lightclaw-home/users/alice/workspace')

    process.env.LIGHTCLAW_WORKSPACE_ROOT = '/tmp/workspaces'
    assert.equal(workspaceRoot(), '/tmp/workspaces')
    assert.equal(workspaceFor('alice'), '/tmp/workspaces/alice')
  })

  it('uses identities.json dataRoot as the userHome anchor', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'lightclaw-userhome-'))
    try {
      const dataRoot = path.join(home, 'external-alice-root')
      mkdirSync(path.join(home, 'identity'), { recursive: true })
      mkdirSync(dataRoot, { recursive: true })
      writeFileSync(
        path.join(home, 'identity', 'identities.json'),
        JSON.stringify({
          alice: {
            createdAt: '2026-06-17T00:00:00.000Z',
            updatedAt: '2026-06-17T00:00:00.000Z',
            channels: { feishu: [], terminal: [] },
            dataRoot,
          },
        }),
      )
      setLightclawHomeOverride(home)

      assert.equal(userHome('alice'), dataRoot)
      assert.equal(userSessionsRoot('alice'), path.join(dataRoot, 'sessions'))
      assert.equal(workspaceFor('alice'), path.join(dataRoot, 'workspace'))
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('lets users/<canonical>/config.json override the runtime workspace', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'lightclaw-user-workspace-'))
    try {
      const workspace = path.join(home, 'custom-workspace')
      mkdirSync(path.join(home, 'users', 'alice'), { recursive: true })
      writeFileSync(
        path.join(home, 'users', 'alice', 'config.json'),
        JSON.stringify({ workspace }),
      )
      setLightclawHomeOverride(home)

      assert.equal(workspaceFor('alice'), workspace)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
