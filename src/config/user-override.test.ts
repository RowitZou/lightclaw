import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { emptyInvocationContext } from '../agents/invocation-context.js'
import { getMainRole } from '../agents/registry.js'
import type { LightClawConfig } from '../config.js'
import { createUser } from '../identity/store.js'
import { createUserMessage } from '../messages.js'
import { setLightclawHomeOverride } from '../paths.js'
import { _resetProviderCacheForTests, getProviderFor } from '../provider/index.js'
import { query } from '../query.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'
import { setUserSecret } from '../secrets/store.js'
import { createBuiltinReplRegistry } from '../commands/builtin.js'
import type { ReplContext } from '../commands/registry.js'

import {
  loadUserConfigOverride,
  resolveUserConfig,
  setUserConfigOverrideField,
  userConfigOverridePath,
  writeUserConfigOverride,
} from './user-override.js'

let home = ''

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'lightclaw-user-config-'))
  setLightclawHomeOverride(home)
  writeHomeConfig()
})

afterEach(() => {
  _resetProviderCacheForTests()
  setLightclawHomeOverride(undefined)
  rmSync(home, { recursive: true, force: true })
})

describe('UserConfigOverride', () => {
  it('overrides only user-owned scalar fields without inheriting global models', () => {
    writeUserConfigOverride('alice', {
      defaultModel: 'other',
      lang: 'en',
      permissionMode: 'bypassPermissions',
    })

    const resolved = resolveUserConfig('alice', baseConfig())

    assert.equal(resolved.defaultModel, '')
    assert.equal(resolved.lang, 'en')
    assert.equal(resolved.permissionMode, 'bypassPermissions')
    assert.equal(resolved.models.fake, undefined)
    assert.equal(resolved.models.other, undefined)
    assert.deepEqual(resolved.endpoints, {})
  })

  it('rejects unknown fields and falls back to an empty user model config', () => {
    const target = userConfigOverridePath('alice')
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, JSON.stringify({ defaultModel: 'other', runtime: { backend: 'local' } }))

    const resolved = resolveUserConfig('alice', baseConfig())

    assert.equal(resolved.defaultModel, '')
    assert.deepEqual(resolved.models, {})
    assert.equal(loadUserConfigOverride('alice').ok, false)
  })

  it('rejects defaultModel values outside the user model set', () => {
    writeUserConfigOverride('alice', { defaultModel: 'missing' })

    const resolved = resolveUserConfig('alice', baseConfig())

    assert.equal(resolved.defaultModel, '')
  })

  it('does not inherit global models for ordinary users by default', () => {
    const config = baseConfig()
    const resolved = resolveUserConfig('alice', config)

    assert.equal(resolved.defaultModel, '')
    assert.equal(resolved.models.fake, undefined)
    assert.equal(resolved.models.other, undefined)
    assert.equal(resolved.endpoints.fake, undefined)
  })

  it('hides global models from /model output', async () => {
    await createUser('alice')

    const output = await runSlashCommands('/model')

    assert.match(output, /当前模型：\(none\)|current model: \(none\)/)
    assert.match(output, /configure a custom model/)
    assert.doesNotMatch(output, /other \(anthropic, fake -> other\)/)
    assert.doesNotMatch(output, /fake \(anthropic, fake -> fake\)/)
  })

  it('returns a setup prompt instead of using a legacy global default when no user model is visible', async () => {
    const config = resolveUserConfig('alice', {
      ...baseConfig(),
      models: {
        fake: baseConfig().models.fake,
      },
    })
    const session = createSessionContext({
      config,
      cwd: path.join(home, 'workspace'),
      model: config.defaultModel,
      sessionsDir: path.join(home, 'sessions'),
      memoryDir: path.join(home, 'memory'),
      currentUserId: 'alice',
      sessionId: 's-no-visible-model',
      permissionCeiling: 'bypassPermissions',
    })

    await runWithSessionContext(session, async () => {
      const result = await query({
        role: getMainRole(),
        invocation: emptyInvocationContext(),
        messages: [createUserMessage('hi')],
        tools: [],
        config,
      })

      assert.match(result.assistantText, /当前用户还没有可用模型/)
      assert.equal(result.stopReason, 'end_turn')
    })
  })

  it('lets /model and /mode persist into users/<u>/config.json', async () => {
    await createUser('alice')
    setUserSecret('alice', 'OPENAI_KEY', 'sk-user-secret')
    writeUserConfigOverride('alice', {
      endpoints: {
        myopenai: {
          baseUrl: 'https://api.example.test/v1',
          apiKeyRef: 'OPENAI_KEY',
        },
      },
      models: {
        'my-gpt': {
          endpoint: 'myopenai',
          schema: 'openai',
          upstreamModel: 'gpt-user',
        },
      },
    })
    const output = await runSlashCommands('/model my-gpt', '/mode yolo')

    assert.match(output, /model: my-gpt|已切换模型/)
    const loaded = loadUserConfigOverride('alice')
    assert.equal(loaded.ok, true)
    assert.equal(loaded.ok ? loaded.value.defaultModel : undefined, 'my-gpt')
    assert.equal(loaded.ok ? loaded.value.permissionMode : undefined, 'bypassPermissions')
  })

  it('lets /model proxy persist and clear the current model endpoint proxy', async () => {
    await createUser('alice')
    setUserSecret('alice', 'OPENAI_KEY', 'sk-user-secret')
    writeUserConfigOverride('alice', {
      endpoints: {
        myopenai: {
          baseUrl: 'https://api.example.test/v1',
          apiKeyRef: 'OPENAI_KEY',
        },
      },
      models: {
        'my-gpt': {
          endpoint: 'myopenai',
          schema: 'openai',
          upstreamModel: 'gpt-user',
        },
      },
      defaultModel: 'my-gpt',
    })

    const showBefore = await runSlashCommands('/model proxy')
    assert.match(showBefore, /model=my-gpt/)
    assert.match(showBefore, /endpoint=myopenai/)
    assert.match(showBefore, /proxy=\(none\)/)

    const setOutput = await runSlashCommands('/model proxy http://proxy.example:8080')
    assert.match(setOutput, /Updated proxy for model "my-gpt" endpoint "myopenai": \(set\)/)
    let loaded = loadUserConfigOverride('alice')
    assert.equal(loaded.ok ? loaded.value.endpoints?.myopenai?.proxy : undefined, 'http://proxy.example:8080')

    const markdownSetOutput = await runSlashCommands('/model proxy [http://proxy.example:9090](http://proxy.example:9090/)')
    assert.match(markdownSetOutput, /Updated proxy for model "my-gpt" endpoint "myopenai": \(set\)/)
    loaded = loadUserConfigOverride('alice')
    assert.equal(loaded.ok ? loaded.value.endpoints?.myopenai?.proxy : undefined, 'http://proxy.example:9090')

    const clearOutput = await runSlashCommands('/model proxy -')
    assert.match(clearOutput, /Cleared proxy for model "my-gpt" endpoint "myopenai": \(none\)/)
    loaded = loadUserConfigOverride('alice')
    assert.equal(loaded.ok ? loaded.value.endpoints?.myopenai?.proxy : undefined, undefined)
  })

  it('rejects invalid /model proxy values instead of silently falling back to direct', async () => {
    await createUser('alice')
    setUserSecret('alice', 'OPENAI_KEY', 'sk-user-secret')
    writeUserConfigOverride('alice', {
      endpoints: {
        myopenai: {
          apiKeyRef: 'OPENAI_KEY',
        },
      },
      models: {
        'my-gpt': {
          endpoint: 'myopenai',
          schema: 'openai',
          upstreamModel: 'gpt-user',
        },
      },
      defaultModel: 'my-gpt',
    })

    const output = await runSlashCommands('/model proxy [http://proxy.example:8080](not-a-url)')
    const loaded = loadUserConfigOverride('alice')

    assert.match(output, /proxy must be a valid http\(s\) URL/)
    assert.equal(loaded.ok ? loaded.value.endpoints?.myopenai?.proxy : undefined, undefined)
  })

  it('setUserConfigOverrideField preserves existing fields', () => {
    setUserConfigOverrideField({ canonicalUser: 'alice', key: 'defaultModel', value: 'other' })
    setUserConfigOverrideField({ canonicalUser: 'alice', key: 'permissionMode', value: 'plan' })

    const loaded = loadUserConfigOverride('alice')

    assert.equal(loaded.ok, true)
    assert.deepEqual(loaded.ok ? loaded.value : undefined, {
      defaultModel: 'other',
      permissionMode: 'plan',
    })
  })

  it('merges user custom endpoints and models through apiKeyRef without persisting the key in config', () => {
    setUserSecret('alice', 'OPENAI_KEY', 'sk-user-secret')
    writeUserConfigOverride('alice', {
      endpoints: {
        myopenai: {
          baseUrl: 'https://api.example.test/v1',
          proxy: '[http://proxy.example:8080](http://proxy.example:8080/)',
          apiKeyRef: 'OPENAI_KEY',
        },
      },
      models: {
        'my-gpt': {
          endpoint: 'myopenai',
          schema: 'openai',
          upstreamModel: 'gpt-user',
        },
      },
      defaultModel: 'my-gpt',
    })

    const resolved = resolveUserConfig('alice', baseConfig())

    assert.equal(resolved.defaultModel, 'my-gpt')
    assert.deepEqual(resolved.models['my-gpt'], {
      endpoint: 'myopenai',
      schema: 'openai',
      upstreamModel: 'gpt-user',
      visibility: 'user',
    })
    const endpoint = resolved.endpoints.myopenai
    assert.ok(endpoint && !('auth' in endpoint))
    assert.equal(endpoint.apiKey, 'sk-user-secret')
    assert.equal(endpoint.proxy, 'http://proxy.example:8080')
    assert.equal(endpoint.credentialIdentity, 'user:alice:secret:OPENAI_KEY')
    assert.doesNotMatch(readFileSync(userConfigOverridePath('alice'), 'utf8'), /sk-user-secret/)
  })

  it('allows custom model aliases to shadow legacy global model aliases', () => {
    setUserSecret('alice', 'OPENAI_KEY', 'sk-user-secret')
    writeUserConfigOverride('alice', {
      endpoints: {
        myopenai: {
          apiKeyRef: 'OPENAI_KEY',
        },
      },
      models: {
        fake: {
          endpoint: 'myopenai',
          schema: 'openai',
          upstreamModel: 'gpt-user',
        },
      },
      defaultModel: 'fake',
    })

    const resolved = resolveUserConfig('alice', baseConfig())

    assert.equal(resolved.defaultModel, 'fake')
    assert.deepEqual(resolved.models.fake, {
      endpoint: 'myopenai',
      schema: 'openai',
      upstreamModel: 'gpt-user',
      visibility: 'user',
    })
  })

  it('allows user endpoint aliases to shadow legacy global endpoint aliases', () => {
    setUserSecret('alice', 'OPENAI_KEY', 'sk-user-secret')
    writeUserConfigOverride('alice', {
      endpoints: {
        fake: {
          apiKeyRef: 'OPENAI_KEY',
        },
      },
      models: {
        'my-gpt': {
          endpoint: 'fake',
          schema: 'openai',
          upstreamModel: 'gpt-user',
        },
      },
    })

    const resolved = resolveUserConfig('alice', baseConfig())

    assert.equal(resolved.models['my-gpt']?.visibility, 'user')
    assert.equal(resolved.endpoints.fake && 'apiKey' in resolved.endpoints.fake, true)
    assert.equal(resolved.endpoints.fake && 'credentialIdentity' in resolved.endpoints.fake, true)
    assert.equal(resolved.models.other, undefined)
  })

  it('keeps provider cache entries separate for same user endpoint alias with different credentials', () => {
    setUserSecret('alice', 'OPENAI_KEY', 'sk-alice')
    setUserSecret('bob', 'OPENAI_KEY', 'sk-bob')
    const override = {
      endpoints: {
        myopenai: {
          baseUrl: 'https://api.example.test/v1',
          apiKeyRef: 'OPENAI_KEY',
        },
      },
      models: {
        'my-gpt': {
          endpoint: 'myopenai',
          schema: 'openai' as const,
          upstreamModel: 'gpt-user',
        },
      },
      defaultModel: 'my-gpt',
    }
    writeUserConfigOverride('alice', override)
    writeUserConfigOverride('bob', override)

    const aliceProvider = getProviderFor(resolveUserConfig('alice', baseConfig()), 'my-gpt').provider
    const bobProvider = getProviderFor(resolveUserConfig('bob', baseConfig()), 'my-gpt').provider

    assert.notEqual(aliceProvider, bobProvider)
  })

  it('lets /endpoint and /model custom create a user model and /config show reports only refs', async () => {
    await createUser('alice')
    setUserSecret('alice', 'OPENAI_KEY', 'sk-user-secret')

    const output = await runSlashCommands(
      '/endpoint add-key myopenai OPENAI_KEY --base-url https://api.example.test/v1',
      '/model custom add my-gpt openai myopenai gpt-user --reasoning xhigh --max-output-tokens 123 --timeout-ms 1',
      '/model custom add fake openai myopenai gpt-user --timeout-ms 1',
      '/model custom templates',
      '/config show',
    )
    const loaded = loadUserConfigOverride('alice')

    assert.match(output, /Added custom endpoint "myopenai"/)
    assert.match(output, /Added custom model "my-gpt"/)
    assert.match(output, /Added custom model "fake"/)
    assert.match(output, /Model check: /)
    assert.match(output, /none\s*\|\s*minimal\s*\|\s*low\s*\|\s*medium\s*\|\s*high\s*\|\s*xhigh/)
    assert.match(output, /apiKeyRef=OPENAI_KEY/)
    assert.doesNotMatch(output, /sk-user-secret/)
    assert.equal(loaded.ok, true)
    assert.equal(loaded.ok ? loaded.value.models?.['my-gpt']?.upstreamModel : undefined, 'gpt-user')
    assert.equal(loaded.ok ? loaded.value.models?.['my-gpt']?.reasoningEffort : undefined, 'xhigh')
    assert.equal(loaded.ok ? loaded.value.models?.['my-gpt']?.maxOutputTokens : undefined, 123)
    assert.equal(loaded.ok ? loaded.value.models?.fake?.upstreamModel : undefined, 'gpt-user')
    assert.equal(loaded.ok ? loaded.value.endpoints?.myopenai?.apiKeyRef : undefined, 'OPENAI_KEY')
  })

  it('normalizes markdown proxy links through /endpoint add and set', async () => {
    await createUser('alice')
    setUserSecret('alice', 'OPENAI_KEY', 'sk-user-secret')

    const output = await runSlashCommands(
      '/endpoint add-key myopenai OPENAI_KEY --proxy [http://proxy.example:8080](http://proxy.example:8080/)',
      '/endpoint set myopenai --proxy [https://proxy.example:9443](https://proxy.example:9443/)',
    )
    const loaded = loadUserConfigOverride('alice')

    assert.match(output, /Added custom endpoint "myopenai"/)
    assert.match(output, /Updated custom endpoint "myopenai"/)
    assert.equal(loaded.ok ? loaded.value.endpoints?.myopenai?.proxy : undefined, 'https://proxy.example:9443')
  })
})

async function runSlashCommands(...commands: string[]): Promise<string> {
  const chunks: string[] = []
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk))
      callback()
    },
  })
  const config = resolveUserConfig('alice', baseConfig())
  const session = createSessionContext({
    config,
    cwd: path.join(home, 'workspace'),
    model: config.defaultModel,
    sessionsDir: path.join(home, 'sessions'),
    memoryDir: path.join(home, 'memory'),
    currentUserId: 'alice',
    sessionId: 's-user-config',
    permissionCeiling: 'bypassPermissions',
  })
  await runWithSessionContext(session, async () => {
    const registry = createBuiltinReplRegistry()
    for (const command of commands) {
      await registry.dispatch(command, {
        config: session.config!,
        sessionId: session.sessionId,
        createdAt: Date.now(),
        messages: [],
        output,
        userId: 'alice',
        isAdmin: false,
        isChannel: true,
        getActiveTools: () => [],
        setActiveTools() {},
        async persistMeta() {},
      } satisfies ReplContext)
    }
  })
  return chunks.join('')
}

function writeHomeConfig(): void {
  writeFileSync(path.join(home, 'config.json'), JSON.stringify(baseConfig()))
}

function baseConfig(): LightClawConfig {
  return {
    lang: 'cn',
    defaultModel: 'fake',
    endpoints: { fake: { apiKey: 'sk-fake' } },
    models: {
      fake: { endpoint: 'fake', schema: 'anthropic', upstreamModel: 'fake' },
      other: { endpoint: 'fake', schema: 'anthropic', upstreamModel: 'other', visibility: 'public' },
    },
    permissionMode: 'default',
    permissionCeiling: 'bypassPermissions',
    paths: { permissionRules: {} },
    runtime: { backend: 'local' },
  } as unknown as LightClawConfig
}
