import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { setLightclawHomeOverride } from '../paths.js'

/**
 * Smallest config.json that lets `getConfig()` resolve without throwing
 * "No models configured" — one apiKey endpoint plus one model that points
 * at it. `runtime.network.proxy` is intentionally left unset so outbound
 * HTTP in unit tests goes direct (and is stubbed at the transport seam
 * anyway).
 */
const MINIMAL_CONFIG = {
  endpoints: {
    test: { apiKey: 'sk-test', baseUrl: 'http://127.0.0.1:9' },
  },
  models: {
    'test-model': {
      endpoint: 'test',
      schema: 'anthropic',
      upstreamModel: 'test-upstream',
    },
  },
  defaultModel: 'test-model',
}

/**
 * Point `lightclawHome()` at a throwaway directory holding a minimal
 * config.json, so unit tests that transitively hit `getConfig()` (WebFetch /
 * WebSearch proxy lookup, Read's image-capability check) do not depend on a
 * developer machine having a real `~/.lightclaw/config.json`.
 *
 * Call once in a test `before()`; run the returned cleanup in `after()`.
 */
export function installTestConfigHome(): () => void {
  const home = mkdtempSync(path.join(tmpdir(), 'lightclaw-test-home-'))
  writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify(MINIMAL_CONFIG),
  )
  setLightclawHomeOverride(home)
  return () => {
    setLightclawHomeOverride(undefined)
    rmSync(home, { recursive: true, force: true })
  }
}
