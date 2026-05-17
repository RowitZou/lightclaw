import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { LightClawConfig } from './config.js'
import { BUNDLED_AGENTS } from './agents/bundled/index.js'
import type { Role } from './agents/types.js'
import {
  resolveRoleBudget,
  resolveRoleMaxTurns,
  resolveRoleModel,
  resolveToolModuleModel,
} from './model-resolution.js'

const mainRole = role('main')
const webRole = role('web')
const exploreRole = role('explore')
const extractRole = role('extract_memories')
const autoDreamRole = role('auto_dream')

describe('resolveRoleModel', () => {
  it('binds main directly to defaultModel', () => {
    assert.equal(
      resolveRoleModel(mainRole, config({ roles: { main: { model: 'haiku' } } })),
      'sonnet',
    )
  })

  it('uses per-worker model pins before defaultModel', () => {
    assert.equal(
      resolveRoleModel(webRole, config({ roles: { web: { model: 'haiku' } } })),
      'haiku',
    )
    assert.equal(
      resolveRoleModel(exploreRole, config({ roles: { internal: { model: 'gpt-mini' } } })),
      'sonnet',
    )
  })

  it('falls worker roles back to defaultModel when no pin exists', () => {
    assert.equal(resolveRoleModel(webRole, config()), 'sonnet')
    assert.equal(resolveRoleModel(webRole, config({ roles: { web: {} } })), 'sonnet')
  })

  it('uses roles.internal for all internal roles', () => {
    const cfg = config({ roles: { internal: { model: 'gpt-mini' } } })
    assert.equal(resolveRoleModel(extractRole, cfg), 'gpt-mini')
    assert.equal(resolveRoleModel(autoDreamRole, cfg), 'gpt-mini')
  })

  it('falls internal roles back to defaultModel when roles.internal is absent', () => {
    assert.equal(resolveRoleModel(extractRole, config()), 'sonnet')
  })
})

describe('resolveToolModuleModel', () => {
  it('uses per-module model pins before defaultModel', () => {
    const cfg = config({
      tools: {
        webSearch: { model: 'gpt-mini' },
        webFetch: { preapprovedDomains: [] },
        imageRead: { model: 'haiku' },
        compact: { model: 'haiku' },
        deferredLoading: 'always',
        deferredLoadingThreshold: 30,
        discoveredToolsMaxSize: 30,
        discoveredToolsTtlTurns: 20,
      },
    })
    assert.equal(resolveToolModuleModel('webSearch', cfg), 'gpt-mini')
    assert.equal(resolveToolModuleModel('imageRead', cfg), 'haiku')
    assert.equal(resolveToolModuleModel('compact', cfg), 'haiku')
  })

  it('falls module models back to defaultModel independently', () => {
    const cfg = config()
    assert.equal(resolveToolModuleModel('webSearch', cfg), 'sonnet')
    assert.equal(resolveToolModuleModel('imageRead', cfg), 'sonnet')
    assert.equal(resolveToolModuleModel('compact', cfg), 'sonnet')
  })
})

describe('resolveRoleMaxTurns', () => {
  it('keeps main uncapped', () => {
    assert.equal(
      resolveRoleMaxTurns(mainRole, config({ roles: { main: { maxTurns: 5 } } })),
      undefined,
    )
  })

  it('uses configured maxTurns before source role defaults', () => {
    assert.equal(
      resolveRoleMaxTurns(extractRole, config({ roles: { internal: { maxTurns: 50 } } })),
      50,
    )
    assert.equal(
      resolveRoleMaxTurns(webRole, config({ roles: { web: { maxTurns: 30 } } })),
      30,
    )
  })

  it('falls back to source role maxTurns, then undefined', () => {
    assert.equal(resolveRoleMaxTurns(extractRole, config()), 20)
    assert.equal(resolveRoleMaxTurns(webRole, config()), undefined)
  })
})

describe('resolveRoleBudget', () => {
  it('keeps main uncapped', () => {
    assert.equal(
      resolveRoleBudget(mainRole, config({ roles: { main: { budget: { maxTokens: 1 } } } })),
      undefined,
    )
  })

  it('uses configured budgets before source role budgets', () => {
    const webBudget = { maxTokens: 1000, maxCost: 0.5 }
    assert.deepEqual(
      resolveRoleBudget(webRole, config({ roles: { web: { budget: webBudget } } })),
      webBudget,
    )

    const sourceBudgetRole: Role = { ...webRole, budget: { maxTokens: 2000 } }
    assert.deepEqual(resolveRoleBudget(sourceBudgetRole, config()), { maxTokens: 2000 })
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
    roles: undefined,
    tools: {
      webSearch: {},
      webFetch: { preapprovedDomains: [] },
      imageRead: {},
      compact: {},
      deferredLoading: 'always',
      deferredLoadingThreshold: 30,
      discoveredToolsMaxSize: 30,
      discoveredToolsTtlTurns: 20,
    },
    ...overrides,
  } as LightClawConfig
}
