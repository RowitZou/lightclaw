import path from 'node:path'
import { URL } from 'node:url'

import type { PermissionRuleValue } from './types.js'

const CHAIN_OPERATORS = /[;&|]/

// Bash suggestions go from precise to broad: "<head1> <head2>:*" ⊃
// "<head1>:*" ⊃ "Bash". Chained commands (anything containing ; & |) skip
// head extraction because matchBashCommand only looks at the first two
// tokens of the *whole* command string — picking a head off chained input
// would let users grant a rule that quietly covers the trailing commands
// they did not see.
export function suggestBashRules(command: string): PermissionRuleValue[] {
  const trimmed = command.trim()
  const fallback: PermissionRuleValue = { toolName: 'Bash' }

  if (!trimmed || CHAIN_OPERATORS.test(trimmed)) {
    return [fallback]
  }

  const tokens = trimmed.split(/\s+/).filter(Boolean)
  const head1 = tokens[0]
  const head2 = tokens[1]

  const out: PermissionRuleValue[] = []
  if (head1 && head2) {
    out.push({ toolName: 'Bash', ruleContent: `${head1} ${head2}:*` })
  }
  if (head1) {
    out.push({ toolName: 'Bash', ruleContent: `${head1}:*` })
  }
  out.push(fallback)
  return out
}

// Edit/Write/Read suggestions: "<dir>/**" ⊃ "<dir>/*" ⊃ "<toolName>".
// Relative paths skip the dir-prefix tier because matchPath resolves
// against process.cwd() — the relative input could mean a different dir
// later in the session and grant the wrong scope.
export function suggestPathRules(
  toolName: 'Edit' | 'Write' | 'Read',
  filePath: string,
): PermissionRuleValue[] {
  const fallback: PermissionRuleValue = { toolName }

  if (!filePath || !path.isAbsolute(filePath)) {
    return [fallback]
  }

  const dir = path.dirname(filePath).replace(/\\/g, '/')
  if (!dir || dir === '/' || dir === '.') {
    return [fallback]
  }

  return [
    { toolName, ruleContent: `${dir}/**` },
    { toolName, ruleContent: `${dir}/*` },
    fallback,
  ]
}

// WebFetch suggestions: exact hostname ⊃ "*.<root>" ⊃ "WebFetch". v1
// derives "*.<root>" by stripping everything before the first dot, which
// covers single-label subdomains (api.github.com → *.github.com) but not
// multi-label public suffixes (example.co.uk → *.co.uk would be wrong).
// Users with eTLD-edge cases can write the rule by hand.
export function suggestWebFetchRules(url: string): PermissionRuleValue[] {
  const fallback: PermissionRuleValue = { toolName: 'WebFetch' }
  let hostname: string
  try {
    hostname = new URL(url).hostname
  } catch {
    return [fallback]
  }
  if (!hostname) {
    return [fallback]
  }

  const out: PermissionRuleValue[] = [
    { toolName: 'WebFetch', ruleContent: hostname },
  ]

  const dotIndex = hostname.indexOf('.')
  if (dotIndex > 0 && dotIndex < hostname.length - 1) {
    const wildcard = `*.${hostname.slice(dotIndex + 1)}`
    if (wildcard !== `*.${hostname}`) {
      out.push({ toolName: 'WebFetch', ruleContent: wildcard })
    }
  }

  out.push(fallback)
  return out
}

// MCP suggestions: "<server>:<tool>" ⊃ "<server>:*" ⊃ "MCP".
export function suggestMcpRules(
  server: string | undefined,
  toolName: string | undefined,
): PermissionRuleValue[] {
  const fallback: PermissionRuleValue = { toolName: 'MCP' }
  if (!server || !toolName) {
    return [fallback]
  }
  return [
    { toolName: 'MCP', ruleContent: `${server}:${toolName}` },
    { toolName: 'MCP', ruleContent: `${server}:*` },
    fallback,
  ]
}
