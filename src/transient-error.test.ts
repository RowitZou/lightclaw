import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  IdleStreamError,
  isContextOverflowError,
  isCredentialError,
  isTransientError,
} from './transient-error.js'

describe('isTransientError', () => {
  it('classifies network / undici / 5xx errors as transient', () => {
    // undici connection-drop — the 2026-05-21 dogfood miss.
    assert.equal(isTransientError(new TypeError('terminated')), true)
    assert.equal(
      isTransientError(Object.assign(new Error('boom'), { code: 'ECONNRESET' })),
      true,
    )
    assert.equal(
      isTransientError(Object.assign(new Error('overloaded'), { status: 503 })),
      true,
    )
    assert.equal(
      isTransientError(Object.assign(new Error('rate limited'), { status: 429 })),
      true,
    )
    // Structured signal carried on the cause chain.
    assert.equal(
      isTransientError(new Error('fetch failed', { cause: { code: 'UND_ERR_SOCKET' } })),
      true,
    )
  })

  it('classifies 4xx / abort / turn-cap as fatal (no retry)', () => {
    assert.equal(
      isTransientError(Object.assign(new Error('bad request'), { status: 400 })),
      false,
    )
    assert.equal(
      isTransientError(Object.assign(new Error('unauthorized'), { status: 401 })),
      false,
    )
    // /stop and interjection auto-abort must never be retried.
    assert.equal(
      isTransientError(Object.assign(new Error('x'), { name: 'AbortError' })),
      false,
    )
    assert.equal(isTransientError(new Error('Request was aborted')), false)
    // Deterministic — a whole-query re-run only reproduces it.
    assert.equal(isTransientError(new Error('Exceeded maximum tool turns (50).')), false)
    // Context-window overflow is deterministic — re-sending the same oversized
    // input fails again, so a plain retry is a wasted round-trip. The codex
    // phrasing (2026-05-30 dogfood) used to default to transient (retry).
    assert.equal(
      isTransientError(
        new Error(
          'Your input exceeds the context window of this model. Please adjust your input and try again.',
        ),
      ),
      false,
    )
    // Anthropic phrasing must stay fatal here too.
    assert.equal(isTransientError(new Error('prompt is too long: 250000 tokens')), false)
  })

  it('recognizes context-window overflow across provider phrasings', () => {
    // OpenAI / codex (2026-05-30 dogfood gpt-codex-mid double-overflow).
    assert.equal(
      isContextOverflowError(
        new Error(
          'Your input exceeds the context window of this model. Please adjust your input and try again.',
        ),
      ),
      true,
    )
    // OpenAI Chat Completions variant.
    assert.equal(
      isContextOverflowError(
        new Error("This model's maximum context length is 128000 tokens."),
      ),
      true,
    )
    // Anthropic.
    assert.equal(isContextOverflowError(new Error('prompt is too long')), true)
    // Carried on the cause chain.
    assert.equal(
      isContextOverflowError(
        new Error('wrapped', { cause: new Error('exceeds the context window') }),
      ),
      true,
    )
    // Unrelated errors must not match.
    assert.equal(isContextOverflowError(new Error('ECONNRESET')), false)
    assert.equal(isContextOverflowError(new Error('Request was aborted')), false)
  })

  it('classifies missing / expired credential errors as fatal (no retry)', () => {
    // 2026-06-14 dogfood: a Codex-pinned DM bricked at boot (expired tokens).
    // The provider throws this with no HTTP status / socket code, so pre-fix it
    // fell through to the default-retry branch → wasted retries → user saw
    // "network jitter, resend to retry" for a config error.
    const codexMissing = new Error(
      'No Codex credentials stored. Run `/auth import codex` to import from the official Codex CLI.',
    )
    assert.equal(isTransientError(codexMissing), false)
    assert.equal(isCredentialError(codexMissing), true)
    // Expired-token phrasing.
    assert.equal(
      isCredentialError(new Error('Codex CLI tokens are already expired. Re-run `codex login`.')),
      true,
    )
    // Carried on the cause chain.
    assert.equal(
      isCredentialError(new Error('streamChat failed', { cause: codexMissing })),
      true,
    )
    assert.equal(
      isTransientError(new Error('streamChat failed', { cause: codexMissing })),
      false,
    )
    // A plain network error must NOT be misread as a credential failure.
    assert.equal(isCredentialError(new Error('ECONNRESET')), false)
    assert.equal(isCredentialError(new Error('fetch failed')), false)
  })

  it('defaults a genuinely unrecognized error to transient (retry)', () => {
    assert.equal(isTransientError(new Error('something nobody has seen before')), true)
  })

  it('classifies stream idle aborts as transient', () => {
    const error = new IdleStreamError({
      kind: 'ttfb',
      idleMs: 90_001,
      model: 'test-model',
      endpoint: 'test',
    })
    assert.equal(isTransientError(error), true)
  })
})
