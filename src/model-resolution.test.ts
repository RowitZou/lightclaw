import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { LightClawConfig } from './config.js'
import { BUNDLED_AGENTS } from './agents/bundled/index.js'
import type { Role } from './agents/types.js'
import {
  resolveRoleModel,
  resolveToolModuleModel,
} from './model-resolution.js'

const mainRole = role('main')
const webRole = role('webSearcher')
const exploreRole = role('localExplorer')
const extractRole = role('memoryExtractor')
const autoDreamRole = role('memoryCurator')

describe('resolveRoleModel', () => {
  it('binds main directly to defaultModel', () => {
    assert.equal(
      resolveRoleModel(mainRole, config({ lane: { worker: 'haiku', system: 'haiku' } })),
      'sonnet',
    )
  })

  it('uses the worker lane for worker roles before defaultModel', () => {
    assert.equal(
      resolveRoleModel(webRole, config({ lane: { worker: 'haiku' } })),
      'haiku',
    )
    // A worker role does NOT read the system lane.
    assert.equal(
      resolveRoleModel(exploreRole, config({ lane: { system: 'gpt-mini' } })),
      'sonnet',
    )
  })

  it('falls worker roles back to defaultModel when worker lane is unset', () => {
    assert.equal(resolveRoleModel(webRole, config()), 'sonnet')
    assert.equal(resolveRoleModel(webRole, config({ lane: {} })), 'sonnet')
  })

  it('treats an empty-string worker lane as unset (new contract)', () => {
    // Codifies the empty-string-is-unset rule: lane.worker = "" must NOT be
    // used as a model name; it falls back to defaultModel.
    assert.equal(resolveRoleModel(webRole, config({ lane: { worker: '' } })), 'sonnet')
  })

  it('uses the system lane for all internal roles', () => {
    const cfg = config({ lane: { system: 'gpt-mini' } })
    assert.equal(resolveRoleModel(extractRole, cfg), 'gpt-mini')
    assert.equal(resolveRoleModel(autoDreamRole, cfg), 'gpt-mini')
  })

  it('falls internal roles back to defaultModel when system lane is unset', () => {
    assert.equal(resolveRoleModel(extractRole, config()), 'sonnet')
    // Empty-string system lane = unset.
    assert.equal(resolveRoleModel(extractRole, config({ lane: { system: '' } })), 'sonnet')
  })
})

describe('resolveToolModuleModel', () => {
  it('maps imageRead to the image lane; compact / webSearch to the system lane', () => {
    const cfg = config({
      lane: {
        system: 'gpt-mini',
        image: 'haiku',
      },
    })
    assert.equal(resolveToolModuleModel('imageRead', cfg), 'haiku')
    assert.equal(resolveToolModuleModel('compact', cfg), 'gpt-mini')
    assert.equal(resolveToolModuleModel('webSearch', cfg), 'gpt-mini')
  })

  it('falls module models back to defaultModel when their lane is unset', () => {
    const cfg = config()
    assert.equal(resolveToolModuleModel('webSearch', cfg), 'sonnet')
    assert.equal(resolveToolModuleModel('imageRead', cfg), 'sonnet')
    assert.equal(resolveToolModuleModel('compact', cfg), 'sonnet')
  })

  it('treats an empty-string lane value as unset (new contract)', () => {
    const cfg = config({ lane: { system: '', image: '' } })
    assert.equal(resolveToolModuleModel('imageRead', cfg), 'sonnet')
    assert.equal(resolveToolModuleModel('compact', cfg), 'sonnet')
    assert.equal(resolveToolModuleModel('webSearch', cfg), 'sonnet')
  })
})

describe('no silent model substitution', () => {
  // Fail-loud contract (2026-06-30): resolution returns the operator-/user-
  // configured model VERBATIM. There is no credential-degrade reroute — a
  // model that is configured but currently unreachable is handed back as-is
  // so the failure surfaces (actionably) at provider-call time instead of the
  // session being silently swapped onto a different model.
  it('returns the configured model verbatim even when other models exist', () => {
    const cfg = config({
      defaultModel: 'gpt-codex-deep',
      models: {
        'gpt-codex-deep': {},
        'claude-sonnet-4-6': {},
      },
    } as unknown as Partial<LightClawConfig>)
    // main stays on its (possibly unreachable) defaultModel — never swapped
    // to the other configured model.
    assert.equal(resolveRoleModel(role('main'), cfg), 'gpt-codex-deep')
  })
})

function role(agentType: string): Role {
  const found = BUNDLED_AGENTS.find(candidate => candidate.agentType === agentType)
  assert.ok(found, `missing bundled role ${agentType}`)
  return found
}

function config(overrides: Partial<LightClawConfig> = {}): LightClawConfig {
  return {
    defaultModel: 'sonnet',
    lane: {},
    tools: {
      webSearch: {},
      webFetch: { preapprovedDomains: [] },
      maxOutputBytes: 51_200,
      catalog: {
        deferredLoading: 'always',
        deferredLoadingThreshold: 30,
        discoveredToolsMaxSize: 30,
        discoveredToolsTtlTurns: 20,
      },
    },
    ...overrides,
  } as LightClawConfig
}
