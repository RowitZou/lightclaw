import path from 'node:path'
import { promises as fsp } from 'node:fs'

import { z } from 'zod'

import { buildTool } from '../tool.js'
import { getCurrentSessionContext } from '../session-context.js'
import type { Runtime } from '../runtime/index.js'

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 1000
const MAX_DEPTH = 100
// rg walk budget. The generic sandbox exec default (30s) was sized for
// commands, not full-tree walks: on a GPFS workspace with vendored clones a
// walk routinely needs more, and 2026-07-26 forensics showed Glob as the top
// silent 30s-timeout burner (28 hits that day, error text visible only to the
// model, never in daemon logs). 60s mirrors Claude Code's slow-filesystem
// (WSL) tier for the same rg invocation.
const RG_TIMEOUT_MS = 60_000
// Path-list buffer, Claude Code parity: a 200k-file monorepo emits ~16MB of
// paths; the old 1MiB cap silently chopped the list long before `limit` did.
const RG_MAX_BUFFER = 20 * 1024 * 1024
// Above this many matches the daemon-side global mtime sort is skipped (the
// result is a walk-order subset with a trailer telling the model to narrow).
// A pattern matching >10k files is already a "narrow this" case; statting all
// of them would re-create the very GPFS stat storm this sort strategy avoids.
const STAT_SORT_MAX = 10_000
const STAT_CONCURRENCY = 32

// `rg --files` walks the whole tree files-first; for a delegator role (main /
// any dispatcher) a flooded, truncated result is better handed off to a fresh
// localExplorer than retried inline. Mirrors `isDispatchTargetReachable`'s
// `'*' || includes(callee)` check without coupling this leaf tool to the
// agents policy layer, and stays safe outside any ALS scope (returns false).
function callerCanDispatchLocalExplorer(): boolean {
  const reachable = getCurrentSessionContext()?.currentRole?.reachableRoles
  return !!reachable?.some(r => r === '*' || r === 'localExplorer')
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function resolveSearchDir(cwd: string, inputPath?: string): string {
  if (!inputPath) return cwd
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(cwd, inputPath)
}

/** Claude Code parity (utils/glob.ts extractGlobBaseDirectory): rg's --glob
 *  only takes relative patterns, so an absolute pattern's static prefix (the
 *  part before the first `* ? [ {`) becomes the search dir and the remainder
 *  the pattern. Starting the walk at the deepest static directory is also a
 *  real cost cut on slow shared filesystems. Posix-only — worker paths are
 *  posix on every backend. */
export function extractGlobBaseDirectory(pattern: string): {
  baseDir: string
  relativePattern: string
} {
  const match = pattern.match(/[*?[{]/)
  if (!match || match.index === undefined) {
    return { baseDir: path.posix.dirname(pattern), relativePattern: path.posix.basename(pattern) }
  }
  const staticPrefix = pattern.slice(0, match.index)
  const lastSep = staticPrefix.lastIndexOf('/')
  if (lastSep === -1) return { baseDir: '', relativePattern: pattern }
  return {
    baseDir: staticPrefix.slice(0, lastSep) || '/',
    relativePattern: pattern.slice(lastSep + 1),
  }
}

const TIMEOUT_STDERR_PATTERN = /sandbox time limit|command timed out after/i

function isTimeoutResult(result: { stderr: string; exitCode: number }): boolean {
  return (
    TIMEOUT_STDERR_PATTERN.test(result.stderr) ||
    result.exitCode === 124 || result.exitCode === 137 || result.exitCode === 143
  )
}

function parseMatches(stdout: string, dropLastLine: boolean): string[] {
  let lines = stdout
    .split('\n')
    .map(line => (line.startsWith('./') ? line.slice(2) : line))
    .filter(Boolean)
  // A killed or buffer-capped rg can leave a torn final line; a clean rg exit
  // always terminates its output with a newline (the split leaves a trailing
  // '' that filter(Boolean) drops), so dropping the tail here never loses a
  // complete path.
  if (dropLastLine && lines.length > 0) lines = lines.slice(0, -1)
  return lines
}

/** Global mtime sort moved from the rg walk to the match list. `--sort=modified`
 *  forces rg single-threaded AND stats every file it walks — on a GPFS
 *  workspace that is the whole cost. Statting only the matches (bounded by
 *  STAT_SORT_MAX) preserves the oldest-first contract at a fraction of the
 *  metadata ops. Deliberate divergence from Claude Code, which runs on local
 *  disks where the in-walk sort is cheap; recorded in CLAUDE.md. */
async function sortByHostMtime(matches: string[], hostDir: string): Promise<string[]> {
  const entries = matches.map(rel => ({ rel, mtime: Number.MAX_SAFE_INTEGER }))
  for (let i = 0; i < entries.length; i += STAT_CONCURRENCY) {
    await Promise.all(
      entries.slice(i, i + STAT_CONCURRENCY).map(async entry => {
        try {
          const st = await fsp.stat(path.posix.join(hostDir, entry.rel))
          entry.mtime = st.mtimeMs
        } catch {
          // Vanished between walk and stat, or unreadable — sort last, keep
          // the path (the walk saw it; downstream tools will surface the
          // real error if the model touches it).
        }
      }),
    )
  }
  return entries
    .sort((a, b) => a.mtime - b.mtime || (a.rel < b.rel ? -1 : 1))
    .map(e => e.rel)
}

async function runRg(
  args: string[],
  cwd: string,
  runtime: Runtime,
  signal: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number; bufferCapped: boolean }> {
  const command = ['rg', ...args.map(shellQuote)].join(' ')
  const result = await runtime.exec({
    command,
    cwd,
    abortSignal: signal,
    timeoutMs: RG_TIMEOUT_MS,
    maxBufferBytes: RG_MAX_BUFFER,
  })
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    // `head -c` on the capture pipeline chops mid-line when the path list
    // hits the buffer cap, leaving a torn final line. Only flag the tear when
    // the output actually sits at the cap — a merely-missing trailing newline
    // on a clean exit (transport trimming) must not eat a real path.
    bufferCapped:
      !result.stdout.endsWith('\n') && result.stdout.length >= RG_MAX_BUFFER - 8192,
  }
}

function isCommandNotFound(result: { stderr: string; exitCode: number }): boolean {
  return result.exitCode === 127 && result.stderr.includes('command not found')
}

function formatResult(
  matches: string[],
  limit: number,
  pattern: string,
  searchDir: string,
  canDispatchLocalExplorer: boolean,
): string {
  if (matches.length === 0) {
    return `No files matched "${pattern}" under ${searchDir}.`
  }
  const truncated = matches.length > limit
  const shown = truncated ? matches.slice(0, limit) : matches
  const body = shown.join('\n')
  // On truncation, signpost the two ways to bound the result (narrow the
  // pattern/path, or cap recursion with maxDepth) and — only for a role that
  // can actually delegate to it — that a deeper sweep belongs on localExplorer.
  const dispatchHint = canDispatchLocalExplorer
    ? ' For deeper local exploration, dispatch localExplorer.'
    : ''
  const trailer = truncated
    ? `\n\n[showing first ${limit} of ${matches.length} matches; narrow the pattern/path or set maxDepth to bound recursion depth.${dispatchHint}]`
    : ''
  return `${body}${trailer}`
}

export const globTool = buildTool({
  name: 'Glob',
  whenToUse: `Find files by name pattern (\`**/*.ts\`, \`src/**/test-*.py\`).`,
  alwaysLoad: true,
  description: `- Fast file pattern matching tool that works with any codebase size.
- Supports glob patterns like "**/*.js" or "src/**/test-*.py".
- Returns matching file paths sorted by modification time (oldest first; most recently changed files appear at the end of the list — handy for "what just changed?").
- Use this tool when you need to find files by name pattern. For content search use Grep; for open-ended exploration ("anything about authentication?") use Dispatch with a focused worker role instead.`,
  domain: 'environment',
  riskLevel: 'safe',
  concurrencySafe: true,
  inputSchema: z.object({
    pattern: z
      .string()
      .min(1)
      .describe('Glob pattern, e.g. "**/*.ts" or "src/**/test-*.py".'),
    path: z
      .string()
      .optional()
      .describe(
        'Directory to search in. Defaults to the workspace root. Omit this field (do NOT pass "undefined" or "null") to use the default. Relative paths resolve against the workspace root.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LIMIT)
      .optional()
      .describe(
        `Max paths to return. Defaults to ${DEFAULT_LIMIT}; results beyond this are truncated with a hint to narrow the pattern.`,
      ),
    maxDepth: z
      .number()
      .int()
      .min(1)
      .max(MAX_DEPTH)
      .optional()
      .describe(
        'Max directory depth to descend, relative to the search path (1 = the directory itself, no recursion). Omit for a full recursive walk. Use a small value to bound a broad listing instead of flooding the whole tree.',
      ),
  }),
  async call(input, context) {
    // Absolute patterns: rg --glob only accepts relative patterns, and the
    // static prefix is a free walk-depth cut (Claude Code parity).
    let pattern = input.pattern
    let searchDir = resolveSearchDir(context.runtime.workspaceRoot, input.path)
    if (path.posix.isAbsolute(pattern)) {
      const extracted = extractGlobBaseDirectory(pattern)
      if (extracted.baseDir) {
        searchDir = extracted.baseDir
        pattern = extracted.relativePattern
      }
    }
    const limit = input.limit ?? DEFAULT_LIMIT
    // Host-visible search dirs (workspace / mounts on every backend, any path
    // on LocalRuntime) get the parallel walk + daemon-side mtime sort. A
    // container-local dir (/tmp, /scratch) keeps rg's in-walk --sort — those
    // trees live on genuine local disk where the single-threaded stat walk is
    // cheap, and the daemon cannot stat them anyway.
    const hostDir = context.runtime.paths?.toHostPath(searchDir) ?? null

    try {
      // Primary path: ripgrep `--files --glob <pattern>`. Same architecture
      // as Grep — runs as a runtime.exec command so the search executes on
      // whichever backend owns the workspace (Local on host, Docker inside
      // container, Rlaunch on cluster worker). rg is installed in the
      // sandbox image and on every dogfood host. Oldest-first mtime order is
      // the contract the description promises; on the host-visible path it
      // is produced by sortByHostMtime, otherwise by rg's --sort=modified.
      // Positional `.` + cwd=searchDir lets rg emit relative paths under
      // searchDir directly (matches Claude Code's Glob output shape).
      const rgArgs = [
        '--files',
        '--glob', pattern,
        ...(hostDir === null ? ['--sort=modified'] : []),
        '--no-ignore',
        '--hidden',
        ...(input.maxDepth !== undefined ? ['--max-depth', String(input.maxDepth)] : []),
        '.',
      ]
      const result = await runRg(rgArgs, searchDir, context.runtime, context.abortSignal)

      // `rg --files` exits 0 even when nothing matches. exit 1 is reserved
      // for the content-search "no matches" case, which doesn't apply
      // here; treat both as "no error" so an empty match returns the
      // friendly no-match message instead of an isError result.
      if (result.exitCode === 0 || result.exitCode === 1) {
        const matches = parseMatches(result.stdout, result.bufferCapped)
        if (hostDir === null || matches.length === 0) {
          return {
            output: formatResult(
              matches,
              limit,
              input.pattern,
              searchDir,
              callerCanDispatchLocalExplorer(),
            ),
          }
        }
        if (matches.length > STAT_SORT_MAX) {
          // Too many matches for a global sort: return a walk-order subset,
          // mtime-sorted within itself, and say so — a pattern this broad is
          // a narrow-it case either way.
          const subset = await sortByHostMtime(matches.slice(0, limit), hostDir)
          return {
            output:
              `${subset.join('\n')}\n\n[matched ${matches.length} files — beyond the ` +
              `${STAT_SORT_MAX}-file global mtime-sort cap, so this is a walk-order subset ` +
              `(mtime-sorted within itself). Narrow the pattern/path or set maxDepth.]`,
          }
        }
        const sorted = await sortByHostMtime(matches, hostDir)
        return {
          output: formatResult(
            sorted,
            limit,
            input.pattern,
            searchDir,
            callerCanDispatchLocalExplorer(),
          ),
        }
      }

      if (isTimeoutResult(result)) {
        // Salvage the partial walk instead of discarding it (Claude Code
        // parity: RipgrepTimeoutError carries partialResults). The daemon
        // stderr line exists because this failure otherwise surfaces ONLY in
        // the tool result the model sees — 2026-07-26 forensics found weeks
        // of these timeouts invisible to every log-based patrol.
        const partial = parseMatches(result.stdout, true)
        process.stderr.write(
          `[glob] rg timed out after ${Math.round(RG_TIMEOUT_MS / 1000)}s in ${searchDir} ` +
          `(pattern=${input.pattern}) — ${partial.length} partial paths salvaged\n`,
        )
        if (partial.length === 0) {
          return {
            output:
              `Glob timed out after ${Math.round(RG_TIMEOUT_MS / 1000)}s under ${searchDir} ` +
              `with no results yet. The tree is too large to walk in time — narrow the ` +
              `pattern/path, or set maxDepth to bound recursion.`,
            isError: true,
          }
        }
        const shown = hostDir !== null && partial.length <= STAT_SORT_MAX
          ? await sortByHostMtime(partial, hostDir)
          : partial
        const listed = shown.slice(0, limit)
        return {
          output:
            `${listed.join('\n')}\n\n[search timed out after ` +
            `${Math.round(RG_TIMEOUT_MS / 1000)}s; results are PARTIAL — ` +
            `${partial.length} paths walked before the cutoff. Narrow the pattern/path ` +
            `or set maxDepth for a complete listing.]`,
        }
      }

      if (isCommandNotFound(result)) {
        // Phase 35: no daemon-side fast-glob fallback (DataPlane.glob and
        // the sandbox glob.py helper were retired alongside this tool's
        // primary rg path). Return a self-healing message so the model
        // falls back to `Bash` (find / ls -R) on the same workspace.
        return {
          output:
            `rg not found in this runtime; Glob cannot operate. ` +
            `Use \`Bash\` with \`find\` or \`ls -R\` under ${searchDir} instead.`,
          isError: true,
        }
      }

      return {
        output: result.stderr.trim() || `rg --files exited with code ${result.exitCode}`,
        isError: true,
      }
    } catch (error) {
      return {
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      }
    }
  },
})
