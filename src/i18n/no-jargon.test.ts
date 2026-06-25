import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { LOCALES } from './locales.js'

// Completeness guard for the slash-card content de-jargon pass (L3): user-facing
// i18n values must not leak internal implementation terms. Any new/edited string
// that reintroduces one of these trips this test at build time, so the de-jargon
// work can't silently regress and no edge case stays hidden behind manual review.
//
// DENYLIST = terms that are pure framework internals and should NEVER reach a
// user-facing string. (Domain words the user/agent legitimately sees — endpoint,
// backend, dispatch, role, docker, worker/container as admin sandbox labels — are
// intentionally NOT here.)
const DENY: ReadonlyArray<string> = [
  'gpfs',
  'rlaunch',
  'Rlaunch',
  'scratch',
  '$NAME',
  '注入到 Bash',
  'apiKeyRef',
  'authRef',
  'config.json',
  '<home>',
  'per-user',
  'BYO',
  'defaultModel',
  'bypassPermissions',
  'Tier ', // the layered-fs "Tier 1/2" architecture term (trailing space avoids matching unrelated words)
  'LocalRuntime',
]

// ALLOWLIST = key prefixes exempt from the scan. These are NOT slash-command
// result strings:
//   - runtime.* / image.*  → low-level runtime/infra error tables, CLAUDE.md
//     explicitly defers their i18n; the terms ARE the subject (a worker/gpfs
//     failure), not a leak.
//   - chain.error.* / status.dispatch.tree* → dispatch-domain diagnostics seen
//     by the agent, not infra leaks.
const ALLOW_PREFIXES: ReadonlyArray<string> = [
  'runtime.',
  'image.',
  'chain.error.',
  'status.dispatch.tree',
]

function isAllowed(key: string): boolean {
  return ALLOW_PREFIXES.some(p => key.startsWith(p))
}

describe('i18n no-jargon guard (L3 de-jargon completeness)', () => {
  for (const locale of ['cn', 'en'] as const) {
    it(`has no internal-jargon leaks in ${locale} user-facing strings`, () => {
      const violations: string[] = []
      for (const [key, value] of Object.entries(LOCALES[locale])) {
        if (isAllowed(key)) continue
        for (const term of DENY) {
          if (value.includes(term)) violations.push(`${key} → "${term}"`)
        }
      }
      assert.deepEqual(
        violations,
        [],
        `Internal jargon leaked into ${locale} strings:\n  ${violations.join('\n  ')}`,
      )
    })
  }
})
