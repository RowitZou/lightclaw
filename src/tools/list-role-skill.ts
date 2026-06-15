import { z } from 'zod'

import { getAgent, getAllAgents, getMainRole } from '../agents/registry.js'
import { resolveRolePolicy } from '../agents/role-presets.js'
import { isDispatchTargetReachable } from '../agents/role-tool-gate.js'
import { listRegisteredSkills } from '../skill/registry.js'
import { visibleOnDemandSkillsForRole } from '../skill/role-validation.js'
import { getCurrentRole } from '../state.js'
import { buildTool } from '../tool.js'

const LIST_ROLE_SKILL_DESCRIPTION = [
  'List the on-demand skills a worker can invoke, with each skill\'s "when to use", so you can route work to the right specialist and phrase the dispatch around the skill the worker already owns instead of re-specifying its procedure yourself.',
  '',
  'The `## Reachable Workers` section names each worker\'s skills; call this when a name alone is not enough to tell what a skill covers, or to confirm a worker owns the capability before you delegate to it.',
  '',
  'Input:',
  '- `role` — a worker from your `## Reachable Workers` list.',
  '',
  'Returns each invokable skill\'s name, one-line description, and when-to-use. Always-on workflow skills are omitted (they are the worker\'s built-in procedure, not a capability you route toward).',
].join('\n')

export const listRoleSkillTool = buildTool({
  name: 'ListRoleSkill',
  whenToUse: `See what a reachable worker's skills do before delegating, when the skill name alone is ambiguous.`,
  // Task-specific discovery aid, not an every-turn verb: deferred, reached via
  // ToolSearch. The always-on signal is the skill names in ## Reachable
  // Workers; this is the on-demand deep-dive into what each does.
  shouldDefer: true,
  description: LIST_ROLE_SKILL_DESCRIPTION,
  searchHint: 'role skill list capability worker dispatch delegate when-to-use 角色 技能 派发 能力',
  domain: 'host',
  riskLevel: 'safe',
  inputSchema: z.object({
    role: z.string().min(1),
  }),
  async call(input, context) {
    const callerRole = getCurrentRole() ?? getMainRole()
    const callerPolicy = resolveRolePolicy(callerRole)

    const target = getAgent(input.role)
    if (!target || target.kind !== 'worker') {
      const reachable = reachableWorkerNames(callerPolicy.reachableRoles)
      return {
        output: `No reachable worker named "${input.role}". Reachable workers: ${reachable.join(', ') || '(none)'}.`,
        isError: true,
      }
    }

    if (!isDispatchTargetReachable(callerPolicy, target.agentType)) {
      const reachable = reachableWorkerNames(callerPolicy.reachableRoles)
      return {
        output: `"${input.role}" is not in your reachable workers. Reachable workers: ${reachable.join(', ') || '(none)'}.`,
        isError: true,
      }
    }

    const gate = { runtimeDriver: context.config?.runtime.driver ?? null }
    const skills = visibleOnDemandSkillsForRole(listRegisteredSkills(), target, gate)
    if (skills.length === 0) {
      return { output: `${target.agentType} has no on-demand skills to invoke.` }
    }

    const lines = skills.map(skill => {
      const whenToUse = skill.whenToUse ?? 'Use when the task matches the skill.'
      return `- ${skill.name}: ${skill.description} | When to use: ${whenToUse}`
    })
    return { output: `${target.agentType} can invoke these skills:\n${lines.join('\n')}` }
  },
})

function reachableWorkerNames(reachableRoles: readonly string[]): string[] {
  const workers = getAllAgents().filter(agent => agent.kind === 'worker')
  if (reachableRoles.includes('*')) {
    return workers.map(agent => agent.agentType)
  }
  const set = new Set(reachableRoles)
  return workers.filter(agent => set.has(agent.agentType)).map(agent => agent.agentType)
}
