import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  listApiKeyModels,
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
