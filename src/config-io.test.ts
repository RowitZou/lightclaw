import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

import { atomicWriteJson, mergeExternalConfig } from './config-io.js'

describe('mergeExternalConfig', () => {
  it('adds new external keys and updates changed scalars', () => {
    assert.deepEqual(
      mergeExternalConfig(
        { defaultModel: 'old', lang: 'en' },
        { defaultModel: 'new', endpoints: { a: { apiKey: 'sk' } } },
        { defaultModel: 'old' },
      ),
      { defaultModel: 'new', lang: 'en', endpoints: { a: { apiKey: 'sk' } } },
    )
  })

  it('deletes keys removed from external when they existed in the snapshot', () => {
    assert.deepEqual(
      mergeExternalConfig(
        { defaultModel: 'sonnet', lang: 'cn' },
        { defaultModel: 'sonnet' },
        { defaultModel: 'sonnet', lang: 'en' },
      ),
      { defaultModel: 'sonnet' },
    )
  })

  it('preserves home-only auto-injected keys', () => {
    assert.deepEqual(
      mergeExternalConfig(
        {
          endpoints: {
            anthropic: { apiKey: 'old' },
            codex: { auth: 'codex-oauth' },
          },
        },
        { endpoints: { anthropic: { apiKey: 'new' } } },
        { endpoints: { anthropic: { apiKey: 'old' } } },
      ),
      {
        endpoints: {
          anthropic: { apiKey: 'new' },
          codex: { auth: 'codex-oauth' },
        },
      },
    )
  })

  it('recursively deletes object subtrees while preserving injected children', () => {
    assert.deepEqual(
      mergeExternalConfig(
        {
          endpoints: {
            anthropic: { apiKey: 'sk' },
            codex: { auth: 'codex-oauth' },
          },
          models: { sonnet: { endpoint: 'anthropic' } },
        },
        {},
        {
          endpoints: { anthropic: { apiKey: 'sk' } },
          models: { sonnet: { endpoint: 'anthropic' } },
        },
      ),
      { endpoints: { codex: { auth: 'codex-oauth' } } },
    )
  })

  it('replaces arrays as whole values', () => {
    assert.deepEqual(
      mergeExternalConfig(
        { runtime: { docker: { mounts: [{ host: '/a' }] } } },
        { runtime: { docker: { mounts: [{ host: '/b' }] } } },
        { runtime: { docker: { mounts: [{ host: '/a' }] } } },
      ),
      { runtime: { docker: { mounts: [{ host: '/b' }] } } },
    )
  })

  it('handles first attachment to an existing home config without a snapshot', () => {
    assert.deepEqual(
      mergeExternalConfig(
        { endpoints: { codex: { auth: 'codex-oauth' } }, lang: 'cn' },
        { defaultModel: 'sonnet' },
        {},
      ),
      { endpoints: { codex: { auth: 'codex-oauth' } }, lang: 'cn', defaultModel: 'sonnet' },
    )
  })

  it('lets external type changes replace existing values', () => {
    assert.deepEqual(
      mergeExternalConfig(
        { endpoints: 'legacy' },
        { endpoints: { anthropic: { apiKey: 'sk' } } },
        { endpoints: 'legacy' },
      ),
      { endpoints: { anthropic: { apiKey: 'sk' } } },
    )
    assert.deepEqual(
      mergeExternalConfig(
        { endpoints: { anthropic: { apiKey: 'sk' } } },
        { endpoints: 'disabled' },
        { endpoints: { anthropic: { apiKey: 'sk' } } },
      ),
      { endpoints: 'disabled' },
    )
  })
})

describe('atomicWriteJson', () => {
  it('writes pretty JSON with owner-only permissions', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lightclaw-config-io-'))
    const file = path.join(dir, 'nested', 'config.json')
    try {
      atomicWriteJson(file, { a: 1 })
      assert.equal(readFileSync(file, 'utf8'), '{\n  "a": 1\n}\n')
      assert.equal(statSync(file).mode & 0o777, 0o600)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
