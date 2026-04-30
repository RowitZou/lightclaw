import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import path from 'node:path'

import {
  expandHomePath,
  lightclawHome,
  setLightclawHomeOverride,
} from './paths.js'

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
