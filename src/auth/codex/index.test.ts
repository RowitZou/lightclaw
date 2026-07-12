import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { resolveGlobalCodexProxy } from './index.js'

// 2026-07-12 family outage regression: the global codex token-refresh path
// resolved its proxy ONLY from `endpoints['codex'].proxy` — a deployment whose
// admin codex endpoint lived under another alias (`codex-ep`) with routing via
// `publicProxy` refreshed DIRECTLY against auth.openai.com and connect-timed
// out the moment the access token expired. The refresh must route exactly like
// the codex wire path: explicit endpoint proxy → publicProxy → direct.
describe('resolveGlobalCodexProxy', () => {
  const PUBLIC = 'http://public-proxy:1091'

  it('falls back to publicProxy for a codex endpoint under a non-"codex" alias (family outage shape)', () => {
    const proxy = resolveGlobalCodexProxy({
      endpoints: { 'codex-ep': { auth: 'codex-oauth' } },
      publicProxy: PUBLIC,
    })
    assert.equal(proxy, PUBLIC)
  })

  it('prefers the endpoint explicit proxy over publicProxy', () => {
    const proxy = resolveGlobalCodexProxy({
      endpoints: { 'codex-ep': { auth: 'codex-oauth', proxy: 'http://ep-proxy:1' } },
      publicProxy: PUBLIC,
    })
    assert.equal(proxy, 'http://ep-proxy:1')
  })

  it('prefers the "codex" alias when several codex endpoints carry explicit proxies', () => {
    const proxy = resolveGlobalCodexProxy({
      endpoints: {
        'codex-b': { auth: 'codex-oauth', proxy: 'http://b:1' },
        codex: { auth: 'codex-oauth', proxy: 'http://canonical:1' },
      },
      publicProxy: PUBLIC,
    })
    assert.equal(proxy, 'http://canonical:1')
  })

  it('uses another codex endpoint explicit proxy when the "codex" alias has none', () => {
    const proxy = resolveGlobalCodexProxy({
      endpoints: {
        codex: { auth: 'codex-oauth' },
        'codex-b': { auth: 'codex-oauth', proxy: 'http://b:1' },
      },
      publicProxy: PUBLIC,
    })
    assert.equal(proxy, 'http://b:1')
  })

  it('ignores apiKey endpoints when scanning for codex proxies', () => {
    const proxy = resolveGlobalCodexProxy({
      endpoints: {
        gateway: { apiKey: 'sk-x', proxy: 'http://apikey-ep:1' },
        'codex-ep': { auth: 'codex-oauth' },
      },
      publicProxy: PUBLIC,
    })
    assert.equal(proxy, PUBLIC)
  })

  it('still applies publicProxy when no codex endpoint is registered yet', () => {
    const proxy = resolveGlobalCodexProxy({ endpoints: {}, publicProxy: PUBLIC })
    assert.equal(proxy, PUBLIC)
  })

  it('returns undefined (direct) when neither endpoint proxy nor publicProxy is set', () => {
    const proxy = resolveGlobalCodexProxy({
      endpoints: { 'codex-ep': { auth: 'codex-oauth' } },
    })
    assert.equal(proxy, undefined)
  })
})
