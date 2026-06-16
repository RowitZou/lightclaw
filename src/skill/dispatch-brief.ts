export const DISPATCH_BRIEF_LIST_ROLE_SKILL_FOOTER =
  "To see what a worker's skills do — and how to align your dispatch with them before delegating — call ListRoleSkill with its role name."

export const DISPATCH_BRIEF_LIST_ROLE_SKILL_DESCRIPTION =
  "Where a skill carries one, it also returns the skill's dispatch brief — how to align your dispatch with what the skill needs: what to pin down before delegating, and what to leave to the worker."

export function formatDispatchBriefForDelegation(brief: string): string {
  const lines = brief.trim().split(/\r?\n/)
  if (lines.length === 0 || lines[0]?.length === 0) {
    return ''
  }
  return lines
    .map((line, index) =>
      index === 0
        ? `  Before you delegate: ${line}`
        : `  ${line}`,
    )
    .join('\n')
}
