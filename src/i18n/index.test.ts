import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import type { LightClawConfig } from '../config.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'
import { getLang, setLang, t } from './index.js'

/** A minimal SessionContext carrying only the resolved lang we want to test. */
function langScope(lang: 'cn' | 'en') {
  return createSessionContext({
    cwd: '/tmp',
    model: 'm',
    sessionsDir: '/tmp/sessions',
    memoryDir: '/tmp/memory',
    config: { lang } as unknown as LightClawConfig,
  })
}

describe('getLang is ALS-scoped to the active session', () => {
  afterEach(() => {
    // Tests below mutate the module-global fallback; restore the default.
    setLang('cn')
  })

  it('falls back to the module global outside any session scope', () => {
    setLang('cn')
    assert.equal(getLang(), 'cn')
    assert.match(t('config.lang.set', { lang: 'x' }), /已切换界面语言/)
    setLang('en')
    assert.equal(getLang(), 'en')
    assert.match(t('config.lang.set', { lang: 'x' }), /UI language/)
  })

  it('reads the per-session config.lang, not the module global', async () => {
    setLang('cn') // global stays cn
    await runWithSessionContext(langScope('en'), async () => {
      assert.equal(getLang(), 'en')
      assert.match(t('config.lang.set', { lang: 'x' }), /UI language/)
    })
    // Back outside the scope, the global applies again.
    assert.equal(getLang(), 'cn')
  })

  it('session language wins over a concurrent setLang (the race the global cannot survive)', async () => {
    await runWithSessionContext(langScope('en'), async () => {
      // Simulate another user's turn flipping the module global mid-flight.
      setLang('cn')
      // A naive `t()` reading the global would now render cn inside this en
      // session; the ALS read keeps it en.
      assert.equal(getLang(), 'en')
      assert.match(t('config.lang.set', { lang: 'x' }), /UI language/)
    })
  })

  it('interleaved sessions each keep their own language across awaits', async () => {
    setLang('cn')
    const userEn = runWithSessionContext(langScope('en'), async () => {
      await Promise.resolve()
      return t('config.lang.set', { lang: 'x' })
    })
    const userCn = runWithSessionContext(langScope('cn'), async () => {
      await Promise.resolve()
      return t('config.lang.set', { lang: 'x' })
    })
    const [en, cn] = await Promise.all([userEn, userCn])
    assert.match(en, /UI language/)
    assert.match(cn, /已切换界面语言/)
  })
})
