# LightClaw

[中文说明](./README.zh-CN.md) · English

LightClaw is a self-hosted personal AI assistant. It runs in your terminal, talks to you on Feishu, and remembers what you tell it across sessions. One install, your own machine, no SaaS account.

### What you can do with it

- **One assistant, every channel.** Same conversation, same memory, whether you open the terminal or message it from Feishu.
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

Drop a minimal `~/.lightclaw/config.json` to get started — see [Configuration](#configuration) below for the full template:

```jsonc
{
  "provider": "anthropic",
  "providerOptions": {
    "anthropic": {
      "apiKey": "<your-anthropic-api-key>"
    }
  },
  "model": "claude-sonnet-4-6"
}
```

On first interactive launch, LightClaw creates the single v1 admin identity. Later terminal launches auto-resume the latest session for that user.

To put state on shared storage instead of `~/.lightclaw` (e.g. so a cluster dev box reset doesn't wipe your sessions / memory / identities), point `LIGHTCLAW_HOME` at a network mount before starting:

```bash
export LIGHTCLAW_HOME=<absolute-path-on-shared-storage>/lightclaw
```

The same flag also works as `lightclaw --home <path>` for one-shot debugging. See [`info/env.md`](https://github.com/RowitZou/lightclaw_dev_log/blob/main/env.md) for migration notes.

---

## Configuration

Everything lives in `<LIGHTCLAW_HOME>/config.json` (default `~/.lightclaw/config.json`). The full annotated template:

```jsonc
{
  // --- Provider & model ---
  "provider": "anthropic",                      // "anthropic" | "openai"
  "providerOptions": {
    "anthropic": {
      "apiKey": "<your-anthropic-api-key>",
      "baseUrl": "<https://your-anthropic-endpoint>"   // optional; omit for the official endpoint
    },
    "openai": {                                  // only needed if provider = "openai"
      "apiKey": "<your-openai-compatible-key>",
      "baseUrl": "<https://your-openai-compatible-endpoint>"
    }
  },
  "model": "claude-sonnet-4-6",                 // default model; /model can switch at runtime
  "allowedModels": ["claude-sonnet-4-6", "claude-opus-4-7"],   // optional /model allowlist

  // Optional per-role routing — anything missing falls back to "model"
  "routing": {
    "main":      "claude-sonnet-4-6",           // main agent loop
    "compact":   "claude-haiku-4-5",            // auto-compact summarizer
    "extract":   "claude-haiku-4-5",            // memory extraction / micro-compact
    "webSearch": "claude-haiku-4-5"             // WebSearch helper queries
  },

  // --- Tool-specific config ---
  "tools": {
    "webSearch": {
      "braveApiKey": "<your-brave-search-api-key>"   // optional; falls back to DDG HTML
    }
  },

  // --- Storage layout (all optional) ---
  // Defaults are <LIGHTCLAW_HOME>/{sessions,memory,workspaces}; override individually
  // when, e.g., you want big workspaces on a separate disk.
  "sessionsDir":   "<absolute-path-for-sessions>",
  "memoryDir":     "<absolute-path-for-memory>",
  "workspaceRoot": "<absolute-path-for-workspaces>",

  // --- Runtime backend (where Bash / Read / Write actually run) ---
  "runtime": {
    "backend": "docker",                        // "local" (admin-only) | "docker" | "rlaunch"

    // Optional in-process forward proxy for backends that need a host-side egress
    // (docker host networking, rlaunch pods that can't reach the internet directly).
    "network": {
      "mode": "host",                           // "host" enables the bridge; "isolated" disables it
      "upstream": "inherit",                    // "inherit" | "direct" | "<http://upstream-proxy:port>"
      "port": 18080,
      "bindHost": "0.0.0.0",
      "acl": ["127.0.0.0/8", "<your-pod-cidr>"]  // source-IP allowlist; deny-all when array is empty
    },

    // DockerRuntime — used when backend = "docker"
    "docker": {
      "imageOverride": "<custom-sandbox-image>",      // default: ghcr.io/rowitzou/lightclaw-sandbox:<version>
      "memoryLimit": "4g",
      "cpuLimit": 4,
      "idleTimeoutMs": 1800000,                       // stop the container after 30min idle
      "network": "bridge",
      "tmpfs": ["/tmp"],
      "mounts": [
        { "host": "/data/datasets", "container": "/data", "mode": "ro" }
      ],
      "env": { /* injected into the container */ },
      "autoPull": true
    },

    // RlaunchRuntime — used when backend = "rlaunch" (cluster deployments)
    // All values come from the cluster admin; LightClaw doesn't ship defaults.
    "rlaunch": {
      "image":            "<cluster-base-image>",
      "chargedGroup":     "<your-charged-group>",
      "namespace":        "<your-cluster-namespace>",
      "cpu":              8,
      "memoryMb":         16384,
      "gpu":              0,
      "privateMachine":   "group",
      "positiveTags":     [],
      "gpfsHostPrefix":   "<host-side-gpfs-mount>",   // e.g. /mnt/shared-storage-user
      "gpfsMountPrefix":  "<gpfs-url-prefix>",        // e.g. gpfs://gpfs1
      "imagePullPolicy":  "IfNotPresent",
      "maxWaitDuration":  "5m",
      "workerGcTimeHours": 24,
      "predictBeforeStart":   true,
      "healthCheckIntervalMs": 300000,
      "preheatOnStartup":     true,
      "preheatOnApproval":    true
    }
  }
}
```

All keys are optional — drop the sections you don't use. Environment variables (`ANTHROPIC_API_KEY`, `LIGHTCLAW_MODEL`, `LIGHTCLAW_RUNTIME_BACKEND`, …) override the file. The full env-var reference is at [`info/env.md`](https://github.com/RowitZou/lightclaw_dev_log/blob/main/env.md).

Sibling files in the same directory:

| File | Purpose |
|---|---|
| `permissions.json` | Global allow/deny/ask rules; merged with per-user rules below. |
| `identity/per-user/<canonical>/permissions.json` | Persisted "approve everything like this" decisions per user. Auto-managed; survives restarts. |
| `mcp.json` | MCP server registrations. |
| `channels.json` | Feishu and other channel runners. |
| `hooks/*.mjs` | Lifecycle hooks. |

`mode 0600` is enforced on credential-bearing files.

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
| `/permissions` | List numbered rules, revoke by index, or register an ASK rule (see below). |
| `/sandbox` | Inspect or reset the assistant's sandboxed work environment. |

Admin-only commands:

| Command | Purpose |
|---|---|
| `/identity list|pending|approve|reject|unlink|remove` | Manage pairing and user bindings. |
| `/ceiling [<user> <default|plan|acceptEdits|bypassPermissions>]` | Show every identity's ceiling, or set one user's ceiling. |

Channel messages that begin with `/` are dispatched locally too, so the admin can approve a pairing code from their own Feishu account.

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
/ceiling alice bypassPermissions   # admin: raise alice's ceiling
/mode bypassPermissions            # alice (or admin) can then switch
```

This two-step flow applies to the admin too — there is no environment variable shortcut.

---

## Identity And Channels

Unknown Feishu senders receive a pairing code. The admin approves it with:

```text
/identity approve K7YQ3RPA --as alice
```

Each canonical user gets:

- user-scoped memory at `~/.lightclaw/memory/<user>/`
- session metadata tagged with `userId`
- channel sessions like `feishu-alice`
- a private workspace at `~/.lightclaw/workspaces/<user>/`

Channels are configured in `~/.lightclaw/channels.json`. Set `enabled: true` for the channels you want the main `lightclaw` process to start.

Feishu defaults to a long-connection (WS) transport, so you don't need a public webhook endpoint.

When the assistant wants to do something that needs confirmation, it sends an interactive card with three buttons:

- **Approve once** — let it do this exact thing this time.
- **Approve everything like this** — the card label shows what scope you're approving (e.g. "any `pip install`" rather than "all Bash"), so you can broaden safely without unlocking the whole tool. The decision is **persisted** to `<LIGHTCLAW_HOME>/identity/per-user/<canonical>/permissions.json` and survives daemon restarts; concurrent subagents asking for the same kind of action are silently allowed once the rule is installed.
- **Deny** — say no, the assistant gets the message.

For high-risk operations (`Bash(rm/sudo/dd/sh/eval/...)`, edits under `/etc`, `/usr`, `~/.ssh`, `~/.aws`, …) the middle "approve everything" button is **automatically hidden** — even chained commands like `cd /tmp && rm -rf foo` count, and stale-card clicks on these get downgraded to allow-once. So a single mis-tap on Feishu can never permanently authorize `rm -rf`.

Reply `1` / `2` / `3` if the buttons aren't available. For trusted personal-bot setups, set the channel mode to `bypassPermissions` and use `permissions.json`'s `ask` list to keep the dangerous things confirmable (e.g. `"ask": ["Bash(rm:*)"]`) — `ask` outranks `allow`, so it works even under bypass.

---

## Sandbox

By default, the assistant's tools — Bash, file reads/writes, web fetches — run **inside a sandbox**, not on your host. So a misbehaving model can't `rm -rf` your home directory, and you can hand the bot to a friend on Feishu without giving them shell on your machine.

Three backends, picked via `runtime.backend`:

| Backend | Use it when | Notes |
|---|---|---|
| `local` | Single-user terminal, no friends on Feishu. | Admin-only. Paired channel users are refused — no isolation. |
| `docker` | Multi-user personal bot on a normal Linux box. | Per-user long-lived container, public image `ghcr.io/rowitzou/lightclaw-sandbox` pulled lazily, idle containers are stopped. Workspace files survive restarts; `/sandbox reset` rebuilds the writable layer. |
| `rlaunch` | Cluster deployment (kubebrain). | Per-user long-running cluster worker, gpfs workspace mounted at `/workspace`, no idle stop, health-checker auto-recovers on GC. |

The Docker image ships with the daily-driver toolkit (jq, sqlite, ripgrep, Python data-science stack, Node 22). At startup LightClaw pulls it in the background; tool calls degrade to chat-only until it's ready, so the first conversation never hangs.

For custom or air-gapped images, set `runtime.docker.imageOverride` (or `runtime.rlaunch.image` for the cluster backend) and restart LightClaw. Mount datasets / model checkpoints with `mode: "ro"` — the kernel rejects writes inside the mount.

**Network bridge.** When the sandbox can't reach the internet directly (host-network Docker, cluster pods behind NAT), set `runtime.network.mode: "host"`. LightClaw starts an in-process forward proxy on the configured port and injects `http_proxy` into the container / pod. `upstream` controls where it forwards to (`inherit` from your shell, `direct`, or a fixed proxy URL); `acl` is a **source-IP allowlist** so the bridge can't be turned into an open relay — for cluster deployments include your pod CIDR (RFC 6598 `100.64.0.0/10` for kubebrain). See the [`Configuration`](#configuration) section for the full schema.

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

Selected environment variables (override the matching `config.json` keys):

| Variable | Purpose |
|---|---|
| `LIGHTCLAW_HOME` | Root of all LightClaw state (default `~/.lightclaw`). Move it to shared storage for cluster deployments. |
| `LIGHTCLAW_SESSIONS_DIR` / `LIGHTCLAW_MEMORY_DIR` / `LIGHTCLAW_WORKSPACE_ROOT` | Override individual subdirectories independently of `LIGHTCLAW_HOME`. |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` | Anthropic credentials |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` | OpenAI-compatible credentials |
| `LIGHTCLAW_PROVIDER` | `anthropic` or `openai` |
| `LIGHTCLAW_MODEL` | Default model |
| `LIGHTCLAW_ALLOWED_MODELS` | Comma-separated model allowlist for `/model` |
| `BRAVE_SEARCH_API_KEY` | WebSearch Brave key (overrides `tools.webSearch.braveApiKey`); falls back to DDG HTML when unset. |
| `LIGHTCLAW_NO_MEMORY` / `LIGHTCLAW_NO_MCP` / `LIGHTCLAW_NO_HOOKS` | Disable a subsystem entirely |
| `LIGHTCLAW_MEMORY_RECALL_*` / `LIGHTCLAW_SESSION_MEMORY_*` / `LIGHTCLAW_PRE_COMPACT_FLUSH_*` | Fine-grained memory toggles and thresholds (see [`info/env.md`](https://github.com/RowitZou/lightclaw_dev_log/blob/main/env.md)) |
| `LIGHTCLAW_PERMISSION_MODE` | Default permission mode |
| `LIGHTCLAW_RUNTIME_BACKEND` | Execution runtime: `local`, `docker`, or `rlaunch` (cluster). |
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
├── channels/           # Feishu runner, runner strategy, session lock
├── identity/           # canonical users, pairing, workspaces, secure JSON state
├── permission/         # mode/rule policy and skill tool boundaries
├── tools/              # built-in tools (Read, Write, Edit, Bash, Grep, Glob, ...)
├── runtime/            # Runtime abstraction; LocalRuntime, DockerRuntime, RlaunchRuntime + NetworkBridge
├── agents/             # general-purpose / explore subagents + forked-agent runner (cache-safe parent prefix reuse)
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
