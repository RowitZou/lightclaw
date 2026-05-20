# LightClaw

[中文说明](./README.zh-CN.md) · English

LightClaw is a self-hosted personal AI assistant. It runs as a daemon on your own machine, talks to you on Feishu, and remembers what you tell it across sessions. One install, your own machine, no SaaS account.

### What you can do with it

- **Talk to it on Feishu; run it from your terminal.** The agent lives in the channels — message it from a Feishu DM, group, or topic thread. The terminal is the admin console for the daemon (pairing, sandbox, cost, rules), not an agent chat.
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

Requires Node 22+, pnpm 10+, and Python 3 (used by `Read` for Office document
and PDF text extraction in LocalRuntime). `WebFetch` / `WebSearch` are
daemon-side TypeScript and need no Python helper.

Drop a minimal `~/.lightclaw/config.json` to get started — see [Configuration](#configuration) below for the full template:

```jsonc
{
  "endpoints": {
    "anthropic-direct": { "apiKey": "<your-anthropic-api-key>" }
  },
  "models": {
    "claude-sonnet-4-6": {
      "endpoint": "anthropic-direct",
      "schema": "anthropic",
      "upstreamModel": "claude-sonnet-4-6"
    }
  },
  "defaultModel": "claude-sonnet-4-6"
}
```

On first launch, LightClaw creates the single v1 admin identity bound to the terminal user. Every later launch starts the daemon (channels + the admin console) for that admin.

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
  // --- Endpoints: named (apiKey + optional baseUrl) entries that models reference ---
  // The same physical gateway can serve both anthropic and openai protocols;
  // schema lives on each model entry, not here.
  "endpoints": {
    "anthropic-direct": {
      "apiKey": "<your-anthropic-api-key>"
      // omit baseUrl for the official api.anthropic.com endpoint
    },
    "newapi": {
      "apiKey": "<your-gateway-key>",
      "baseUrl": "<https://your-gateway-host>"
    }
  },

  // --- Models: display name -> { endpoint alias, schema, upstreamModel } ---
  // The display name is what shows up in `/model`; it can be anything
  // memorable. `upstreamModel` is the real id sent on the wire.
  "models": {
    "claude-sonnet-4-6": {
      "endpoint": "anthropic-direct",
      "schema": "anthropic",                      // "anthropic" | "openai"
      "upstreamModel": "claude-sonnet-4-6"
    },
    "claude-haiku-4-5": {
      "endpoint": "newapi",
      "schema": "anthropic",
      "upstreamModel": "claude-haiku-4-5-20251001"
    },
    "gpt-5-mini": {
      "endpoint": "newapi",
      "schema": "openai",
      "upstreamModel": "gpt-5-mini"
    }
  },

  // Required global default. Main binds directly to this value, and
  // `/model <name>` updates it at runtime.
  "defaultModel": "claude-sonnet-4-6",

  // Optional per-role model pins. Main cannot be pinned here; use
  // defaultModel. Internal roles share the special `internal` key.
  "roles": {
    "web": { "model": "claude-haiku-4-5", "maxTurns": 12 },
    "internal": { "model": "gpt-5-mini" }
  },

  // --- User-facing language (slash output, feishu cards, banners, error notices) ---
  // Default cn. Stderr logging stays English regardless of this setting.
  // env: LIGHTCLAW_LANG=cn|en
  "lang": "cn",

  // --- Tool-specific config ---
  "tools": {
    "webSearch": {
      "braveApiKey": "<your-brave-search-api-key>",  // optional; falls back to DDG HTML
      "model": "claude-haiku-4-5"                    // WebSearch + WebFetch sub-LLM
    },
    "imageRead": { "model": "gpt-5-mini" },          // multimodal describe sub-LLM
    "compact": { "model": "claude-haiku-4-5" }       // compact + memory sub-LLM
  },

  // --- Per-call API logging (admin debug / training-data trail) ---
  // Off by default. When enabled, every streamChat request + response is
  // persisted verbatim (full system prompt, tools schema, messages array,
  // response content / usage). One file per query() call:
  //   <dir>/<YYYY-MM-DD>/<sessionId>-<HHMMSS>-<uuid8>.jsonl
  // Each line = one turn (one streamChat call). Useful for diagnosing
  // upstream protocol errors and as raw data for future training work.
  "apiLogs": {
    "enabled": false,                             // env: LIGHTCLAW_API_LOGS_ENABLED=1
    "dir": "<lightclaw_home>/api-logs"            // env: LIGHTCLAW_API_LOGS_DIR
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
      "gpfsMounts": [                                 // optional: extra host->gpfs rules when host paths span multiple gpfs filesystems
        { "hostPrefix": "<host-gpfs-mount-a>", "mountPrefix": "<gpfs-url-prefix-a>" },
        { "hostPrefix": "<host-gpfs-mount-b>", "mountPrefix": "<gpfs-url-prefix-b>" }
      ],
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

All keys outside of `endpoints`, `models`, and `defaultModel` are optional — drop the sections you don't use. `endpoints` + `models` + `defaultModel` are required (LightClaw refuses to start with no models registered or no default selected). Environment variables (`LIGHTCLAW_DEFAULT_MODEL`, `LIGHTCLAW_RUNTIME_BACKEND`, …) override the file. The full env-var reference is at [`info/env.md`](https://github.com/RowitZou/lightclaw_dev_log/blob/main/env.md).

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
lightclaw --home <dir>
lightclaw --help
```

`lightclaw` starts the daemon: the enabled channels plus a slash-only
terminal admin console. The terminal does not run an interactive agent
session — reach the agent through Feishu.

Removed CLI flags are now config/env driven:

- Models: `~/.lightclaw/config.json` (`endpoints` + `models` registry, `defaultModel`, optional `roles` / `tools.<module>.model`); `LIGHTCLAW_DEFAULT_MODEL` overrides defaultModel by display name
- Feature toggles: `LIGHTCLAW_NO_MEMORY=1`, `LIGHTCLAW_NO_MCP=1`, `LIGHTCLAW_NO_HOOKS=1`
- Permission rules: edit `~/.lightclaw/permissions.json`
- Identity management: `/user ...` slash command
- Channels: enable them in `~/.lightclaw/channels.json`; `lightclaw` starts enabled channels automatically

---

## Slash Commands

User-visible commands:

| Command | Purpose |
|---|---|
| `/help` | List available commands (no state info; see `/status` for that). |
| `/status` | Show your current user / mode / model / session / today usage. |
| `/model <name>` | Switch the model the assistant is using. |
| `/mode <mode>` | Switch how strict permission checks are. |
| `/rules` | List numbered rules, revoke by index, or register an ASK rule (see below). |
| `/fresh <prompt>` (Feishu only) | Run an ephemeral one-shot session — no memory recall, no transcript persistence. |
| `/branch <prompt>` (alias `/b`, Feishu only) | Spawn a parallel branch off the current session; the main turn keeps running, branch result merges back. |
| `/stop` (Feishu only) | Abort the in-flight turn for the current session only. Branches and fresh runs are independent and not cancelled. |
| `/feedback <text>` (user-only on channels) | Send feedback to admin; admin reads via `/user feedback`. |
| `/auth import codex` | Register a Codex OAuth token so OpenAI-Auth models can use it without an API key. |

Admin-only commands:

| Command | Purpose |
|---|---|
| `/user list|pending|approve|reject|unlink|remove|feedback` | Manage pairing, user bindings, and read user feedback. |
| `/ceiling [<user> <read|ask|auto|yolo>]` | Show every identity's ceiling, or set one user's ceiling. |
| `/sandbox [status|prefetch|reset]` | Inspect / re-pull / reset the runtime sandbox image and container. |
| `/cost` | This-month token usage by-model + by-user (with cache hit / fresh subset). |

Channel messages that begin with `/` are dispatched locally too, so the admin can approve a pairing code from their own Feishu account. The terminal admin console runs the same commands except the agent-loop ones (`/fresh`, `/branch` / `/b`, `/stop`) — those only make sense where a query actually runs, i.e. on Feishu.

### Permission Modes And Ceiling

Four permission modes from strictest to loosest. Channels and users use the **alias** column; the **internal enum** column is the raw value stored in `permissions.json` and surfaced for compatibility with older scripts.

| Alias | Internal enum | What runs without asking |
|---|---|---|
| `read` | `plan` | Read and search tools. Write, edit, execute, network fetch, and subagent tools are denied. |
| `ask` | `default` | Read and search tools. Write, edit, execute, network fetch, and subagent tools ask for confirmation (interactive) or are denied (non-interactive). |
| `auto` | `acceptEdits` | Read, search, write, and edit tools. Execute, network fetch, and subagent tools still ask. |
| `yolo` | `bypassPermissions` | Everything runs without prompting. |

`/mode <m>` is allowed only when `m` is at least as strict as the current ceiling. Default ceiling is `ask` (`default`), which lets users opt into the safer `read` (`plan`) or stay on `ask`. To allow looser modes, the admin must bump the ceiling first:

```text
/ceiling alice yolo            # admin: raise alice's ceiling
/mode yolo                     # alice (or admin) can then switch
```

Both alias and internal enum forms are accepted as input; outputs (status panels, Feishu cards, ceiling listings) always render the alias form.

This two-step flow applies to the admin too — there is no environment variable shortcut.

---

## Identity And Channels

Unknown Feishu senders receive a pairing code. The admin approves it with:

```text
/user approve K7YQ3RPA --as alice
```

Each canonical user gets:

- user-scoped memory at `~/.lightclaw/memory/<user>/`
- session metadata tagged with `userId`
- channel sessions like `feishu-alice`
- a private workspace at `~/.lightclaw/workspaces/<user>/`

Channels are configured in `~/.lightclaw/channels.json`. Set `enabled: true` for the channels you want the main `lightclaw` process to start.

### Feishu app scopes

LightClaw drives Feishu through the bot's tenant access token. On the Feishu Open Platform developer console ("Permissions & Scopes"), enable:

| Scope | Why |
|---|---|
| `im:message` | Send and receive messages, including interactive cards. |
| `im:message:readonly` | Fetch the parent of a reply so quoted context reaches the model. |
| `im:resource` | Download images, audio, and files users send. |
| `im:message.reaction:write` | Show a "thinking" reaction while a turn is in flight. |
| `im:file` | Upload files back to chat (`SendFile`, generated artifacts). |
| `contact:user.base:readonly` | Resolve sender names for the `[name]` group prefix and for pairing. |
| `docs:document`, `docs:document:readonly` | Read and append to Feishu Docs (`FeishuRead`, `FeishuCreateFile`, `FeishuWriteDoc`). |
| `sheets:spreadsheet`, `sheets:spreadsheet:readonly` | Read cells and append rows in Feishu Sheets (`FeishuRead`, `FeishuWriteSheet`). |
| `wiki:wiki:readonly` | Resolve Wiki URLs to the underlying doc or sheet. |
| `drive:drive` | Grant the requesting user access to docs the bot has just created. |

Subscribe to these events under "Events & Callbacks":

- `im.message.receive_v1`
- `im.message.recalled_v1` (so recalling a message interrupts the turn it started)
- `card.action.trigger` (also enable the `card.action.trigger_v1` / `interactive_card.action.trigger` aliases if your console exposes them)

Re-publish the app version after toggling scopes — the changes only take effect on the next release.

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

The Docker image ships with the daily-driver toolkit:

- **Shell / data**: jq, yq, sqlite, ripgrep, fd, Node 22
- **Python data-science**: numpy / pandas / scipy / matplotlib / pyarrow / jsonlines / dotenv / requests / httpx
- **Multimodal helpers** (used by `Read`): `poppler-utils` (`pdftotext` + `pdftoppm` for PDF text + page rasterization), `Pillow` (image resize for vision sub-LLM), `openpyxl` / `python-docx` / `python-pptx` (Office docs). HTML → Markdown for `WebFetch` is daemon-side TypeScript (`turndown`), not a sandbox dependency.

At startup LightClaw pulls the image in the background; tool calls degrade to chat-only until it's ready, so the first conversation never hangs. The image is published as `ghcr.io/rowitzou/lightclaw-sandbox:<version>` — the tag matches the `package.json` version of the daemon you're running, plus the `:latest` floating tag.

For custom or air-gapped images, set `runtime.docker.imageOverride` (or `runtime.rlaunch.image` for the cluster backend) and restart LightClaw. Mount datasets / model checkpoints with `mode: "ro"` — the kernel rejects writes inside the mount.

**Network bridge.** When the sandbox can't reach the internet directly (host-network Docker, cluster pods behind NAT), set `runtime.network.mode: "host"`. LightClaw starts an in-process forward proxy on the configured port and injects `http_proxy` into the container / pod. `upstream` controls where it forwards to (`inherit` from your shell, `direct`, or a fixed proxy URL); `acl` is a **source-IP allowlist** so the bridge can't be turned into an open relay — for cluster deployments include your pod CIDR (RFC 6598 `100.64.0.0/10` for kubebrain). See the [`Configuration`](#configuration) section for the full schema.

For datasets / model checkpoints, mount them with `mode: "ro"` — the assistant can read but the kernel rejects writes. See [`info/env.md`](https://github.com/RowitZou/lightclaw_dev_log/blob/main/env.md) for the full config reference.

---

## What the assistant can use

- **Files & shell** — `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`. `Read` natively handles plain text/code, PDFs (text via `pdftotext`; with `pages` + `visual:true` it hands the requested pages to the model as a native document block when the provider supports it, falling back to per-page image rendering via `pdftoppm`), and Office documents (xlsx / docx / pptx) — no extra `Extract*` tools needed.
- **Web** — `WebFetch` (URL → readable Markdown, with optional sub-LLM summarization and a 15-minute self-cleaning cache; transient network failures retry with exponential backoff; binary downloads keep full bytes), `WebSearch` (Brave or DDG fallback; transient errors retry; a search miss is communicated as "not proof of absence")
- **Feishu cloud docs** — paste a Feishu / Lark URL and the assistant works with it directly: `FeishuRead` auto-routes by canonical type (doc / docx / wiki → doc-or-sheet / sheet → cells or metadata) and can return parsed doc blocks for richer downstream editing; oversized doc responses spill to a workspace file instead of bloating the tool result. `FeishuCreateFile` creates a new doc; `FeishuWriteDoc` appends to an existing doc and supports targeted structural edits (table rows, blocks); `FeishuWriteSheet` appends rows or overwrites a range. Writes always pop a Feishu approval card and append to a per-day audit jsonl at `<LIGHTCLAW_HOME>/audit/feishu-writes/`. Bot also handles inbound Feishu message recall (the turn it triggered aborts cleanly). `bitable` / `file` URLs are parsed but read/write isn't supported in v1.
- **Memory** — `MemoryRead` / `MemoryWrite` for durable per-user notes. Auto-extraction (`extract_memories`) and consolidation (`auto_dream`) run as background subagents; `MemoryWrite` is the manual escape hatch when the model wants to commit a fact mid-turn. **Memory Nudge** drops a periodic system reminder into the prompt every ~20 turns so the model proactively persists findings before they roll off — no extra API turn, zero overhead.
- **Conversation history** — `ConversationList` / `ConversationRead` / `ConversationGrep` to find past sessions across channels (terminal + Feishu DM + groups + topic threads).
- **Scheduled work** — `BackgroundTask` schedules recurring or one-shot work that fires later in an isolated session; `ListBackgroundTasks` / `CancelBackgroundTask` / `UpdateBackgroundTask` manage the queue. Completions land back via Feishu DM card (`notifyTo: 'user'`) or as a model wake-up turn (`notifyTo: 'agent'`).
- **Task tracking** — `TodoWrite` for multi-step plans
- **Sub-agents** — spin up parallel `general-purpose` or `explore` agents for fan-out work; `AgentTool` is the dispatch entry point
- **Files to channel** — `SendFile` pushes a workspace file out to the active Feishu chat (cards / images / docs)
- **Harness-side wait** — `Sleep` for short waits without occupying a Bash slot (`/stop` cancels it instantly)
- **Skills** — small bundles of focused capability (`verify`, `remember`, …); the model picks them up automatically when relevant, no manual invocation
- **MCP servers** — admin-configured external tools, available to the model as `mcp__<server>__<tool>`; image content returned by MCP tools is passed through to the model as a native image block (instead of being elided to a placeholder), so screenshot / chart / vision-server outputs are actually visible

Most tools (Memory, Web, Conversation, BackgroundTask, AgentTool, Sleep, SendFile, UseSkill, and the four Feishu cloud-doc tools) are **deferred**: their full schemas are not in the cold-start tool catalog, and the model promotes them on demand via `ToolSearch`. The eight always-loaded inline tools are `Bash` / `Read` / `Write` / `Edit` / `Grep` / `Glob` / `TodoWrite` / `ToolSearch`. This keeps the per-turn prompt cache tight; promoted tools live in a session-scoped LRU with a turn-based TTL so the catalog stays trim across long sessions.

All of the above respect the same permission flow described above.

---

## Memory

LightClaw remembers three things:

- **Your project.** Drop a `LIGHTCLAW.md` into your repo and the assistant reads it every session, the same way Claude Code does. Add `LIGHTCLAW.local.md` for things you don't want to commit.
- **You.** It builds a profile of your role, preferences, and corrections you've made — across sessions and channels. When you start a new conversation, the most relevant pieces come back automatically; you don't re-explain who you are.
- **The current task.** Inside a long session it keeps a working notebook (what you're doing, files touched, decisions made, what's next). When the conversation gets too long and auto-compacts, those hard facts survive — the thread doesn't reset.

Long conversations also get a quiet **Memory Nudge** every ~20 turns reminding the model to commit anything durable to memory before context pressure rolls it off — so even chatty sessions don't lose the lessons that came up mid-task.

Disable everything with `LIGHTCLAW_NO_MEMORY=1`. Finer toggles are listed below.

---

## Configuration Notes

Selected environment variables (override the matching `config.json` keys):

| Variable | Purpose |
|---|---|
| `LIGHTCLAW_HOME` | Root of all LightClaw state (default `~/.lightclaw`). Move it to shared storage for cluster deployments. |
| `LIGHTCLAW_SESSIONS_DIR` / `LIGHTCLAW_MEMORY_DIR` / `LIGHTCLAW_WORKSPACE_ROOT` | Override individual subdirectories independently of `LIGHTCLAW_HOME`. |
| `LIGHTCLAW_DEFAULT_MODEL` | Override `defaultModel` (must be a display name registered in `models`) |
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
├── cli.ts              # tiny CLI surface, channel auto-start, admin console
├── init.ts             # config + workspace-scoped state initialization
├── init-wizard.ts      # first-run admin setup, terminal user resolution
├── repl.ts             # slash-only terminal admin console
├── query.ts            # main agent loop (tool dispatch, auto-compact)
├── prompt.ts           # system prompt builder
├── state.ts            # process-level session state singleton
├── commands/           # /help, /status, /model, /mode, /rules, /sandbox, /user, /ceiling, channel dispatch
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
