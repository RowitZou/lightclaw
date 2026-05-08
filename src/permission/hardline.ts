// Hardline blocklist — unconditional deny of catastrophic shell commands,
// independent of permission mode / ceiling / per-rule allow / bypass.
//
// Where the high-risk classifier (`high-risk.ts`) hardens the ASK flow by
// hiding the "以后都允许" button, hardline hardens the BYPASS flow. Under
// `mode = bypassPermissions` (or any explicit `Bash:*` allow rule) the policy
// would otherwise return `allow` directly and let the agent fire `rm -rf /`.
// Hardline runs as the very first check in `evaluatePermission` and returns a
// non-overridable deny when the command matches any pattern below.
//
// Scope: Bash only. Patterns target shell commands whose blast radius is the
// host filesystem (or the entire container's filesystem when running in
// Docker) — operations with no recoverable downside if blocked. A user who
// genuinely needs `mkfs` on a real device should run it outside the agent.
//
// Design rules for adding a pattern:
//   1. Blast radius must be unrecoverable (data destruction, system halt,
//      privilege loss). Merely "risky" goes in `high-risk.ts`, not here.
//   2. False positives are user-visible errors with no override path. Be
//      tight: prefer narrow regex over broad heuristic.
//   3. Don't list things already covered by Docker/Rjob isolation when a
//      bypass-allowed Bash on the host would be the only failure mode —
//      e.g. `chown -R / ...` is destructive but only on the host's perspective
//      of LocalRuntime, which is admin-only by policy. If we add such a rule
//      it should be because of the LocalRuntime case.

import { splitBashCommand } from './bash-parse.js'

export type HardlineMatch = {
  ruleId: string
  description: string
  segment: string
}

const FORK_BOMB_RE = /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/

const SHUTDOWN_HEADS = new Set(['shutdown', 'reboot', 'halt', 'poweroff'])

// Raw block devices and partition prefixes whose corruption is unrecoverable.
// `loop*` is included because writing to a loop device backing a critical
// mount has the same effect as writing to its source file.
const DISK_DEVICE_RE = /^\/dev\/(?:sd[a-z]|nvme\d|hd[a-z]|xvd[a-z]|mmcblk\d|vd[a-z]|loop\d)/

// Targets that mean "the root filesystem" once paired with `rm -r`. We keep
// this list explicit instead of pattern-matching `/.*` so a benign
// `rm -rf /tmp/foo` doesn't trip the rule.
const ROOT_TARGETS = new Set(['/', '/*', '/.', '/..', '~', '~/'])

export function findHardlineMatch(command: string): HardlineMatch | null {
  // Whole-command scans first — fork-bomb syntax intentionally spans
  // operators (`(` `)` `{` `}` `;` `|`) and would be lost after splitting.
  if (FORK_BOMB_RE.test(command)) {
    return {
      ruleId: 'fork-bomb',
      description: 'classic shell fork-bomb pattern',
      segment: command.trim(),
    }
  }

  // Redirection-to-disk-device. `splitBashCommand`'s segment scrubber
  // strips redirections, so we scan the raw command text for `> /dev/sdX`
  // before splitting.
  const redir = />>?\s*(\/dev\/[A-Za-z0-9]+)/.exec(command)
  if (redir && DISK_DEVICE_RE.test(redir[1]!)) {
    return {
      ruleId: 'redirect-disk',
      description: `redirect to a raw disk device (${redir[1]})`,
      segment: command.trim(),
    }
  }

  for (const segment of splitBashCommand(command)) {
    const match = matchSegment(segment)
    if (match) return match
  }
  return null
}

function matchSegment(segment: string): HardlineMatch | null {
  const tokens = tokenize(segment)
  if (tokens.length === 0) return null

  // Strip absolute path so `/sbin/shutdown` and `shutdown` both match.
  const head1 = tokens[0]!.split('/').filter(Boolean).pop() ?? tokens[0]!

  // 1. rm -r / -R against the root filesystem.
  if (head1 === 'rm' && matchesRmRoot(tokens)) {
    return {
      ruleId: 'rm-rf-root',
      description: 'rm -r against a root-level path',
      segment,
    }
  }

  // 2. mkfs / mkfs.<fs> formats a block device.
  if (head1 === 'mkfs' || head1.startsWith('mkfs.')) {
    return {
      ruleId: 'mkfs',
      description: 'mkfs formats a block device',
      segment,
    }
  }

  // 3. dd of=/dev/sdX writes raw blocks to a disk.
  if (head1 === 'dd') {
    for (const t of tokens) {
      const m = /^of=(.+)$/.exec(t)
      if (m && DISK_DEVICE_RE.test(m[1]!)) {
        return {
          ruleId: 'dd-disk',
          description: `dd writing to a raw disk device (${m[1]})`,
          segment,
        }
      }
    }
  }

  // 4. shutdown / reboot / halt / poweroff stop or restart the host.
  if (SHUTDOWN_HEADS.has(head1)) {
    return {
      ruleId: 'shutdown',
      description: `${head1} stops or restarts the host`,
      segment,
    }
  }

  // 5. init 0 / init 6 (legacy paths to halt and reboot).
  if (head1 === 'init' && tokens[1] && /^[06]$/.test(tokens[1])) {
    return {
      ruleId: 'init-runlevel',
      description: 'init 0/6 stops or reboots the host',
      segment,
    }
  }

  return null
}

function matchesRmRoot(tokens: string[]): boolean {
  let recursive = false
  let noPreserveRoot = false
  const targets: string[] = []

  for (const tok of tokens.slice(1)) {
    if (tok === '--recursive') recursive = true
    else if (tok === '--no-preserve-root') noPreserveRoot = true
    else if (tok === '--') continue
    else if (/^-[A-Za-z]+$/.test(tok)) {
      // Combined short flags like `-rf`, `-fR`. r or R = recursive.
      if (tok.includes('r') || tok.includes('R')) recursive = true
    } else if (!tok.startsWith('-')) {
      targets.push(stripQuotes(tok))
    }
  }

  if (!recursive) return false

  // GNU rm refuses to operate on `/` unless `--no-preserve-root` is given —
  // so the flag's only purpose is to bypass that guard. Treat its presence as
  // an unconditional trip even without an explicit root target, because a
  // glob like `$ROOT_DIR` could resolve to `/` at runtime.
  if (noPreserveRoot) return true

  return targets.some(t => ROOT_TARGETS.has(t))
}

// Lightweight argv tokenizer. We strip leading `VAR=value ` env assignments
// and split on whitespace, preserving quoted runs as single tokens. This is
// looser than a real shell parser but tight enough for hardline: the rules
// only care about the head and a handful of literal-shaped args (`/`,
// `of=/dev/sda`, runlevel digits).
function tokenize(segment: string): string[] {
  const stripped = segment.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '')
  const tokens = stripped.match(/"[^"]*"|'[^']*'|\S+/g)
  return tokens ?? []
}

function stripQuotes(token: string): string {
  if (token.length >= 2) {
    const first = token[0]
    const last = token[token.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return token.slice(1, -1)
    }
  }
  return token
}
