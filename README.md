# LightClaw

[中文说明](./README.zh-CN.md) · English

LightClaw is a self-hosted personal AI assistant. It runs in your terminal, talks to you on Feishu and WeChat, and remembers what you tell it across sessions. One install, your own machine, no SaaS account.

### What you can do with it

- **One assistant, every channel.** Same conversation, same memory, whether you open the terminal or message it from Feishu / WeChat.
- **Let it actually do things.** It writes and edits files, runs shell commands, fetches web pages, and calls your MCP servers — inside a sandbox so it can't touch the rest of your machine.
- **Approve risky actions in plain language.** When the model wants to do something irreversible, you see a clear yes/no — or pick "approve everything like this" once and move on.
- **Keep long work coherent.** It remembers project conventions, things you've corrected, ongoing tasks, and pulls the right notes back into context when they matter — even after the conversation has been auto-compacted.
- **Bring your own model and tools.** Anthropic and OpenAI-compatible APIs, MCP servers, and your custom hooks all plug in.

Architecture, design notes, and dev history live in the [project wiki repo](https://github.com/RowitZou/lightclaw_dev_log).

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
| `/help` | Show what's available right now (model, mode, skills, commands). |
| `/model <name>` | Switch the model the assistant is using. |
| `/mode <mode>` | Switch how strict permission checks are. |
| `/permissions` | View, clear, or add per-session permission rules. |
| `/sandbox` | Inspect or reset the assistant's sandboxed work environment. |

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

Feishu defaults to a long-connection (WS) transport, so you don't need a public webhook endpoint. WeChat uses iLink's QR-login flow.

When the assistant wants to do something that needs confirmation, it sends an interactive card with three buttons:

- **Approve once** — let it do this exact thing this time.
- **Approve everything like this** — the card label shows what scope you're approving (e.g. "any `pip install`" rather than "all Bash"), so you can broaden safely without unlocking the whole tool.
- **Deny** — say no, the assistant gets the message.

Reply `1` / `2` / `3` if the buttons aren't available. For trusted personal-bot setups, set the channel mode to `bypassPermissions` and use `permissions.json`'s `ask` list to keep the dangerous things confirmable (e.g. `"ask": ["Bash(rm:*)"]`).

---

## Sandbox

By default, the assistant's tools — Bash, file reads/writes, web fetches — run inside a Docker container, not on your host. So a misbehaving model can't `rm -rf` your home directory, and you can hand the bot to a friend on Feishu without giving them shell on your machine.

You don't need to set up the container yourself. At startup LightClaw pulls a public image (`ghcr.io/rowitzou/lightclaw-sandbox`) in the background, and tool calls degrade to chat-only until it's ready — so the first conversation never hangs. The image ships with the daily-driver toolkit (jq, sqlite, ripgrep, Python data-science stack, Node 22) so the assistant can do real work right away.

Each user gets their own long-lived container. Workspace files survive container restarts; only the writable layer (e.g. `pip install`s) is reset by `/sandbox reset`.

**Single-user setup** — set `runtime.backend: "local"` for less overhead. Local mode is admin-only; channel users are refused.

**Custom or air-gapped images** — set `runtime.docker.imageOverride` to your tag in `~/.lightclaw/config.json`, restart LightClaw.

```jsonc
{
  "runtime": {
    "backend": "docker",
    "docker": {
      "memoryLimit": "4g",
      "cpuLimit": 4,
      "mounts": [
        { "host": "/data/datasets", "container": "/data", "mode": "ro" }
      ]
    }
  }
}
```

For datasets / model checkpoints, mount them with `mode: "ro"` — the assistant can read but the kernel rejects writes. See [`info/env.md`](https://github.com/RowitZou/lightclaw_dev_log/blob/main/env.md) for the full config reference.

---

## What the assistant can use

- **Files & shell** — `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`
- **Web** — `WebFetch` (URL → readable Markdown), `WebSearch`
- **Task tracking** — `TodoWrite` for multi-step plans
- **Sub-agents** — spin up parallel `general-purpose` or `explore` agents for fan-out work
- **Skills** — small bundles of focused capability (`verify`, `remember`, …); the model picks them up automatically when relevant, no manual invocation
- **MCP servers** — admin-configured external tools, available to the model as `mcp__<server>__<tool>`

All of the above respect the same permission flow described above.

---

## Memory

LightClaw remembers three things:

- **Your project.** Drop a `LIGHTCLAW.md` into your repo and the assistant reads it every session, the same way Claude Code does. Add `LIGHTCLAW.local.md` for things you don't want to commit.
- **You.** It builds a profile of your role, preferences, and corrections you've made — across sessions and channels. When you start a new conversation, the most relevant pieces come back automatically; you don't re-explain who you are.
- **The current task.** Inside a long session it keeps a working notebook (what you're doing, files touched, decisions made, what's next). When the conversation gets too long and auto-compacts, those hard facts survive — the thread doesn't reset.

Disable everything with `LIGHTCLAW_NO_MEMORY=1`. Finer toggles are listed below.

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
| `LIGHTCLAW_NO_MEMORY` / `LIGHTCLAW_NO_MCP` / `LIGHTCLAW_NO_HOOKS` | Disable a subsystem entirely |
| `LIGHTCLAW_MEMORY_RECALL_*` / `LIGHTCLAW_SESSION_MEMORY_*` / `LIGHTCLAW_PRE_COMPACT_FLUSH_*` | Fine-grained memory toggles and thresholds (see [`info/env.md`](https://github.com/RowitZou/lightclaw_dev_log/blob/main/env.md)) |
| `LIGHTCLAW_PERMISSION_MODE` | Default permission mode |
| `LIGHTCLAW_RUNTIME_BACKEND` | Execution runtime: `local`, `docker` (default for multi-user), or future `rjob` |
| `LIGHTCLAW_DOCKER_IMAGE` / `LIGHTCLAW_DOCKER_IDLE_TIMEOUT_MS` | Override sandbox image / idle stop timeout |

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
