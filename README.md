# LightClaw

[中文说明](./README.zh-CN.md) · English

LightClaw is a self-hosted personal AI assistant that lives in your terminal and, optionally, in Feishu / WeChat. It is a from-scratch TypeScript / Node.js agent harness inspired by Claude Code, but Phase 10 intentionally hides most harness internals from the user surface.

The default experience is simple: start `lightclaw`, chat naturally, and let the assistant use tools, memory, skills, and channels behind the scenes.

---

## Quick Start

```bash
pnpm install
pnpm dev                 # tsx src/cli.ts — fastest iteration, no build needed
# or
pnpm build && pnpm start # build to dist/cli.js then run with node
```

Requires Node 22+ and pnpm 10+.

Put credentials in `~/.lightclaw/config.json` or environment variables:

```jsonc
{
  "provider": "anthropic",
  "providerOptions": {
    "anthropic": {
      "apiKey": "sk-..."
    }
  }
}
```

On first interactive launch, LightClaw creates the single v1 admin identity. Later terminal launches auto-resume the latest session for that user.

---

## CLI Surface

```bash
lightclaw
lightclaw --prompt "Help me plan today"
lightclaw --resume
lightclaw --resume <session-id>
lightclaw --help
```

Removed Phase 9 CLI flags are now config/env driven:

- Model/provider: `~/.lightclaw/config.json`, `LIGHTCLAW_MODEL`, `LIGHTCLAW_PROVIDER`
- Feature toggles: `LIGHTCLAW_NO_MEMORY=1`, `LIGHTCLAW_NO_MCP=1`, `LIGHTCLAW_NO_HOOKS=1`
- Permission rules: edit `~/.lightclaw/permissions.json`
- Identity management: `/identity ...` slash command
- Channels: enable them in `~/.lightclaw/channels.json`; `lightclaw` starts enabled channels automatically

---

## Slash Commands

User-visible commands:

| Command | Purpose |
|---|---|
| `/help` | Show current model/mode, available models/modes, skills, and commands. |
| `/model <name>` | Switch the current session model. |
| `/mode <mode>` | Switch permission mode within the current ceiling. |

Admin-only commands:

| Command | Purpose |
|---|---|
| `/identity list|pending|approve|reject|link|unlink|remove` | Manage pairing and user bindings. |
| `/ceiling <default|plan|acceptEdits|bypassPermissions>` | Set the permission ceiling for identities. |

Channel messages that begin with `/` are dispatched locally too, so the admin can approve a pairing code from their own Feishu / WeChat account.

### Permission Modes And Ceiling

Four permission modes from strictest to loosest:

| Mode | What runs without asking |
|---|---|
| `plan` | Read and search tools. Write, edit, execute, network fetch, and subagent tools are denied. |
| `default` | Read and search tools. Write, edit, execute, network fetch, and subagent tools ask for confirmation (interactive) or are denied (non-interactive). |
| `acceptEdits` | Read, search, write, and edit tools. Execute, network fetch, and subagent tools still ask. |
| `bypassPermissions` | Everything runs without prompting. |

`/mode <m>` is allowed only when `m` is at least as strict as the current ceiling. Default ceiling is `default`, which lets users opt into the safer `plan` or stay on `default`. To allow looser modes, the admin must bump the ceiling first:

```text
/ceiling bypassPermissions   # admin: raise ceiling for everyone (admin included)
/mode bypassPermissions      # then any user can switch
```

This two-step flow applies to the admin too — there is no environment variable shortcut.

---

## Identity And Channels

Unknown Feishu / WeChat senders receive a pairing code. The admin approves it with:

```text
/identity approve K7YQ3RPA --as alice
```

Each canonical user gets:

- user-scoped memory at `~/.lightclaw/memory/<user>/`
- session metadata tagged with `userId`
- channel sessions like `feishu-alice` and `wechat-alice`
- a private workspace at `~/.lightclaw/workspaces/<user>/`

Channels are configured in `~/.lightclaw/channels.json`. Set `enabled: true` for the channels you want the main `lightclaw` process to start.

---

## Workspace Boundary

Phase 10 removes the old "project cwd" mental model. File tools and Bash run inside the current user's private workspace:

```text
~/.lightclaw/workspaces/<canonical_user>/
```

`Read` / `Write` / `Edit` / `Glob` / `Grep` resolve their target path against the workspace before normal permission rules run; anything outside is denied. The boundary fires **before** the rule chain, so `bypassPermissions` mode does not lift it.

`Bash` runs with `cwd` set to the workspace and rejects, before exec:

- absolute paths outside the workspace, including those introduced by IO redirection (`cat </etc/x`, `echo >/tmp/y`), pipes (`cmd|/etc/x`), separators (`cmd;/etc/x`, `cmd&/etc/x`), and subshell parentheses (`(/etc/x)`)
- relative escapes via `..`
- tilde expansion in any form: `~/foo`, `~user/...`, bare `~` followed by whitespace or end-of-command
- `$HOME` / `${HOME}` references
- `cd` / `pushd` without an explicit in-workspace path

This is still not a real process sandbox. The following are accepted bypass classes that a real container will close in a later phase:

- `eval` and other indirect string evaluation (`bash -c "$var"`)
- variable interpolation that hides absolute paths (`p=/etc; cat $p/passwd`)
- symlinks placed inside the workspace pointing outward

---

## Execution Runtime

Tool execution goes through a `Runtime` abstraction (`src/runtime/`). The active backend is selected at startup via `~/.lightclaw/config.json` or `LIGHTCLAW_RUNTIME_BACKEND`.

| Backend | Status | What it does |
|---|---|---|
| `local` (default) | shipped (Phase 11 Iter 1) | Runs `Bash` / `Grep` via host `/bin/bash -c` and `Read` / `Write` / `Edit` via host `fs.*`. No isolation; equivalent to the prior behavior. |
| `docker` | not yet implemented | Will run a long-lived host container with workspace bind-mounted, executing tools via `docker exec` with `--cap-drop ALL` plus minimal caps. |
| `rjob` | not yet implemented | Will submit cluster jobs via `rjob` (kubebrain), reusing gpfs as the shared workspace mount. |

Selecting a backend that is not yet implemented fails loudly at startup — the harness never silently falls back.

The Runtime layer is a forward-compatible foundation: adding a backend means writing one file in `src/runtime/`; the tools never change. File operations go through the backend's `fs` interface but, by design, all current backends back `fs` with the host process reading the shared workspace mount, so file ops stay fast and the only thing that crosses the container boundary is `exec`.

```jsonc
{
  "runtime": {
    "backend": "local"
  }
}
```

---

## Tools, Skills, MCP, Hooks

The model can still use the Phase 1-9 toolset: filesystem tools, Bash, web fetch/search, memory tools, conversation tools, TodoWrite, sub-agents, MCP tools, and `UseSkill`.

Skills are no longer invoked through `/skill`. Their descriptions use `TRIGGER` / `SKIP` guidance, and the model should call `UseSkill` naturally when a skill matches the task. `allowed_tools` is now enforced while a skill is active.

MCP servers and hooks remain admin configuration files under `~/.lightclaw/`; user-facing MCP and hook slash commands were removed.

---

## Configuration Notes

Selected environment variables:

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` | Anthropic credentials |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` | OpenAI-compatible credentials |
| `LIGHTCLAW_PROVIDER` | `anthropic` or `openai` |
| `LIGHTCLAW_MODEL` | Default model |
| `LIGHTCLAW_ALLOWED_MODELS` | Comma-separated model allowlist for `/model` |
| `LIGHTCLAW_NO_MEMORY` / `LIGHTCLAW_NO_MCP` / `LIGHTCLAW_NO_HOOKS` | Disable subsystems |
| `LIGHTCLAW_PERMISSION_MODE` | Default permission mode |
| `LIGHTCLAW_RUNTIME_BACKEND` | Execution runtime backend: `local` (default), `docker` / `rjob` not yet implemented |

---

## Contributor Map

```text
src/
├── cli.ts              # tiny CLI surface, auto-resume, channel auto-start
├── init.ts             # config + workspace-scoped state initialization
├── init-wizard.ts      # first-run admin setup, terminal user resolution
├── repl.ts             # readline REPL + slash dispatch
├── query.ts            # main agent loop (tool dispatch, auto-compact)
├── prompt.ts           # system prompt builder
├── state.ts            # process-level session state singleton
├── commands/           # /help, /model, /mode, /identity, /ceiling, channel dispatch
├── channels/           # Feishu / WeChat runners, runner strategy, session lock
├── identity/           # canonical users, pairing, workspaces, secure JSON state
├── permission/         # mode/rule policy plus hard workspace boundary
├── tools/              # built-in tools (Read, Write, Edit, Bash, Grep, Glob, ...)
├── runtime/            # Runtime abstraction; LocalRuntime today, Docker / Rjob to come
├── agents/             # general-purpose / explore subagents
├── skill/              # loader, registry, bundled skills (verify, remember)
├── memory/             # LIGHTCLAW.md discovery and user memory
├── session/            # transcript JSONL + meta + auto-compact
├── mcp/                # MCP client
├── hooks/              # lifecycle hook loader
├── web/                # WebFetch / WebSearch helpers
├── todos/              # TodoWrite store
└── provider/           # Anthropic / OpenAI-compatible providers
```

## License

MIT
