import { after, afterEach, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'

import { AuthError, type AuthCredentials } from '../auth/index.js'
import { createCodexAuthProvider, type StoredCodexTokens } from '../auth/codex/provider.js'
import {
  _setCodexRevocationNoticeDeliveryForTests,
  clearCodexRevocationNotice,
  reportCodexCredentialRevoked,
  type CodexRevocationNoticeInput,
} from '../auth/codex/revocation-notice.js'
import { setLightclawHomeOverride } from '../paths.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'
import { isTransientError } from '../transient-error.js'
import type { StreamEvent } from '../types.js'
import { createOpenAIAuthProvider } from './openai-auth.js'

// Regression suite for the 2026-06-30 prod incident (log_record 2026-07-02
// §1.3): another client rotated the Codex refresh-token family, the daemon's
// cached access token was revoked SERVER-side while still locally "valid"
// (expires_at in the future), and every codex call 401'd
// (`code=token_revoked`) for ~13h. Pre-fix `getCredentials()` only consulted
// the local expiry clock, so the provider never attempted a refresh, never
// produced the diagnosable `refresh_consumed_by_other_client` AuthError, and
// nobody was notified. The hardened wire path must: force-refresh once on a
// 401, retry the request with the fresh token, and — when the refresh itself
// confirms the rotation — push one deduped notice to the credential owner.

// ---------------------------------------------------------------------------
// Fake Responses upstream: a per-test script of responses, one per request.

type UpstreamStep = 'unauthorized' | 'sse-ok'
let script: UpstreamStep[] = []
let seenAuthHeaders: Array<string | undefined> = []

const server = http.createServer((req, res) => {
  seenAuthHeaders.push(req.headers.authorization)
  const step = script.shift() ?? 'sse-ok'
  if (step === 'unauthorized') {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        error: {
          message: 'The token has been revoked.',
          type: 'invalid_request_error',
          code: 'token_revoked',
        },
      }),
    )
    return
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
  })
  res.write(
    `event: response.output_text.delta\ndata: ${JSON.stringify({
      type: 'response.output_text.delta',
      delta: 'ok',
    })}\n\n`,
  )
  res.write(
    `event: response.completed\ndata: ${JSON.stringify({
      type: 'response.completed',
      response: { status: 'completed', usage: { input_tokens: 3, output_tokens: 1 } },
    })}\n\n`,
  )
  res.end()
})

await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const port = (server.address() as AddressInfo).port

const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'lc-codex-retry-'))

before(() => {
  setLightclawHomeOverride(tmpHome)
})

after(() => {
  server.closeAllConnections?.()
  server.close()
  setLightclawHomeOverride(undefined)
  rmSync(tmpHome, { recursive: true, force: true })
})

afterEach(() => {
  script = []
  seenAuthHeaders = []
  _setCodexRevocationNoticeDeliveryForTests(null)
})

function credentialsStub(): {
  calls: Array<{ forceRefresh: boolean }>
  provider: (opts?: { forceRefresh?: boolean }) => Promise<AuthCredentials>
} {
  const calls: Array<{ forceRefresh: boolean }> = []
  return {
    calls,
    provider: async opts => {
      calls.push({ forceRefresh: opts?.forceRefresh === true })
      return {
        accessToken: opts?.forceRefresh ? 'fresh-token' : 'stale-token',
        expiresAt: Date.now() + 3_600_000,
        accountId: 'acct_test',
      }
    },
  }
}

async function collectInSession(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  // streamChat reads getSessionId() for prompt_cache_key, so drive it inside
  // a real (throwaway) SessionContext scope.
  const ctx = createSessionContext({
    cwd: tmpHome,
    model: 'gpt-test',
    sessionsDir: path.join(tmpHome, 'sessions'),
    memoryDir: path.join(tmpHome, 'memory'),
    sessionId: 'codex-credential-retry-test',
  })
  return runWithSessionContext(ctx, async () => {
    const out: StreamEvent[] = []
    for await (const event of gen) {
      out.push(event)
    }
    return out
  })
}

function makeCodexProvider(stub: ReturnType<typeof credentialsStub>['provider']) {
  return createOpenAIAuthProvider(
    { auth: 'codex-oauth', baseUrl: `http://127.0.0.1:${port}` },
    { credentialsProvider: stub },
  )
}

describe('openai-auth: wire-401 forced-refresh retry (codex mode)', () => {
  it('retries ONCE with a forced refresh after a 401 and completes on the fresh token', async () => {
    script = ['unauthorized', 'sse-ok']
    const stub = credentialsStub()
    const provider = makeCodexProvider(stub.provider)
    const events = await collectInSession(
      provider.streamChat({
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hi' }],
        system: 'sys',
        tools: [],
      }),
    )
    const stop = events[events.length - 1]
    assert.equal(stop.type, 'stop')
    // First resolve is the normal (clock-gated) path; the 401 forces exactly
    // one refresh resolve.
    assert.deepEqual(stub.calls, [{ forceRefresh: false }, { forceRefresh: true }])
    // The retry must actually put the REFRESHED token on the wire.
    assert.deepEqual(seenAuthHeaders, ['Bearer stale-token', 'Bearer fresh-token'])
  })

  it('reports a deduped owner notice and surfaces a fatal error when the forced refresh confirms rotation', async () => {
    script = ['unauthorized']
    const reported: CodexRevocationNoticeInput[] = []
    _setCodexRevocationNoticeDeliveryForTests(async input => {
      reported.push(input)
    })
    const rotationError = new AuthError({
      code: 'refresh_consumed_by_other_client',
      provider: 'codex',
      message:
        'Codex refresh token was rejected (status 401, error=invalid_grant) — another client likely rotated it, or it was revoked.',
    })
    const provider = createOpenAIAuthProvider(
      { auth: 'codex-oauth', baseUrl: `http://127.0.0.1:${port}` },
      {
        credentialsProvider: async opts => {
          if (opts?.forceRefresh) throw rotationError
          return {
            accessToken: 'stale-token',
            expiresAt: Date.now() + 3_600_000,
            accountId: 'acct_test',
          }
        },
      },
    )
    await assert.rejects(
      collectInSession(
        provider.streamChat({
          model: 'gpt-test',
          messages: [{ role: 'user', content: 'hi' }],
          system: 'sys',
          tools: [],
        }),
      ),
      (error: unknown) => {
        assert.equal(error, rotationError)
        // Must stay FATAL: retrying a rotated-away credential is the 1.1-style
        // quota-burn shape; the turn should fail loud with the recovery hint.
        assert.equal(isTransientError(error), false)
        return true
      },
    )
    // Notice delivery is fire-and-forget — flush the microtask queue.
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(reported.length, 1)
    assert.match(reported[0].detail, /another client likely rotated it/)
  })

  it('apiKey mode (schema openai) does NOT refresh-retry a 401 — a static key cannot be refreshed', async () => {
    script = ['unauthorized']
    const provider = createOpenAIAuthProvider(
      { apiKey: 'sk-static', baseUrl: `http://127.0.0.1:${port}` },
      { apiKeyMode: true },
    )
    await assert.rejects(
      collectInSession(
        provider.streamChat({
          model: 'gpt-test',
          messages: [{ role: 'user', content: 'hi' }],
          system: 'sys',
          tools: [],
        }),
      ),
      (error: unknown) => {
        assert.equal((error as Error & { status?: number }).status, 401)
        return true
      },
    )
    assert.equal(seenAuthHeaders.length, 1, 'must not send a second request')
  })
})

describe('codex auth provider: forceRefresh bypasses the local expiry clock', () => {
  it('refreshes a locally-valid token when forceRefresh is set', async () => {
    // Server-side revocation is invisible to expires_at — pre-fix there was no
    // way to make the provider refresh a token the clock still trusted.
    const stored: StoredCodexTokens = {
      tokens: {
        access_token: 'locally-valid',
        refresh_token: 'rt-1',
        expires_at: Date.now() + 86_400_000,
      },
      account_id: 'acct_test',
      source: 'codex-cli-import',
    }
    mkdirSync(path.join(tmpHome, 'auth'), { recursive: true })
    writeFileSync(
      path.join(tmpHome, 'auth', 'codex.json'),
      JSON.stringify(stored),
      { mode: 0o600 },
    )
    let refreshCalls = 0
    const provider = createCodexAuthProvider({
      http: async () => {
        refreshCalls += 1
        return {
          statusCode: 200,
          bodyText: JSON.stringify({
            access_token: 'refreshed',
            refresh_token: 'rt-2',
            expires_in: 600,
            token_type: 'Bearer',
          }),
        }
      },
    })
    // Clock-gated path: far-future expiry → no refresh.
    const cached = await provider.getCredentials()
    assert.equal(cached.accessToken, 'locally-valid')
    assert.equal(refreshCalls, 0)
    // Forced path: refresh despite the valid clock.
    const forced = await provider.getCredentials({ forceRefresh: true })
    assert.equal(forced.accessToken, 'refreshed')
    assert.equal(refreshCalls, 1)
  })
})

describe('codex revocation notice: per-credential dedup', () => {
  it('delivers once per outage and re-arms after a successful resolve clears it', async () => {
    const delivered: CodexRevocationNoticeInput[] = []
    _setCodexRevocationNoticeDeliveryForTests(async input => {
      delivered.push(input)
    })
    const identity = { credentialOwner: 'alice', authRef: 'codex:default' }
    reportCodexCredentialRevoked({ ...identity, detail: 'd1' })
    reportCodexCredentialRevoked({ ...identity, detail: 'd2' })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(delivered.length, 1, 'second report during the same outage must dedup')
    // A different credential is an independent outage.
    reportCodexCredentialRevoked({ credentialOwner: 'bob', authRef: 'codex:default', detail: 'd3' })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(delivered.length, 2)
    // Recovery (successful resolve) clears the marker → next outage notifies.
    clearCodexRevocationNotice(identity)
    reportCodexCredentialRevoked({ ...identity, detail: 'd4' })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(delivered.length, 3)
  })

  it('re-arms the marker when delivery fails so the next 401 retries the card', async () => {
    let attempts = 0
    _setCodexRevocationNoticeDeliveryForTests(async () => {
      attempts += 1
      if (attempts === 1) throw new Error('no active feishu sender')
    })
    const identity = { credentialOwner: 'carol', authRef: 'codex:default' }
    reportCodexCredentialRevoked({ ...identity, detail: 'd1' })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(attempts, 1)
    reportCodexCredentialRevoked({ ...identity, detail: 'd2' })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(attempts, 2, 'failed delivery must not permanently swallow the outage')
  })
})
