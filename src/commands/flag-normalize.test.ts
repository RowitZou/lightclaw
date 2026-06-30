import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { canonicalizeFlagTokens } from './flag-normalize.js'

describe('canonicalizeFlagTokens', () => {
  it('rewrites unicode-dash flag prefixes to ASCII --', () => {
    // Feishu / IME smart-punctuation substitutes for a typed `--`.
    for (const dash of ['–', '—', '−', '‐', '‑', '‒', '―']) {
      assert.deepEqual(canonicalizeFlagTokens([`${dash}auth-path`]), ['--auth-path'])
      assert.deepEqual(canonicalizeFlagTokens([`${dash}${dash}type`]), ['--type'])
    }
  })

  it('promotes a single-dash long flag to --', () => {
    assert.deepEqual(canonicalizeFlagTokens(['-auth-path']), ['--auth-path'])
    assert.deepEqual(canonicalizeFlagTokens(['-type']), ['--type'])
  })

  it('keeps a single-letter short flag single-dashed', () => {
    assert.deepEqual(canonicalizeFlagTokens(['-h']), ['-h'])
  })

  it('leaves non-flag tokens (paths, urls, keys, bare words) untouched', () => {
    const tokens = [
      'endpoint',
      'add',
      'codex-gpt5.5',
      '/mnt/shared-storage-user/songdemin/user/wangrui/codex/auth.json',
      'https://gw.example/v1',
      'sk-RAW',
    ]
    assert.deepEqual(canonicalizeFlagTokens(tokens), tokens)
  })

  it('does not touch a bare dash run with no letter body', () => {
    assert.deepEqual(canonicalizeFlagTokens(['—', '--', '-']), ['—', '--', '-'])
  })

  it('canonicalizes the reported real-world command', () => {
    const parts =
      '/config endpoint add codex-gpt5.5 --type codex —auth-path /mnt/x/auth.json'
        .replace(/^\/config\s+/, '')
        .split(/\s+/)
        .filter(Boolean)
    const out = canonicalizeFlagTokens(parts)
    assert.ok(out.includes('--auth-path'), 'em-dash --auth-path is recovered')
    assert.equal(out[out.indexOf('--auth-path') + 1], '/mnt/x/auth.json')
  })
})
