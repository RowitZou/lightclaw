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

Requires Node 22+, pnpm 10+, and Python 3. `WebFetch` in LocalRuntime uses the
environment helper script and requires `markdownify`:

```bash
python3 -m pip install --user markdownify
```

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
| `/sandbox reset` | Reset your Docker sandbox, preserving workspace files but discarding the container writable layer. |

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

For Feishu, `transport: "ws"` is the default and does not require a public webhook endpoint. If the Feishu app's long-connection events are not encrypted, `encryptKey` and `verificationToken` can be omitted for WS mode; when encryption is enabled, set `encryptKey` so incoming events can be decrypted. `allowUsers` and `allowChats` are checked only when the corresponding list is non-empty; if both lists are empty, every incoming message is dropped. Use `["*"]` to allow a dimension intentionally.

Feishu channel now supports interactive permission approval. In `default` / `acceptEdits` mode, write or execute tool calls that require confirmation send a Feishu approval card; the user can choose "yes" or "no". If card buttons are unavailable, replying with "yes" / "no" works as a text fallback, and replying "cancel" clears a stuck pending approval. For card buttons to work, enable the bot's interactive card capability and subscribe the `card.action.trigger` callback in the Feishu developer console. Other non-interactive channels still deny ask-style tool calls. For a trusted personal bot, you can also configure the channel baseline as `bypassPermissions` and rely on identity pairing, allowlists, permission ceiling, and the workspace boundary as the safety rails.

---

## Runtime Boundary

Phase 10 removes the old "project cwd" mental model. File tools and Bash run inside the current user's private workspace:

```text
~/.lightclaw/workspaces/<canonical_user>/
```

Phase 11 Iter 3 removes the old path-string guard layer. Safety is now split by runtime:

- `local` is single-user and admin-only. A paired non-admin channel user is rejected before runtime acquisition.
- `docker` gives every canonical user an isolated long-lived container. The workspace is mounted at `/workspace`, and additional mounts can be `rw` or `ro`.
- Permission modes and rules still apply to tool risk (`safe` / `write` / `execute`), but they are no longer used as a fake filesystem sandbox.

---

## Execution Runtime

Tool execution goes through a `Runtime` abstraction (`src/runtime/`). The active backend is selected at startup via `~/.lightclaw/config.json` or `LIGHTCLAW_RUNTIME_BACKEND`.

| Backend | Status | What it does |
|---|---|---|
| `local` (default) | shipped (Phase 11 Iter 1-Redesign + Iter 3 gate) | Runs the environment view on the host: `Bash` / `Grep` via `/bin/bash -c`, file tools through `runtime.fs`, and Web tools through Python helper scripts. No isolation; admin-only. |
| `docker` | shipped (Phase 11 Iter 2) | Runs environment-domain tools inside a per-user long-lived Docker container. The user workspace is bind-mounted at `/workspace`; helper scripts live at `/opt/lightclaw/sandbox-helpers`; idle containers are stopped and later restarted with their writable layer preserved. |
| `rjob` | not yet implemented | Will submit cluster jobs via `rjob` (kubebrain), reusing gpfs as the shared workspace mount. |

Selecting a backend that is not yet implemented fails loudly at startup — the harness never silently falls back.

The Runtime layer is a forward-compatible foundation: adding a backend means writing one file in `src/runtime/`; the tools never change. Environment tools see one runtime view through `runtime.exec` and `runtime.fs` (`Bash`, `Grep`, `Read`, `Write`, `Edit`, `Glob`, `WebFetch`, `WebSearch`). Host-domain tools keep using trusted LightClaw state (`Memory*`, `Conversation*`, `TodoWrite`, `AgentTool`, `UseSkill`, MCP).

```jsonc
{
  "runtime": {
    "backend": "docker",
    "docker": {
      "image": "ghcr.io/rowitzou/lightclaw-sandbox:0.1.0",
      "idleTimeoutMs": 1800000,
      "memoryLimit": "4g",
      "cpuLimit": 4,
      "network": "bridge",
      "tmpfs": ["/tmp"],
      "mounts": [
        { "host": "${HOME}/.cache/pip", "container": "/root/.cache/pip", "mode": "rw" },
        { "host": "/data/datasets", "container": "/data", "mode": "ro" }
      ],
      "env": {
        "http_proxy": "http://127.0.0.1:1080",
        "https_proxy": "http://127.0.0.1:1080"
      },
      "autoPull": true
    }
  }
}
```

Docker backend notes:

- Requires Docker 20.10+ and permission to access the Docker daemon.
- The default image is `ghcr.io/rowitzou/lightclaw-sandbox:<package.json version>` unless `runtime.docker.image`, `runtime.docker.imageOverride`, or `LIGHTCLAW_DOCKER_IMAGE` is set.
- One canonical user maps to one container named `lightclaw-sandbox-<user>-<deploymentHash>`, shared by terminal, Feishu, and WeChat sessions.
- Read-only mounts use Docker's `:ro` bind option. The kernel rejects writes, metadata changes, truncates, and deletes inside that mount with `EROFS`, which is the recommended mode for datasets and model checkpoints.
- Idle stop uses `docker stop`, not `docker rm`: workspace files and the container writable layer survive. `/sandbox reset` removes the container and recreates it on the next environment tool call.
- Docker image publishing is defined in `.github/workflows/sandbox-image.yml`; the image contains Debian 12 slim, Bash/coreutils, ripgrep, git, curl, Python 3, build-essential, and the sandbox helpers.

---

## Tools, Skills, MCP, Hooks

The model can still use the Phase 1-9 toolset: filesystem tools, Bash, web fetch/search, memory tools, conversation tools, TodoWrite, sub-agents, MCP tools, and `UseSkill`.

Each tool is explicitly marked as either `environment` or `host`. New environment tools must route filesystem, process, glob, and arbitrary network effects through `context.runtime`; they should not directly import host `fs`, `child_process`, HTTP clients, or glob libraries.

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
| `LIGHTCLAW_RUNTIME_BACKEND` | Execution runtime backend: `local` (default), `docker`, or future `rjob` |
| `LIGHTCLAW_DOCKER_IMAGE` | Override DockerRuntime image |
| `LIGHTCLAW_DOCKER_IDLE_TIMEOUT_MS` | Override DockerRuntime idle stop timeout |

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
├── commands/           # /help, /model, /mode, /sandbox, /identity, /ceiling, channel dispatch
├── channels/           # Feishu / WeChat runners, runner strategy, session lock
├── identity/           # canonical users, pairing, workspaces, secure JSON state
├── permission/         # mode/rule policy and skill tool boundaries
├── tools/              # built-in tools (Read, Write, Edit, Bash, Grep, Glob, ...)
├── runtime/            # Runtime abstraction; LocalRuntime, DockerRuntime, future Rjob
├── agents/             # general-purpose / explore subagents
├── skill/              # loader, registry, bundled skills (verify, remember)
├── memory/             # LIGHTCLAW.md discovery and user memory
├── session/            # transcript JSONL + meta + auto-compact
├── mcp/                # MCP client
├── hooks/              # lifecycle hook loader
├── todos/              # TodoWrite store
└── provider/           # Anthropic / OpenAI-compatible providers
scripts/
└── sandbox-helpers/    # Python helpers executed through Runtime (WebFetch / WebSearch / Glob)
```

## License

MIT
