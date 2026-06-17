import { homedir } from 'node:os'
import path from 'node:path'

// Single source of truth for the LightClaw user-level root and `~` expansion.
// All `~/.lightclaw/...` paths in src/ go through `lightclawHome()` so that a
// `LIGHTCLAW_HOME` env var or a `--home <path>` CLI flag can relocate the
// entire data layout (sessions / memory / config / identity / users /
// channels / mcp / state) — required for cluster deployments where the
// dev-machine home is not on shared storage.

let cliOverride: string | undefined

export function setLightclawHomeOverride(value: string | undefined): void {
  cliOverride = value
}

// Priority: CLI flag > env var > default `~/.lightclaw`.
// Not cached: cli.ts may set the override after a module top-level evaluator
// already invoked us once. The single `path.resolve` cost is negligible, and
// any caller that needs the value at module-init time should wrap it in a
// function (see process-lock.ts:lockPath).
export function lightclawHome(): string {
  const raw =
    cliOverride ??
    process.env.LIGHTCLAW_HOME ??
    path.join(homedir(), '.lightclaw')
  return path.resolve(expandHomePath(raw))
}

export function expandHomePath(input: string): string {
  if (input === '~') {
    return homedir()
  }

  if (input.startsWith('~/')) {
    return path.join(homedir(), input.slice(2))
  }

  return input
    .replace(/\$\{HOME\}/g, homedir())
    .replace(/\$\{USER\}/g, process.env.USER ?? '')
}
