export const DISPATCH_BRIEF_LIST_ROLE_SKILL_FOOTER =
  "If you haven't worked with a worker yet, call ListRoleSkill with its role name before delegating to it — it tells you what to settle with the requester up front and what the worker handles on its own. Once you know a role, you needn't call it again before every dispatch."

export const DISPATCH_BRIEF_LIST_ROLE_SKILL_DESCRIPTION =
  "Returns the worker's pre-dispatch brief: its standing contract — what to settle before delegating to it at all — plus, for each on-demand skill it can invoke, what to pin down first and what to leave to the worker."

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
