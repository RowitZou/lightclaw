import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import type { LightClawConfig } from '../config.js'
import { setLang } from '../i18n/index.js'
import { setLightclawHomeOverride } from '../paths.js'
import { createBuiltinReplRegistry } from './builtin.js'
import { runAdminCommand } from './admin.js'

let tmpHome = ''

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-admin-command-'))
  setLightclawHomeOverride(tmpHome)
  setLang('en')
})

afterEach(() => {
  setLang('cn')
  setLightclawHomeOverride(undefined)
  rmSync(tmpHome, { recursive: true, force: true })
})

function configPath(): string {
  return path.join(tmpHome, 'config.json')
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath(), 'utf8')) as Record<string, unknown>
}

/** Minimal live config object. The admin write paths mutate this in place after
 *  a successful disk write (refreshLiveConfig), and re-read the file via
 *  getConfig() — so the live object only needs the fields the handlers touch. */
function liveConfig(): LightClawConfig {
  return {
    runtime: { backend: 'local', dockerSettings: {}, driver: null } as unknown,
    permissionCeiling: 'bypassPermissions',
    permissionMode: 'default',
    lang: 'en',
    defaultModel: '',
    lane: {},
    endpoints: {},
    models: {},
  } as unknown as LightClawConfig
}

describe('/admin endpoint add (system-scope write-back)', () => {
  it('writes endpoints[ep] to <home>/config.json with the raw apiKey', async () => {
    const cfg = liveConfig()
    const out = await runAdminCommand('endpoint add ep --type anthropic --key K', {
      config: cfg,
      userId: 'admin',
    })
    assert.match(out, /Added deployment endpoint "ep"/)
    const persisted = readConfig()
    const endpoints = persisted.endpoints as Record<string, { apiKey?: string; type?: string }>
    assert.equal(endpoints.ep!.apiKey, 'K')
    // Live config refreshed without restart: resolveEndpoints drops `type` and
    // keeps apiKey — the live endpoint must reflect the new alias.
    assert.ok(cfg.endpoints['ep'], 'live config endpoints should include the new alias')
  })

  it('preserves UNKNOWN sibling keys across the write', async () => {
    // Pre-seed config.json with keys the writer must round-trip verbatim, plus
    // a pre-existing valid endpoint so the candidate stays boot-valid.
    writeFileSync(configPath(), JSON.stringify({
      keepMe: 42,
      nested: { a: 1 },
      endpoints: { existing: { apiKey: 'X' } },
    }), 'utf8')

    await runAdminCommand('endpoint add ep --type openai --key K', {
      config: liveConfig(),
      userId: 'admin',
    })
    const persisted = readConfig()
    assert.equal(persisted.keepMe, 42)
    assert.deepEqual(persisted.nested, { a: 1 })
    const endpoints = persisted.endpoints as Record<string, unknown>
    assert.ok(endpoints.existing, 'pre-existing endpoint must survive')
    assert.ok(endpoints.ep, 'new endpoint must be added')
  })

  it('refuses a pre-existing corrupt / non-object config (no write)', async () => {
    // A non-object top-level config: readJsonObjectOrEmpty refuses to auto-write.
    writeFileSync(configPath(), JSON.stringify(['not', 'an', 'object']), 'utf8')
    const before = readFileSync(configPath(), 'utf8')
    const out = await runAdminCommand('endpoint add ep --type anthropic --key K', {
      config: liveConfig(),
      userId: 'admin',
    })
    assert.match(out, /Error/)
    // File unchanged — the corrupt config was not overwritten.
    assert.equal(readFileSync(configPath(), 'utf8'), before)
  })
})

describe('/admin lane (system-scope write-back)', () => {
  it('set worker <model> writes config.lane.worker and reflects in live config', async () => {
    // Seed a model so lane validation has a real registry (lane validation is
    // lenient anyway, but the candidate must still be boot-valid).
    writeFileSync(configPath(), JSON.stringify({
      endpoints: { ep: { apiKey: 'K' } },
      models: { m: { endpoint: 'ep', schema: 'openai', upstreamModel: 'gpt' } },
    }), 'utf8')

    const cfg = liveConfig()
    const out = await runAdminCommand('lane set worker m', { config: cfg, userId: 'admin' })
    assert.match(out, /lane\.worker = m/)
    const persisted = readConfig()
    assert.deepEqual(persisted.lane, { worker: 'm' })
    assert.equal(cfg.lane.worker, 'm', 'live config lane should reflect the write')
  })

  it('reset worker deletes the bucket', async () => {
    writeFileSync(configPath(), JSON.stringify({
      endpoints: { ep: { apiKey: 'K' } },
      models: { m: { endpoint: 'ep', schema: 'openai', upstreamModel: 'gpt' } },
      lane: { worker: 'm', system: 'm' },
    }), 'utf8')

    await runAdminCommand('lane reset worker', { config: liveConfig(), userId: 'admin' })
    const persisted = readConfig()
    assert.deepEqual(persisted.lane, { system: 'm' })
  })

  it('set worker with empty model deletes the bucket (empty = unset)', async () => {
    writeFileSync(configPath(), JSON.stringify({
      endpoints: { ep: { apiKey: 'K' } },
      models: { m: { endpoint: 'ep', schema: 'openai', upstreamModel: 'gpt' } },
      lane: { worker: 'm' },
    }), 'utf8')
    // `lane set worker` with no model arg → unset the bucket.
    await runAdminCommand('lane set worker', { config: liveConfig(), userId: 'admin' })
    const persisted = readConfig()
    assert.equal('lane' in persisted, false, 'empty-only lane object should be removed')
  })
})

describe('/admin backend add (system-scope write-back)', () => {
  it('writes the model + deployment defaultModel with --default', async () => {
    writeFileSync(configPath(), JSON.stringify({
      endpoints: { ep: { apiKey: 'K' } },
    }), 'utf8')

    const cfg = liveConfig()
    const out = await runAdminCommand('backend add m --endpoint ep --default', {
      config: cfg,
      userId: 'admin',
    })
    assert.match(out, /Registered model "m"/)
    const persisted = readConfig()
    const models = persisted.models as Record<string, { endpoint?: string; schema?: string; upstreamModel?: string }>
    assert.equal(models.m!.endpoint, 'ep')
    assert.equal(models.m!.schema, 'openai')
    assert.equal(models.m!.upstreamModel, 'm')
    assert.equal(persisted.defaultModel, 'm')
    assert.equal(cfg.defaultModel, 'm', 'live config defaultModel should reflect the write')
  })

  it('rejects backend add referencing a missing endpoint (no write)', async () => {
    writeFileSync(configPath(), JSON.stringify({ keepMe: 1 }), 'utf8')
    const out = await runAdminCommand('backend add m --endpoint nope', {
      config: liveConfig(),
      userId: 'admin',
    })
    assert.match(out, /endpoint "nope"/)
    const persisted = readConfig()
    assert.equal('models' in persisted, false, 'no model should be written')
    assert.equal(persisted.keepMe, 1)
  })
})

describe('write-back validation (boot safety)', () => {
  it('aborts a write that would produce a schema-invalid config (no file mutation)', async () => {
    // Seed a model whose endpoint exists. Then `endpoint rm ep` would cascade
    // the model too (kept consistent). To force a VALIDATION failure instead,
    // hand-craft a config where a model references a non-existent endpoint, then
    // attempt a lane write — commitAdminConfig re-validates the WHOLE object and
    // must refuse because the dangling model reference is boot-fatal.
    const corruptButObject = {
      endpoints: { ep: { apiKey: 'K' } },
      models: { bad: { endpoint: 'ghost', schema: 'openai', upstreamModel: 'x' } },
    }
    writeFileSync(configPath(), JSON.stringify(corruptButObject), 'utf8')
    const before = readFileSync(configPath(), 'utf8')

    const out = await runAdminCommand('lane set worker bad', { config: liveConfig(), userId: 'admin' })
    assert.match(out, /fail boot validation|not written/i)
    // File must be byte-identical — the bad candidate was refused before write.
    assert.equal(readFileSync(configPath(), 'utf8'), before)
  })
})

describe('/admin registration + gating', () => {
  it('rejects a non-admin caller for /admin and a write noun', async () => {
    const registry = createBuiltinReplRegistry()
    const chunks: string[] = []
    const ctxBase = {
      config: liveConfig(),
      sessionId: 's',
      createdAt: Date.now(),
      messages: [],
      output: { write: (s: string) => { chunks.push(s); return true } } as unknown as NodeJS.WritableStream,
      userId: 'bob',
      isAdmin: false,
      getActiveTools: () => [],
      setActiveTools: () => {},
      persistMeta: async () => {},
    }
    // Bare /admin → adminOnly rejection.
    await registry.dispatch('/admin', ctxBase as never)
    assert.match(chunks.join(''), /admin-only/)
    // A write noun → still rejected at the registry gate (handler never runs).
    chunks.length = 0
    await registry.dispatch('/admin endpoint add ep --type anthropic --key K', ctxBase as never)
    assert.match(chunks.join(''), /admin-only/)
    // No config.json should have been written by the rejected handler.
    assert.equal(existsSyncSafe(configPath()), false)
  })
})

function existsSyncSafe(p: string): boolean {
  try {
    readFileSync(p)
    return true
  } catch {
    return false
  }
}

describe('/admin pairing == old /user (shared function)', () => {
  it('approve <code> yields the same output as /user approve <code>', async () => {
    const { runUserCommand } = await import('./builtin.js')
    // No pending.json on a fresh home → both report the same no-such-code error
    // because /admin pairing approve delegates to runUserCommand('approve ...').
    const viaAdmin = await runAdminCommand('pairing approve ZZ9', { config: liveConfig(), userId: 'admin' })
    const viaUser = await runUserCommand('approve ZZ9')
    assert.equal(viaAdmin, viaUser)
    assert.match(viaAdmin, /ZZ9/)
  })

  it('bare pairing lists pending (same as /user pending)', async () => {
    const { runUserCommand } = await import('./builtin.js')
    const viaAdmin = await runAdminCommand('pairing', { config: liveConfig(), userId: 'admin' })
    const viaUser = await runUserCommand('pending')
    assert.equal(viaAdmin, viaUser)
  })
})

describe('/admin sandbox status fast-path regex', () => {
  it('the runtime-acquire regex matches both /sandbox and /admin sandbox', () => {
    // Mirror of runner.ts:runReadSlashFastPath's sandboxNeedsRuntime condition.
    const matches = (text: string): boolean =>
      /^\/sandbox(?:\s|$)/.test(text.trimStart()) ||
      /^\/admin\s+sandbox(?:\s|$)/.test(text.trimStart())
    assert.equal(matches('/sandbox status'), true)
    assert.equal(matches('/admin sandbox status'), true)
    assert.equal(matches('/admin sandbox'), true)
    assert.equal(matches('/admin backend'), false)
    assert.equal(matches('/adminsandbox'), false)
  })
})
