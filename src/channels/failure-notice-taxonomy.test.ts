import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { formatNoticeFromFailure } from './runner.js'
import { isTransientError } from '../transient-error.js'
import { t } from '../i18n/index.js'

// D12 contract: the retry axis (isTransientError on the error) and the copy
// axis (formatNoticeFromFailure on its detail string) must agree per taxonomy
// class. A new error type wired into one axis but not the other trips a check
// here — this is the "fix the class, not the instance" lock against the two
// classifiers drifting apart again (the 2026-06 dogfood failure).
type Sample = {
  name: string
  error: unknown // retry axis input
  detail: string // copy axis input (the string repr the runner sees)
  expectTransient: boolean
  expectKind: 'info' | 'warning' | 'error'
  // Category label that must appear in the card text. Omitted for the
  // transient card (no category line — it carries the transient reason).
  expectCat?: string
  // Transient rate-limit / quota cards carry the rate reason line instead of
  // the generic "network jitter" one (2026-07-05 usage_limit_reached fix).
  expectTransientRate?: boolean
}

const SAMPLES: Sample[] = [
  {
    name: 'billing insufficient_quota',
    error: { status: 429, error: { type: 'insufficient_quota', message: 'You exceeded your current quota.' } },
    detail: 'insufficient_quota: You exceeded your current quota.',
    expectTransient: false,
    expectKind: 'warning',
    expectCat: t('channel.failure.cat.billing'),
  },
  {
    name: 'model/endpoint 404',
    error: { status: 404, message: 'The model `foo` does not exist' },
    detail: 'OpenAI Responses error: status=404 The model `foo` does not exist',
    expectTransient: false,
    expectKind: 'warning',
    expectCat: t('channel.failure.cat.modelEndpoint'),
  },
  {
    name: 'credential',
    error: new Error('authentication failed'),
    detail: 'authentication failed',
    expectTransient: false,
    expectKind: 'warning',
    expectCat: t('channel.failure.cat.credentials'),
  },
  {
    name: 'real rate-limit (try again)',
    error: { status: 429, message: 'Rate limit reached, please try again in 20s' },
    detail: 'Rate limit reached, please try again in 20s',
    expectTransient: true,
    expectKind: 'info',
    expectTransientRate: true,
  },
  {
    // 2026-07-05 official dogfood: codex plan quota exhausted. Transient on
    // the retry axis (429 → the window self-heals), but the card must say
    // "limit reached", not "network jitter". The detail string deliberately
    // omits the literal "429" so the copy axis must recognize the
    // usage_limit wording itself.
    name: 'codex usage_limit_reached (quota window exhausted)',
    error: {
      status: 429,
      message: 'OpenAI Responses streamChat request failed status=429: type=usage_limit_reached, message=The usage limit has been reached',
    },
    detail: 'type=usage_limit_reached, message=The usage limit has been reached',
    expectTransient: true,
    expectKind: 'info',
    expectTransientRate: true,
  },
  {
    name: 'overloaded 529',
    error: { status: 529, error: { type: 'overloaded_error' } },
    detail: 'overloaded_error: server overloaded',
    expectTransient: true,
    expectKind: 'info',
  },
  {
    name: 'validation 400 invalid_request',
    error: { status: 400, error: { type: 'invalid_request_error', message: 'Invalid request: messages.0' } },
    detail: 'invalid_request_error: Invalid request: messages.0',
    expectTransient: false,
    expectKind: 'error',
    expectCat: t('channel.failure.cat.validation'),
  },
  {
    name: 'unknown fatal (422)',
    error: { status: 422, message: 'Unprocessable entity: weird' },
    detail: 'status=422 Unprocessable entity: weird',
    expectTransient: false,
    expectKind: 'error',
    expectCat: t('channel.failure.cat.generic'),
  },
]

describe('failure notice taxonomy (D12 contract)', () => {
  for (const s of SAMPLES) {
    it(`${s.name}: retry axis and copy axis agree`, () => {
      assert.equal(isTransientError(s.error), s.expectTransient, 'retry axis')
      const notice = formatNoticeFromFailure(s.detail, s.expectTransient)
      assert.equal(notice.kind, s.expectKind, 'notice color/kind')
      if (s.expectCat) {
        assert.ok(
          notice.text.includes(s.expectCat),
          `category should be ${s.expectCat}; got:\n${notice.text}`,
        )
      } else if (s.expectTransientRate) {
        assert.ok(
          notice.text.includes(t('channel.failure.rateReason')),
          `transient rate card should carry the rate reason; got:\n${notice.text}`,
        )
        assert.equal(
          notice.text.includes(t('channel.failure.transientReason')),
          false,
          'transient rate card must not say network jitter',
        )
      } else {
        assert.ok(notice.text.includes(t('channel.failure.transientReason')))
      }
    })
  }

  // The transient rate card names the failing model when the caller passes it
  // (surfaceQueryFailure does on the dedup edge path).
  it('transient rate card renders the model line when provided', () => {
    const notice = formatNoticeFromFailure(
      'type=usage_limit_reached, message=The usage limit has been reached',
      true,
      { model: 'gpt-5.5' },
    )
    assert.equal(notice.kind, 'info')
    assert.ok(notice.text.includes(t('channel.failure.modelLine', { model: 'gpt-5.5' })))
    assert.ok(notice.text.includes(t('channel.failure.rateHint')))
  })

  // Pins the two dogfood regressions PR6 fixes (old code returned cat.rate +
  // "resend" for billing, cat.generic + "internal error" for 404).
  it('billing maps to billing (not rate) and is actionable', () => {
    const notice = formatNoticeFromFailure('insufficient_quota: You exceeded your current quota.', false)
    assert.equal(notice.kind, 'warning')
    assert.ok(notice.text.includes(t('channel.failure.cat.billing')))
    assert.equal(notice.text.includes(t('channel.failure.cat.rate')), false, 'must not fall to rate')
    assert.ok(notice.text.includes(t('channel.failure.billingHint')))
  })

  it('404 maps to model/endpoint, not generic internal error', () => {
    const notice = formatNoticeFromFailure('OpenAI Responses status=404 (no body)', false)
    assert.equal(notice.kind, 'warning')
    assert.ok(notice.text.includes(t('channel.failure.cat.modelEndpoint')))
    assert.equal(notice.text.includes(t('channel.failure.cat.generic')), false)
  })

  // D13: provider-actionable hints never tell the user to contact an admin
  // (forward-compat with bring-your-own-credential).
  it('provider-actionable hints do not mention contact-admin', () => {
    const adminHint = t('channel.failure.contactAdminHint')
    for (const detail of [
      'insufficient_quota: out of credits',
      'status=404 model not found',
      'authentication failed',
    ]) {
      const notice = formatNoticeFromFailure(detail, false)
      assert.equal(notice.kind, 'warning')
      assert.equal(
        notice.text.includes(adminHint),
        false,
        `provider failure must not carry the contact-admin hint: ${detail}`,
      )
    }
  })
})

// Owner-routed model-down notices (2026-06-30): the card names the failing
// model, a BYO model keeps the owner-actionable hint, and a PUBLIC (admin-
// owned) model swaps in "switch model or consult admin". These exercise the
// `{model, isPublic}` arg of formatNoticeFromFailure — on the pre-change code
// (which had no third arg and no such i18n keys) these assertions fail.
describe('failure notice: owner-routed model-down', () => {
  const billing = 'insufficient_quota: You exceeded your current quota.'

  it('names the failing model on a model-down card', () => {
    const notice = formatNoticeFromFailure(billing, false, {
      model: 'gpt-5.5-boyue',
      isPublic: false,
    })
    assert.ok(
      notice.text.includes(t('channel.failure.modelLine', { model: 'gpt-5.5-boyue' })),
      `model line should name the model; got:\n${notice.text}`,
    )
  })

  it('BYO model-down keeps the owner-actionable hint (not the public one)', () => {
    const notice = formatNoticeFromFailure(billing, false, { model: 'my-model', isPublic: false })
    assert.ok(notice.text.includes(t('channel.failure.billingHint')), 'BYO keeps billing hint')
    assert.equal(
      notice.text.includes(t('channel.failure.publicModelUserHint')),
      false,
      'BYO must not get the public switch-or-admin hint',
    )
  })

  it('public model-down swaps in the switch-or-consult-admin hint', () => {
    const notice = formatNoticeFromFailure(billing, false, { model: 'shared-opus', isPublic: true })
    assert.ok(
      notice.text.includes(t('channel.failure.publicModelUserHint')),
      'public model-down uses the public hint',
    )
    assert.equal(
      notice.text.includes(t('channel.failure.billingHint')),
      false,
      'public model-down must not show the owner-fix hint',
    )
  })

  it('non-model-down fatal ignores the public routing even when isPublic', () => {
    // A framework/protocol error is not a model-availability problem: it keeps
    // its own (contact-admin) hint, never the public model-switch hint.
    const notice = formatNoticeFromFailure('invalid_request_error: messages.0', false, {
      model: 'shared-opus',
      isPublic: true,
    })
    assert.equal(
      notice.text.includes(t('channel.failure.publicModelUserHint')),
      false,
      'validation error is not model-down → no public hint',
    )
    assert.ok(notice.text.includes(t('channel.failure.contactAdminHint')))
  })
})
