import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  apiKeyBaseUrlCandidates,
  listApiKeyModels,
  listApiKeyModelsResolvingBaseUrl,
  selectApiKeyModelIds,
  type ListModelsHttpFn,
} from './list-models.js'

describe('provider/list-models: selectApiKeyModelIds (pure)', () => {
  it('extracts data[].id preserving order, capped at limit', () => {
    const ids = selectApiKeyModelIds(
      { data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }, { id: 'o3' }] },
      2,
    )
    assert.deepEqual(ids, ['gpt-4o', 'gpt-4o-mini'])
  })

  it('ignores non-string / empty ids and malformed payloads', () => {
    assert.deepEqual(
      selectApiKeyModelIds({ data: [{ id: '' }, { id: 5 }, { id: 'ok' }, {}] }),
      ['ok'],
    )
    assert.deepEqual(selectApiKeyModelIds(null), [])
    assert.deepEqual(selectApiKeyModelIds({ data: 'nope' }), [])
  })
})

describe('provider/list-models: listApiKeyModels', () => {
  it('openai hits <base>/models with a Bearer header', async () => {
    let seen: { url: string; headers: Record<string, string> } | undefined
    const http: ListModelsHttpFn = async input => {
      seen = input
      return { statusCode: 200, bodyText: JSON.stringify({ data: [{ id: 'gpt-4o' }] }) }
    }
    const result = await listApiKeyModels({
      type: 'openai',
      apiKey: 'sk-123',
      baseUrl: 'https://gw.example/v1',
      http,
    })
    assert.deepEqual(result, { ok: true, models: ['gpt-4o'] })
    assert.equal(seen?.url, 'https://gw.example/v1/models')
    assert.equal(seen?.headers.authorization, 'Bearer sk-123')
  })

  it('anthropic hits <base>/v1/models with x-api-key + version headers', async () => {
    let seen: { url: string; headers: Record<string, string> } | undefined
    const http: ListModelsHttpFn = async input => {
      seen = input
      return { statusCode: 200, bodyText: JSON.stringify({ data: [{ id: 'claude-opus-4-8' }] }) }
    }
    const result = await listApiKeyModels({ type: 'anthropic', apiKey: 'sk-ant', http })
    assert.deepEqual(result, { ok: true, models: ['claude-opus-4-8'] })
    assert.equal(seen?.url, 'https://api.anthropic.com/v1/models')
    assert.equal(seen?.headers['x-api-key'], 'sk-ant')
    assert.equal(seen?.headers['anthropic-version'], '2023-06-01')
  })

  it('returns ok:false with the status on a non-2xx', async () => {
    const http: ListModelsHttpFn = async () => ({ statusCode: 401, bodyText: 'bad key' })
    const result = await listApiKeyModels({ type: 'openai', apiKey: 'x', http })
    assert.equal(result.ok, false)
    assert.match((result as { error: string }).error, /401/)
  })

  it('returns ok:false on a transport error', async () => {
    const http: ListModelsHttpFn = async () => {
      throw new Error('ENOTFOUND')
    }
    const result = await listApiKeyModels({ type: 'openai', apiKey: 'x', http })
    assert.deepEqual(result, { ok: false, error: 'ENOTFOUND' })
  })
})

describe('provider/list-models: apiKeyBaseUrlCandidates (/v1 tolerance)', () => {
  it('openai missing /v1 offers the +/v1 form after the as-given one', () => {
    assert.deepEqual(apiKeyBaseUrlCandidates('openai', 'http://h:3888'), [
      'http://h:3888',
      'http://h:3888/v1',
    ])
  })
  it('openai already ending /v1 yields a single candidate', () => {
    assert.deepEqual(apiKeyBaseUrlCandidates('openai', 'http://h:3888/v1'), ['http://h:3888/v1'])
  })
  it('anthropic ending /v1 offers the stripped form after the as-given one', () => {
    assert.deepEqual(apiKeyBaseUrlCandidates('anthropic', 'http://h:3888/v1'), [
      'http://h:3888/v1',
      'http://h:3888',
    ])
  })
  it('anthropic without /v1 yields a single candidate', () => {
    assert.deepEqual(apiKeyBaseUrlCandidates('anthropic', 'http://h:3888'), ['http://h:3888'])
  })
  it('trailing slashes are normalized; undefined base stays undefined', () => {
    assert.deepEqual(apiKeyBaseUrlCandidates('openai', 'http://h:3888/'), [
      'http://h:3888',
      'http://h:3888/v1',
    ])
    assert.deepEqual(apiKeyBaseUrlCandidates('openai', undefined), [undefined])
  })
})

describe('provider/list-models: listApiKeyModelsResolvingBaseUrl', () => {
  it('openai base missing /v1: probes /models (HTML), then /v1/models, persisting the /v1 base', async () => {
    const seen: string[] = []
    const http: ListModelsHttpFn = async ({ url }) => {
      seen.push(url)
      // The bare /models path serves the gateway web UI (200 HTML, not JSON).
      if (url === 'http://gw:3888/models') return { statusCode: 200, bodyText: '<!doctype html>' }
      if (url === 'http://gw:3888/v1/models') {
        return { statusCode: 200, bodyText: JSON.stringify({ data: [{ id: 'gpt-5.5' }] }) }
      }
      return { statusCode: 404, bodyText: 'nope' }
    }
    const result = await listApiKeyModelsResolvingBaseUrl({
      type: 'openai',
      apiKey: 'sk',
      baseUrl: 'http://gw:3888',
      http,
    })
    assert.deepEqual(result, { ok: true, models: ['gpt-5.5'], resolvedBaseUrl: 'http://gw:3888/v1' })
    assert.deepEqual(seen, ['http://gw:3888/models', 'http://gw:3888/v1/models'])
  })

  it('openai base already /v1: single probe, resolvedBaseUrl is the as-given base', async () => {
    const http: ListModelsHttpFn = async () => ({
      statusCode: 200,
      bodyText: JSON.stringify({ data: [{ id: 'gpt-5.5' }] }),
    })
    const result = await listApiKeyModelsResolvingBaseUrl({
      type: 'openai',
      apiKey: 'sk',
      baseUrl: 'http://gw:3888/v1',
      http,
    })
    assert.deepEqual(result, { ok: true, models: ['gpt-5.5'], resolvedBaseUrl: 'http://gw:3888/v1' })
  })

  it('anthropic base wrongly ending /v1: falls back to the stripped base', async () => {
    const http: ListModelsHttpFn = async ({ url }) => {
      // The probe appends /v1/models; the /v1/v1 path 404s, the stripped one works.
      if (url === 'http://gw:3888/v1/v1/models') return { statusCode: 404, bodyText: 'no' }
      if (url === 'http://gw:3888/v1/models') {
        return { statusCode: 200, bodyText: JSON.stringify({ data: [{ id: 'claude-opus-4-8' }] }) }
      }
      return { statusCode: 500, bodyText: 'x' }
    }
    const result = await listApiKeyModelsResolvingBaseUrl({
      type: 'anthropic',
      apiKey: 'sk',
      baseUrl: 'http://gw:3888/v1',
      http,
    })
    assert.deepEqual(result, {
      ok: true,
      models: ['claude-opus-4-8'],
      resolvedBaseUrl: 'http://gw:3888',
    })
  })

  it('all candidates unreachable: returns the first error', async () => {
    const http: ListModelsHttpFn = async () => ({ statusCode: 401, bodyText: 'bad key' })
    const result = await listApiKeyModelsResolvingBaseUrl({
      type: 'openai',
      apiKey: 'sk',
      baseUrl: 'http://gw:3888',
      http,
    })
    assert.equal(result.ok, false)
    assert.match((result as { error: string }).error, /401/)
  })
})
