import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import {
  detectRuntimeRestart,
  formatRuntimeRestartReminder,
  resetRuntimeRestartTracking,
} from './restart-notice.js'

describe('detectRuntimeRestart', () => {
  afterEach(() => {
    resetRuntimeRestartTracking()
  })

  it('does not fire on the first observation — only records the baseline', () => {
    assert.equal(detectRuntimeRestart('s1', 'ws-alpha'), false)
  })

  it('does not fire while the generation is unchanged', () => {
    detectRuntimeRestart('s1', 'ws-alpha')
    assert.equal(detectRuntimeRestart('s1', 'ws-alpha'), false)
    assert.equal(detectRuntimeRestart('s1', 'ws-alpha'), false)
  })

  it('fires exactly once when the generation changes', () => {
    detectRuntimeRestart('s1', 'ws-alpha')
    assert.equal(detectRuntimeRestart('s1', 'ws-beta'), true)
    // Re-arms only on the next change, not every subsequent call.
    assert.equal(detectRuntimeRestart('s1', 'ws-beta'), false)
    assert.equal(detectRuntimeRestart('s1', 'ws-gamma'), true)
  })

  it('treats a null / undefined generation as "no tracking" — never fires, never moves the baseline', () => {
    detectRuntimeRestart('s1', 'ws-alpha')
    // LocalRuntime (no restart concept) or a transient null between a worker's
    // death and its respawn must not masquerade as a restart...
    assert.equal(detectRuntimeRestart('s1', null), false)
    assert.equal(detectRuntimeRestart('s1', undefined), false)
    // ...and must not clobber the baseline: the real worker is still ws-alpha,
    // so re-observing it is not a change.
    assert.equal(detectRuntimeRestart('s1', 'ws-alpha'), false)
    // A genuine swap after the null blips still fires against the kept baseline.
    assert.equal(detectRuntimeRestart('s1', 'ws-beta'), true)
  })

  it('isolates baselines per session — one session restarting does not fire another', () => {
    detectRuntimeRestart('dm', 'ws-alpha')
    detectRuntimeRestart('group', 'ws-alpha')
    // The shared worker is replaced; each session learns about it independently
    // at its own next tool boundary.
    assert.equal(detectRuntimeRestart('dm', 'ws-beta'), true)
    assert.equal(detectRuntimeRestart('group', 'ws-beta'), true)
  })
})

describe('formatRuntimeRestartReminder', () => {
  it('is a single system-reminder block that names the lost ephemeral state and the surviving workspace', () => {
    const reminder = formatRuntimeRestartReminder()
    assert.ok(reminder.startsWith('<system-reminder>'))
    assert.ok(reminder.endsWith('</system-reminder>'))
    assert.match(reminder, /\/tmp and \/scratch/)
    assert.match(reminder, /Background processes you started here/)
    assert.match(reminder, /workspace files persist/)
    // Cause-free by design — see restart-notice.ts. No mechanical-cause words.
    assert.doesNotMatch(reminder, /mount|health|sandbox|worker/i)
  })
})
