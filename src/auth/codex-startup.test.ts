import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  AuthError,
  _resetAuthProviderRegistryForTests,
  registerAuthProvider,
} from './index.js'
import {
  _internal,
  ensureOAuthModelsUsable,
} from './codex/startup.js'
import type { LightClawConfig } from '../config.js'
import type { AuthCredentials, AuthProvider } from './types.js'

function makeConfig(over: Partial<LightClawConfig> = {}): LightClawConfig {
  // Minimal LightClawConfig shape — we only mutate models / routing / model.
  return {
    lang: 'cn',
    model: 'sonnet',
    models: {
      sonnet: { endpoint: 'gw', schema: 'anthropic', upstreamModel: 'claude-sonnet-4-6' },
      'gpt-5-mini': { endpoint: 'gw', schema: 'openai', upstreamModel: 'gpt-5-mini' },
      'gpt-5-codex': { endpoint: 'codex', schema: 'openai-auth', upstreamModel: 'gpt-5.5' },
    },
    endpoints: {
      gw: { apiKey: 'sk-x' },
      codex: { auth: 'codex-oauth' },
    },
    routing: {
      main: 'sonnet',
      extract: 'gpt-5-codex',
    },
    ...over,
  } as LightClawConfig
}

function fakeProvider(opts: {
  credentials?: AuthCredentials
  getCredsError?: AuthError
  importError?: AuthError
  importSuccessThenCreds?: AuthCredentials
}): AuthProvider {
  const provider: AuthProvider = {
    name: 'codex',
    async getCredentials() {
      if (opts.credentials) return opts.credentials
      if (opts.getCredsError) throw opts.getCredsError
      throw new AuthError({
        code: 'auth_missing',
        provider: 'codex',
        message: 'no token',
      })
    },
    async logout() {},
  }
  if (opts.importSuccessThenCreds || opts.importError) {
    let imported = false
    provider.import = async () => {
      if (opts.importError) throw opts.importError
      imported = true
      return true as const
    }
    provider.getCredentials = async () => {
      if (imported && opts.importSuccessThenCreds) {
        return opts.importSuccessThenCreds
      }
      if (opts.getCredsError) throw opts.getCredsError
      throw new AuthError({
        code: 'auth_missing',
        provider: 'codex',
        message: 'no token',
      })
    }
  }
  return provider
}

class FakeStderr {
  output = ''
  write(chunk: string): boolean {
    this.output += chunk
    return true
  }
}

beforeEach(() => {
  _resetAuthProviderRegistryForTests()
})

afterEach(() => {
  _resetAuthProviderRegistryForTests()
})

describe('codex/startup: ensureOAuthModelsUsable', () => {
  it('is a no-op when no openai-auth models exist', async () => {
    const config = makeConfig({
      models: {
        sonnet: { endpoint: 'gw', schema: 'anthropic', upstreamModel: 'claude-sonnet-4-6' },
      },
      routing: { main: 'sonnet' },
      model: 'sonnet',
    })
    const stderr = new FakeStderr()
    await ensureOAuthModelsUsable(config, stderr)
    assert.equal(stderr.output, '')
    assert.ok(config.models.sonnet)
  })

  it('does not mutate config when codex credentials work', async () => {
    registerAuthProvider(fakeProvider({
      credentials: { accessToken: 'A', expiresAt: Date.now() + 1e6, accountId: 'acc' },
    }))
    const config = makeConfig()
    const stderr = new FakeStderr()
    await ensureOAuthModelsUsable(config, stderr)
    assert.equal(stderr.output, '')
    assert.ok(config.models['gpt-5-codex'])
    assert.equal(config.routing.extract, 'gpt-5-codex')
  })

  it('disables openai-auth models when refresh fails', async () => {
    registerAuthProvider(fakeProvider({
      getCredsError: new AuthError({
        code: 'refresh_consumed_by_other_client',
        provider: 'codex',
        message: 'rotated by codex CLI',
      }),
    }))
    const config = makeConfig()
    const stderr = new FakeStderr()
    await ensureOAuthModelsUsable(config, stderr)
    // gpt-5-codex removed
    assert.equal(config.models['gpt-5-codex'], undefined)
    // sonnet + gpt-5-mini stay
    assert.ok(config.models.sonnet)
    assert.ok(config.models['gpt-5-mini'])
    // routing.extract was gpt-5-codex -> rewritten to first remaining (sonnet)
    assert.equal(config.routing.extract, 'sonnet')
    // routing.main was sonnet -> unchanged
    assert.equal(config.routing.main, 'sonnet')
    // stderr warning emitted
    assert.match(stderr.output, /Codex OAuth credentials unavailable/)
    assert.match(stderr.output, /rotated by codex CLI/)
    assert.match(stderr.output, /Disabled models.*gpt-5-codex/)
    assert.match(stderr.output, /routing\.extract rewritten: gpt-5-codex -> sonnet/)
  })

  it('falls back to import() when token store is missing', async () => {
    registerAuthProvider(fakeProvider({
      importSuccessThenCreds: { accessToken: 'A', expiresAt: Date.now() + 1e6, accountId: 'acc' },
    }))
    const config = makeConfig()
    const stderr = new FakeStderr()
    await ensureOAuthModelsUsable(config, stderr)
    assert.equal(stderr.output, '')
    // OAuth model still active
    assert.ok(config.models['gpt-5-codex'])
  })

  it('disables when import fails too', async () => {
    registerAuthProvider(fakeProvider({
      importError: new AuthError({
        code: 'auth_missing',
        provider: 'codex',
        message: '~/.codex/auth.json not found',
      }),
    }))
    const config = makeConfig()
    const stderr = new FakeStderr()
    await ensureOAuthModelsUsable(config, stderr)
    assert.equal(config.models['gpt-5-codex'], undefined)
    assert.match(stderr.output, /not found/)
  })

  it('rewrites defaultModel when it points at a disabled model', async () => {
    registerAuthProvider(fakeProvider({
      getCredsError: new AuthError({
        code: 'refresh_failed',
        provider: 'codex',
        message: '500',
      }),
    }))
    const config = makeConfig({
      model: 'gpt-5-codex',
      routing: { main: 'gpt-5-codex' },
    })
    const stderr = new FakeStderr()
    await ensureOAuthModelsUsable(config, stderr)
    // model field rewritten to first remaining (sonnet)
    assert.equal(config.model, 'sonnet')
    assert.equal(config.routing.main, 'sonnet')
    assert.match(stderr.output, /defaultModel rewritten: gpt-5-codex -> sonnet/)
    assert.match(stderr.output, /routing\.main rewritten: gpt-5-codex -> sonnet/)
  })

  it('throws "No models configured" when every model was OAuth and auth fails', async () => {
    registerAuthProvider(fakeProvider({
      getCredsError: new AuthError({
        code: 'refresh_failed',
        provider: 'codex',
        message: 'broken',
      }),
    }))
    const config = makeConfig({
      models: {
        'gpt-5-codex': { endpoint: 'codex', schema: 'openai-auth', upstreamModel: 'gpt-5.5' },
        'gpt-5.4': { endpoint: 'codex', schema: 'openai-auth', upstreamModel: 'gpt-5.4' },
      },
      routing: { main: 'gpt-5-codex' },
      model: 'gpt-5-codex',
    })
    const stderr = new FakeStderr()
    await assert.rejects(
      () => ensureOAuthModelsUsable(config, stderr),
      /No models configured\..*Define endpoints \+ models.*All 2 configured model\(s\) require Codex OAuth.*broken/s,
    )
  })

  it('throws when codex provider is not registered', async () => {
    // Don't register — registry was reset in beforeEach
    const config = makeConfig()
    const stderr = new FakeStderr()
    await ensureOAuthModelsUsable(config, stderr)
    // Should disable the model (provider missing == unable to authenticate).
    assert.equal(config.models['gpt-5-codex'], undefined)
    assert.match(stderr.output, /not registered/)
  })

  it('uses Object.keys insertion order for the fallback', async () => {
    registerAuthProvider(fakeProvider({
      getCredsError: new AuthError({
        code: 'refresh_failed',
        provider: 'codex',
        message: 'x',
      }),
    }))
    const config = makeConfig({
      models: {
        // intentionally NOT alphabetical — first key wins
        'gpt-5-mini': { endpoint: 'gw', schema: 'openai', upstreamModel: 'gpt-5-mini' },
        sonnet: { endpoint: 'gw', schema: 'anthropic', upstreamModel: 'claude' },
        'gpt-5-codex': { endpoint: 'codex', schema: 'openai-auth', upstreamModel: 'gpt-5.5' },
      },
      routing: { main: 'gpt-5-codex' },
      model: 'gpt-5-codex',
    })
    const stderr = new FakeStderr()
    await ensureOAuthModelsUsable(config, stderr)
    // First-key fallback = gpt-5-mini (not sonnet, not alphabetical)
    assert.equal(config.model, 'gpt-5-mini')
    assert.equal(config.routing.main, 'gpt-5-mini')
  })
})

describe('codex/startup: degradeOAuthModels (pure)', () => {
  it('preserves non-routing-related routing keys when none are oauth', () => {
    const config = makeConfig({
      routing: { main: 'sonnet', compact: 'sonnet', extract: 'gpt-5-codex' },
    })
    const out = _internal.degradeOAuthModels(config, ['gpt-5-codex'], 'reason')
    // Only extract should change
    assert.equal(out.routingChanges.length, 1)
    assert.equal(out.routingChanges[0]!.key, 'extract')
    assert.equal(config.routing.compact, 'sonnet')
  })

  it('rewrites every routing.* key that pointed at a disabled model', () => {
    const config = makeConfig({
      models: {
        sonnet: { endpoint: 'gw', schema: 'anthropic', upstreamModel: 'claude' },
        'gpt-5-codex': { endpoint: 'codex', schema: 'openai-auth', upstreamModel: 'gpt-5.5' },
      },
      routing: {
        main: 'gpt-5-codex',
        compact: 'gpt-5-codex',
        extract: 'gpt-5-codex',
        webSearch: 'gpt-5-codex',
      },
      model: 'gpt-5-codex',
    })
    const out = _internal.degradeOAuthModels(config, ['gpt-5-codex'], 'r')
    assert.equal(out.routingChanges.length, 4)
    assert.equal(config.routing.main, 'sonnet')
    assert.equal(config.routing.compact, 'sonnet')
    assert.equal(config.routing.extract, 'sonnet')
    assert.equal(config.routing.webSearch, 'sonnet')
  })
})
