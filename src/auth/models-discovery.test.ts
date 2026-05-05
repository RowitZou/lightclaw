import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  discoverDefaultCodexSlug,
  selectDefaultCodexSlug,
  type ModelsHttpFn,
} from './codex/models.js'

describe('codex/models: selectDefaultCodexSlug (pure)', () => {
  it('picks the lowest-priority slug', () => {
    const slug = selectDefaultCodexSlug({
      models: [
        { slug: 'gpt-5.2', priority: 10, supported_in_api: true, visibility: 'list' },
        { slug: 'gpt-5.5', priority: 0, supported_in_api: true, visibility: 'list' },
        { slug: 'gpt-5.4', priority: 2, supported_in_api: true, visibility: 'list' },
      ],
    })
    assert.equal(slug, 'gpt-5.5')
  })

  it('skips supported_in_api=false', () => {
    const slug = selectDefaultCodexSlug({
      models: [
        { slug: 'gpt-5.5-preview', priority: 0, supported_in_api: false, visibility: 'list' },
        { slug: 'gpt-5.4', priority: 2, supported_in_api: true, visibility: 'list' },
      ],
    })
    assert.equal(slug, 'gpt-5.4')
  })

  it('skips visibility=hide / hidden', () => {
    const slug = selectDefaultCodexSlug({
      models: [
        { slug: 'codex-auto-review', priority: 0, supported_in_api: true, visibility: 'hide' },
        { slug: 'gpt-5.5', priority: 0, supported_in_api: true, visibility: 'list' },
      ],
    })
    assert.equal(slug, 'gpt-5.5')
  })

  it('falls back to slug ordering on priority tie', () => {
    const slug = selectDefaultCodexSlug({
      models: [
        { slug: 'gpt-5.5', priority: 0 },
        { slug: 'codex-auto-review', priority: 0 },
      ],
    })
    // alphabetical: codex-auto-review < gpt-5.5
    assert.equal(slug, 'codex-auto-review')
  })

  it('handles missing priority by deprioritizing', () => {
    const slug = selectDefaultCodexSlug({
      models: [
        { slug: 'old-no-priority' },
        { slug: 'gpt-5.5', priority: 0 },
      ],
    })
    assert.equal(slug, 'gpt-5.5')
  })

  it('returns null for empty list / missing models field / non-object', () => {
    assert.equal(selectDefaultCodexSlug({ models: [] }), null)
    assert.equal(selectDefaultCodexSlug({}), null)
    assert.equal(selectDefaultCodexSlug(null), null)
    assert.equal(selectDefaultCodexSlug('nope'), null)
  })

  it('skips entries without a string slug', () => {
    const slug = selectDefaultCodexSlug({
      models: [
        { priority: 0 }, // missing slug
        { slug: '', priority: 1 }, // empty slug
        { slug: 'gpt-5.5', priority: 2 },
      ],
    })
    assert.equal(slug, 'gpt-5.5')
  })
})

describe('codex/models: discoverDefaultCodexSlug', () => {
  const fakeCreds = {
    accessToken: 'access',
    expiresAt: Date.now() + 3600_000,
    accountId: 'acc-1',
  }

  it('returns the discovered slug on 200', async () => {
    const http: ModelsHttpFn = async ({ url, headers }) => {
      assert.match(url, /\/models\?client_version=1\.0\.0$/)
      assert.equal(headers.authorization, 'Bearer access')
      assert.equal(headers['chatgpt-account-id'], 'acc-1')
      return {
        statusCode: 200,
        bodyText: JSON.stringify({
          models: [
            { slug: 'gpt-5.5', priority: 0, supported_in_api: true, visibility: 'list' },
          ],
        }),
      }
    }
    const slug = await discoverDefaultCodexSlug(fakeCreds, { http })
    assert.equal(slug, 'gpt-5.5')
  })

  it('returns null on non-200', async () => {
    const http: ModelsHttpFn = async () => ({
      statusCode: 500,
      bodyText: 'Server error',
    })
    const slug = await discoverDefaultCodexSlug(fakeCreds, { http })
    assert.equal(slug, null)
  })

  it('returns null on non-JSON body', async () => {
    const http: ModelsHttpFn = async () => ({
      statusCode: 200,
      bodyText: 'not json',
    })
    const slug = await discoverDefaultCodexSlug(fakeCreds, { http })
    assert.equal(slug, null)
  })

  it('returns null when fetch throws', async () => {
    const http: ModelsHttpFn = async () => {
      throw new Error('boom')
    }
    const slug = await discoverDefaultCodexSlug(fakeCreds, { http })
    assert.equal(slug, null)
  })

  it('omits chatgpt-account-id header when accountId is empty', async () => {
    let sawHeader: string | undefined
    const http: ModelsHttpFn = async ({ headers }) => {
      sawHeader = headers['chatgpt-account-id']
      return {
        statusCode: 200,
        bodyText: JSON.stringify({ models: [{ slug: 'x', priority: 0 }] }),
      }
    }
    await discoverDefaultCodexSlug(
      { ...fakeCreds, accountId: '' },
      { http },
    )
    assert.equal(sawHeader, undefined)
  })

  it('honors a custom baseUrl', async () => {
    let sawUrl: string | undefined
    const http: ModelsHttpFn = async ({ url }) => {
      sawUrl = url
      return { statusCode: 200, bodyText: '{}' }
    }
    await discoverDefaultCodexSlug(fakeCreds, {
      http,
      baseUrl: 'https://my-mirror/codex/',
    })
    assert.equal(sawUrl, 'https://my-mirror/codex/models?client_version=1.0.0')
  })
})
