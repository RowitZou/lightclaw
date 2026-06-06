import assert from 'node:assert/strict'
import test from 'node:test'

import type { Tool } from '../tool.js'
import { BUNDLED_AGENTS } from './bundled/index.js'
import { resolveRolePolicy } from './role-presets.js'
import { filterSkillsForRole } from '../skill/role-validation.js'
import { bundledSkills } from '../skill/bundled/index.js'
import {
  deriveCanUseTool,
  filterToolsByRoleVisibility,
  isDispatchTargetReachable,
  isToolVisibleToRole,
} from './role-tool-gate.js'
import type { Role } from './types.js'

test('worker roles apply allowlist plus worker-only blocked tools', async () => {
  const gate = deriveCanUseTool(role({ kind: 'worker', tools: ['*'] }))

  assert.equal((await gate(tool('Read'), {})).behavior, 'allow')
  assert.equal((await gate(tool('MemoryWrite'), {})).behavior, 'allow')
  assert.equal((await gate(tool('TodoWrite'), {})).behavior, 'allow')
  assert.deepEqual(await gate(tool('FeishuRead'), {}), {
    behavior: 'deny',
    reason: 'FeishuRead is reserved for Feishu-specialized roles.',
  })
  assert.deepEqual(await gate(tool('Dispatch'), {}), {
    behavior: 'deny',
    reason: 'Dispatch is not available to subagents.',
  })
  assert.deepEqual(await gate(tool('AskUserQuestion'), {}), {
    behavior: 'deny',
    reason: 'AskUserQuestion is not available to subagents.',
  })
  assert.deepEqual(await gate(tool('SkillWrite'), {}), {
    behavior: 'deny',
    reason: 'SkillWrite is not available to subagents.',
  })
  assert.deepEqual(await gate(tool('ShowSlashCatalog'), {}), {
    behavior: 'deny',
    reason: 'ShowSlashCatalog is not available to subagents.',
  })
})

test('Feishu reserved tools require an explicit role allowlist entry', async () => {
  const feishuGate = deriveCanUseTool(role({
    kind: 'worker',
    tools: ['FeishuRead', 'FeishuList', 'Read'],
  }))
  const wildcardGate = deriveCanUseTool(role({ kind: 'worker', tools: ['*'] }))

  assert.equal((await feishuGate(tool('FeishuRead'), {})).behavior, 'allow')
  assert.equal((await feishuGate(tool('FeishuList'), {})).behavior, 'allow')
  assert.equal((await feishuGate(tool('Read'), {})).behavior, 'allow')
  assert.deepEqual(await feishuGate(tool('FeishuDelete'), {}), {
    behavior: 'deny',
    reason: 'FeishuDelete is reserved for Feishu-specialized roles.',
  })
  assert.deepEqual(await wildcardGate(tool('FeishuCreateFile'), {}), {
    behavior: 'deny',
    reason: 'FeishuCreateFile is reserved for Feishu-specialized roles.',
  })
})

test('worker roles deny tools outside explicit role.tools', async () => {
  const gate = deriveCanUseTool(role({ kind: 'worker', tools: ['Read'] }))

  assert.equal((await gate(tool('Read'), {})).behavior, 'allow')
  assert.deepEqual(await gate(tool('Write'), {}), {
    behavior: 'deny',
    reason: "Write is not in this role's allowed tool set.",
  })
})

test('KillBash is a Bash companion tool for explicit and wildcard Bash roles only', () => {
  assert.equal(isToolVisibleToRole(role({ kind: 'worker', tools: ['Bash'] }), 'KillBash'), true)
  assert.equal(isToolVisibleToRole(role({ kind: 'worker', tools: ['*'] }), 'KillBash'), true)
  assert.equal(isToolVisibleToRole(role({ kind: 'worker', tools: ['Read'] }), 'KillBash'), false)
})

test('worker Dispatch visibility requires explicit tool and reachable roles', async () => {
  const reviewer = role({
    kind: 'worker',
    tools: ['Read', 'Dispatch'],
    reachableRoles: ['coder'],
  })
  const noTargets = role({
    kind: 'worker',
    tools: ['Read', 'Dispatch'],
    reachableRoles: [],
  })

  assert.equal(isToolVisibleToRole(reviewer, 'Dispatch'), true)
  assert.equal(isToolVisibleToRole(noTargets, 'Dispatch'), false)
})

test('bundled reviewer dispatches to producers (coder / feishuSecretary) + info workers (local / web), but not to peer organizers', () => {
  const reviewer = BUNDLED_AGENTS.find(agent => agent.agentType === 'reviewer')
  assert.ok(reviewer)

  assert.equal(isToolVisibleToRole(reviewer, 'Dispatch'), true)
  assert.deepEqual(reviewer.reachableRoles, ['coder', 'feishuSecretary', 'localExplorer', 'webSearcher'])
  for (const target of ['coder', 'feishuSecretary', 'localExplorer', 'webSearcher']) {
    assert.equal(
      isDispatchTargetReachable(resolveRolePolicy(reviewer), target),
      true,
      `reviewer should reach ${target}`,
    )
  }
  for (const target of ['generalist', 'archivist', 'reviewer', 'main']) {
    assert.equal(
      isDispatchTargetReachable(resolveRolePolicy(reviewer), target),
      false,
      `reviewer should NOT reach ${target}`,
    )
  }
})

test('isDispatchTargetReachable supports wildcard and explicit targets', () => {
  const base = {
    name: 'caller',
    kind: 'worker' as const,
    tools: ['Dispatch'],
    skills: [],
    mcpServers: [],
    hooks: ['*'],
    outputContract: 'report' as const,
  }

  assert.equal(isDispatchTargetReachable({ ...base, reachableRoles: ['*'] }, 'coder'), true)
  assert.equal(isDispatchTargetReachable({ ...base, reachableRoles: ['coder'] }, 'coder'), true)
  assert.equal(isDispatchTargetReachable({ ...base, reachableRoles: ['coder'] }, 'generalist'), false)
})

test('internal roles use only role.tools allowlist', async () => {
  const internal = role({
    kind: 'internal',
    tools: ['MemoryWrite', 'Bash'],
  })
  const gate = deriveCanUseTool(internal)

  assert.equal((await gate(tool('MemoryWrite'), {})).behavior, 'allow')
  assert.equal((await gate(tool('Bash'), { command: 'rm -rf /tmp/x' })).behavior, 'allow')
  assert.equal((await gate(tool('Read'), {})).behavior, 'deny')
})

test('orchestrator roles with wildcard tools do not restrict tool presence', async () => {
  const gate = deriveCanUseTool(role({ kind: 'orchestrator', tools: ['*'] }))

  assert.equal((await gate(tool('Dispatch'), {})).behavior, 'allow')
  assert.equal((await gate(tool('Notify'), {})).behavior, 'allow')
})

test('isToolVisibleToRole mirrors deriveCanUseTool without async dispatch', () => {
  const worker = role({ kind: 'worker', tools: ['Read', 'MemoryWrite', 'TodoWrite'] })
  const internal = role({ kind: 'internal', tools: ['MemoryWrite'] })

  assert.equal(isToolVisibleToRole(worker, 'Read'), true)
  assert.equal(isToolVisibleToRole(worker, 'MemoryWrite'), true)
  assert.equal(isToolVisibleToRole(worker, 'TodoWrite'), true)
  assert.equal(isToolVisibleToRole(worker, 'Dispatch'), false)
  assert.equal(isToolVisibleToRole(internal, 'MemoryWrite'), true)
  assert.equal(isToolVisibleToRole(internal, 'Read'), false)
})

test('memoryCurator role exposes only memory curation tools and reads', () => {
  const autoDream = BUNDLED_AGENTS.find(agent => agent.agentType === 'memoryCurator')
  assert.ok(autoDream)
  assert.deepEqual(autoDream.tools, [
    'MemoryRead',
    'MemoryWriteAt',
    'MemoryMove',
    'MemoryDelete',
    'Read',
    'Grep',
    'Glob',
  ])
  assert.equal(isToolVisibleToRole(autoDream, 'Bash'), false)
  assert.equal(isToolVisibleToRole(autoDream, 'MemoryWrite'), false)
  assert.equal(isToolVisibleToRole(autoDream, 'MemoryWriteAt'), true)
})

test('Notify is reserved for main: blocked for every worker including wildcard / explicit listing', async () => {
  // Wildcard tools must not unlock Notify.
  const wildcardWorker = deriveCanUseTool(role({ kind: 'worker', tools: ['*'] }))
  assert.equal((await wildcardWorker(tool('Notify'), {})).behavior, 'deny')

  // Even explicitly listing 'Notify' does not unlock it for a worker.
  // (Parallel to Dispatch, but without the explicit-reachable escape hatch.)
  const explicitWorker = deriveCanUseTool(role({ kind: 'worker', tools: ['Notify'] }))
  assert.equal((await explicitWorker(tool('Notify'), {})).behavior, 'deny')

  const explicitCatalogWorker = deriveCanUseTool(role({ kind: 'worker', tools: ['ShowSlashCatalog'] }))
  assert.equal((await explicitCatalogWorker(tool('ShowSlashCatalog'), {})).behavior, 'deny')

  // Orchestrator (main) with wildcard sees Notify naturally.
  const orchestrator = deriveCanUseTool(role({ kind: 'orchestrator', tools: ['*'] }))
  assert.equal((await orchestrator(tool('Notify'), {})).behavior, 'allow')
  assert.equal((await orchestrator(tool('ShowSlashCatalog'), {})).behavior, 'allow')
  assert.equal((await orchestrator(tool('AskUserQuestion'), {})).behavior, 'allow')
  assert.equal((await orchestrator(tool('SkillWrite'), {})).behavior, 'allow')
})

test('SkillWrite and skillify are main-only', async () => {
  const wildcardWorker = deriveCanUseTool(role({
    kind: 'worker',
    tools: ['*'],
    skills: ['skillify'],
  }))
  assert.equal((await wildcardWorker(tool('SkillWrite'), {})).behavior, 'deny')

  const main = BUNDLED_AGENTS.find(agent => agent.agentType === 'main')
  assert.ok(main)
  assert.equal(isToolVisibleToRole(main, 'SkillWrite'), true)
  assert.equal(
    filterSkillsForRole(bundledSkills, main).some(skill => skill.name === 'skillify'),
    true,
    'main should see skillify',
  )

  const worker = role({
    kind: 'worker',
    tools: ['*'],
    skills: ['skillify'],
  })
  assert.equal(
    filterSkillsForRole(bundledSkills, worker).some(skill => skill.name === 'skillify'),
    false,
    'worker should not see skillify because SkillWrite is blocked',
  )
})

test('BrainppCluster is visible only to cluster-capable roles', () => {
  const main = role({ agentType: 'main', kind: 'orchestrator', tools: ['*'] })
  const generalist = role({ agentType: 'generalist', kind: 'worker', tools: ['*'] })
  const coder = role({ agentType: 'coder', kind: 'worker', tools: ['Read', 'Bash'] })
  const archivist = role({ agentType: 'archivist', kind: 'worker', tools: ['*'] })
  const reviewer = role({ agentType: 'reviewer', kind: 'worker', tools: ['Bash'] })

  assert.equal(isToolVisibleToRole(main, 'BrainppCluster'), true)
  assert.equal(isToolVisibleToRole(generalist, 'BrainppCluster'), true)
  assert.equal(isToolVisibleToRole(coder, 'BrainppCluster'), true)
  assert.equal(isToolVisibleToRole(archivist, 'BrainppCluster'), false)
  assert.equal(isToolVisibleToRole(reviewer, 'BrainppCluster'), false)
})

test('bundled dispatch matrix matches the role-to-role topology', () => {
  const matrix: Record<string, string[] | null> = {
    main: ['*'],
    generalist: ['coder', 'feishuSecretary', 'localExplorer', 'webSearcher'],
    reviewer: ['coder', 'feishuSecretary', 'localExplorer', 'webSearcher'],
    archivist: ['feishuSecretary', 'localExplorer', 'webSearcher'],
    coder: ['localExplorer', 'webSearcher'],
    feishuSecretary: ['localExplorer', 'webSearcher'],
    localExplorer: null,
    webSearcher: null,
  }
  for (const [agentType, expected] of Object.entries(matrix)) {
    const agent = BUNDLED_AGENTS.find(a => a.agentType === agentType)
    assert.ok(agent, `${agentType} not found in BUNDLED_AGENTS`)
    if (expected === null) {
      assert.equal(agent.reachableRoles, undefined, `${agentType} should not declare reachableRoles`)
      assert.equal(
        isToolVisibleToRole(agent, 'Dispatch'),
        false,
        `${agentType} should not have Dispatch visible`,
      )
      continue
    }
    assert.deepEqual(agent.reachableRoles, expected, `${agentType} reachableRoles mismatch`)
    assert.equal(
      isToolVisibleToRole(agent, 'Dispatch'),
      true,
      `${agentType} should have Dispatch visible`,
    )
    // Dispatch family is bound: List/Cancel/Update all visible to dispatchers.
    for (const mgmt of ['ListDispatches', 'CancelDispatch', 'UpdateDispatch']) {
      assert.equal(
        isToolVisibleToRole(agent, mgmt),
        true,
        `${agentType} should have ${mgmt} visible (Dispatch family binding)`,
      )
    }
  }
})

test('every non-main bundled worker role is denied user-escalation and skill-write tools', () => {
  for (const agent of BUNDLED_AGENTS) {
    if (agent.agentType === 'main') {
      assert.equal(isToolVisibleToRole(agent, 'Notify'), true, 'main should keep Notify')
      continue
    }
    if (agent.kind !== 'worker') {
      continue
    }
    assert.equal(
      isToolVisibleToRole(agent, 'Notify'),
      false,
      `${agent.agentType} should be denied Notify`,
    )
    assert.equal(
      isToolVisibleToRole(agent, 'SkillWrite'),
      false,
      `${agent.agentType} should be denied SkillWrite`,
    )
    assert.equal(
      isToolVisibleToRole(agent, 'SkillDelete'),
      false,
      `${agent.agentType} should be denied SkillDelete`,
    )
  }
})

test('skill internal roles can use only their explicit skill tool surfaces', () => {
  const skillCurator = BUNDLED_AGENTS.find(agent => agent.agentType === 'skillCurator')
  const skillConsolidator = BUNDLED_AGENTS.find(agent => agent.agentType === 'skillConsolidator')
  assert.ok(skillCurator)
  assert.ok(skillConsolidator)

  assert.deepEqual(skillCurator.tools, ['SkillWrite', 'Read', 'Grep', 'Glob'])
  assert.equal(isToolVisibleToRole(skillCurator, 'SkillWrite'), true)
  assert.equal(isToolVisibleToRole(skillCurator, 'SkillDelete'), false)
  assert.equal(isToolVisibleToRole(skillCurator, 'Notify'), false)

  assert.deepEqual(skillConsolidator.tools, ['SkillWrite', 'SkillDelete', 'Read'])
  assert.equal(isToolVisibleToRole(skillConsolidator, 'SkillWrite'), true)
  assert.equal(isToolVisibleToRole(skillConsolidator, 'SkillDelete'), true)
  assert.equal(isToolVisibleToRole(skillConsolidator, 'Notify'), false)
})

function role(overrides: Partial<Role> = {}): Role {
  return {
    agentType: 'test-role',
    whenToUse: 'when useful',
    tools: ['Read'],
    systemPrompt: 'system',
    ...overrides,
  }
}

test('filterToolsByRoleVisibility drops Feishu tools from main wildcard catalog', () => {
  const main = BUNDLED_AGENTS.find(a => a.agentType === 'main')!
  const input = [
    tool('Bash'),
    tool('Read'),
    tool('Dispatch'),
    tool('FeishuRead'),
    tool('FeishuList'),
    tool('FeishuWriteDoc'),
    tool('FeishuCreateFile'),
  ]
  const visible = filterToolsByRoleVisibility(main, input).map(t => t.name)
  assert.deepEqual(visible, ['Bash', 'Read', 'Dispatch'])
})

test('filterToolsByRoleVisibility drops user-escalation tools from worker even with wildcard tools', () => {
  const generalist = BUNDLED_AGENTS.find(a => a.agentType === 'generalist')!
  const input = [tool('Bash'), tool('Read'), tool('Notify'), tool('AskUserQuestion'), tool('SkillWrite'), tool('Dispatch')]
  const visible = filterToolsByRoleVisibility(generalist, input).map(t => t.name)
  assert.equal(visible.includes('Notify'), false, 'worker must not see Notify')
  assert.equal(visible.includes('AskUserQuestion'), false, 'worker must not see AskUserQuestion')
  assert.equal(visible.includes('SkillWrite'), false, 'worker must not see SkillWrite')
})

function tool(name: string): Tool {
  return {
    name,
    description: name,
    source: 'builtin',
    domain: 'host',
    riskLevel: 'safe',
    async call() {
      return { output: 'ok' }
    },
    formatResult(output, toolUseId) {
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: String(output),
      }
    },
  }
}
