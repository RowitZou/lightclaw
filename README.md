# LightClaw

[中文说明](./README.zh-CN.md) · English

LightClaw is a self-hosted AI agent that lives in your terminal and (optionally) in your chat apps. You ask it to do things — read code, run a command, summarise a conversation, fetch a web page — and it works through them by calling tools, while you watch.

It is a from-scratch TypeScript rewrite using [Claude Code](https://github.com/anthropics/claude-code) as its architectural blueprint. The whole runtime is one ~230 KB ESM bundle.

This README walks you through it from a first-time user's perspective.

---

## What you get

- A **terminal REPL** where you type a question, watch the agent stream its answer, and see every tool call (file read, shell command, web fetch, …) inline.
- A **persistent memory** that follows you across sessions and across machines you log in with the same identity — no need to re-explain your project every time.
- An **identity layer** so you can stay logged in across the terminal, Feishu, and WeChat without re-introducing yourself to the bot.
- **Pairing-based access control** so strangers can't talk to your bot in chat apps; you approve people once from the terminal.
- A **Feishu / WeChat bot** so a teammate can poke the same agent from their phone.
- **Plug-in points** for MCP servers, lifecycle hooks, custom skills, project-level permissions, and project memory files.

It's deliberately small: no React/Ink UI, no IDE bridge, no multi-account fan-out, no "team mode" yet. Single admin user in v1.

---

## Quick start (5 minutes)

### 1. Prerequisites

- Node.js 22+
- pnpm 10+
- An Anthropic-compatible API key (or OpenAI-compatible)

### 2. Install

```bash
pnpm install
pnpm build
```

For active development, `pnpm dev` runs `tsx src/cli.ts` and skips the build step.

### 3. Tell LightClaw which model to use

The minimum config is one file at `~/.lightclaw/config.json`:

```jsonc
{
  "provider": "anthropic",
  "providerOptions": {
    "anthropic": {
      "apiKey": "sk-..."           // paste your key here
    }
  }
}
```

If you use a third-party Anthropic-compatible proxy, add `"baseUrl": "https://your.proxy/"` (do NOT include `/v1` — LightClaw appends it). The default model is `claude-sonnet-4-6`; override with `LIGHTCLAW_MODEL=...` or in config.

### 4. First launch — set up your admin identity

```bash
node dist/cli.js
# or: pnpm start
```

Because this is the very first time, LightClaw enters a one-question wizard:

```
LightClaw is not initialized. Setting up first admin.

Admin canonical name (default: yourosuser):
```

Press Enter to accept your OS username, or type a name like `alice`. LightClaw writes one file under `~/.lightclaw/identity/` and drops you into the REPL with `admin: alice` in the banner. From now on, opening the REPL just lands you straight in.

### 5. Say hello

```
you> hi, who are you?
assistant> I'm LightClaw, an interactive AI agent ...
```

To leave: `/exit` or Ctrl-D.

That's the whole getting-started loop. The rest of this README is a tour of what you can do once you're inside.

---

## Talking to LightClaw in the terminal

In the REPL, anything you type that isn't a slash-command is a prompt sent to the model. The model can call tools (Read, Write, Bash, …) and you'll see those inline:

```
you> what's in this project?
[tool] Glob {"pattern":"**/*"}
[tool-result] Glob
[tool] Read {"file_path":"package.json"}
[tool-result] Read
assistant> This is a TypeScript project called lightclaw...
```

If a tool wants to do something potentially destructive (write a file, run a Bash command, fetch a URL), LightClaw will pause and ask for confirmation — see [Permissions](#permissions) below.

### Slash commands

Anything starting with `/` is a REPL command (handled locally, never sent to the model). Type as little or as much as you need:

#### Identity & sessions

| Command | What it does |
|---|---|
| `/whoami` | Show the active LightClaw user (e.g. `user: alice`). |
| `/identity` | Hint for managing identities (full management is via `lightclaw identity ...` — see [Identity & pairing](#identity--pairing)). |
| `/sessions` | List your saved chat sessions, most-recent first. |
| `/status` | One-line summary of session, cwd, model, provider, permission mode, MCP/hook counts. |

#### Working with memory & history

| Command | What it does |
|---|---|
| `/memory` | List the long-term memory files saved under your user. These are auto-extracted at the end of each conversation, plus anything `MemoryWrite` has saved. |
| `/compact` | Manually summarise the current session. Useful before a long task to free up the context window. |
| `/todos` | Show the in-flight todo list (LightClaw's own scratchpad — populated when you ask it for multi-step work). |

#### Skills

| Command | What it does |
|---|---|
| `/skills` | List all skills the agent can invoke (built-in plus any in `~/.lightclaw/skills/` or `<project>/.lightclaw/skills/`). |
| `/skill <name> [args]` | Run a skill as a prompt. Two skills ship by default: `verify` (verify recent claims with tool calls) and `remember` (save something to memory). |

#### Permissions (see [Permissions](#permissions) for details)

| Command | What it does |
|---|---|
| `/permissions` | Show the active mode and every loaded allow/deny rule grouped by source. |
| `/permissions clear` | Drop session-scoped rules (the ones you added with `/allow` and `/deny`). |
| `/mode <mode>` | Switch permission mode — one of `default`, `acceptEdits`, `bypassPermissions`, `plan`. |
| `/allow <rule>` | Add a session-only allow rule, e.g. `/allow Bash(git status:*)`. |
| `/deny <rule>` | Add a session-only deny rule, e.g. `/deny Bash(rm:*)`. |

#### Tools & integrations

| Command | What it does |
|---|---|
| `/mcp` | Show MCP server status (connected / failed / disabled) and tool counts. |
| `/mcp reload` | Reconnect every MCP server. |
| `/hooks` | List loaded lifecycle hooks. |
| `/hooks reload` | Re-scan and reload hook scripts. |

#### Quitting

| Command | What it does |
|---|---|
| `/exit` | Close the REPL (also Ctrl-D). |

---

## What the agent can do

Out of the box, the agent has **16 tools** available. You don't call them yourself — the model picks them as it works. Brief overview:

| Family | Tools | Use case |
|---|---|---|
| Filesystem | `Read`, `Write`, `Edit`, `Glob`, `Grep` | Read code, edit files, find by pattern. |
| Shell | `Bash` | Run shell commands (with permission gating). |
| Web | `WebFetch`, `WebSearch` | Fetch URLs (Markdown-converted), search the web (Anthropic-only). |
| Memory | `MemoryRead`, `MemoryWrite` | Persistent notes per user, survive across sessions. |
| Conversation history | `ConversationList`, `ConversationRead`, `ConversationGrep` | Browse / read / search your earlier sessions, scoped to your user. |
| Task tracking | `TodoWrite` | Manage a structured todo list inside the conversation. |
| Sub-agent | `AgentTool` | Spawn an isolated sub-agent (`general-purpose` or `explore`) for a focused task. |
| Skills | `UseSkill` | Execute a named skill as a prompt template. |

---

## Identity & pairing

The terminal user is an **admin**. Anyone messaging the bot from a chat app is a **regular user**, and they need to be approved by the admin once before the bot will respond to them.

The admin manages everyone via the `lightclaw identity` subcommands:

```bash
lightclaw identity list                          # see who's registered + their bindings
lightclaw identity pending                       # see incoming pairing requests
lightclaw identity approve K7YQ3RPA --as alice   # approve and bind to canonical user "alice"
lightclaw identity approve M8XN2RPB --as alice   # link a second channel to the same alice
lightclaw identity reject K7YQ3RPA               # discard a pending request
lightclaw identity link alice feishu:ou_xxx      # admin-only: bind by hand without pairing
lightclaw identity unlink wechat:o9_yyy          # remove one binding
lightclaw identity remove bob                    # remove a user (sessions/memory kept; --purge wipes them)
```

A canonical user (alice) can be linked to **many** channel identities (feishu open_id, wechat user_id, terminal os-user). All of those bindings see the same `~/.lightclaw/memory/alice/`, the same conversation history (via the `Conversation*` tools), and the same long-term knowledge of alice's preferences. Sessions stay split per channel (`feishu-alice`, `wechat-alice`) so contexts don't accidentally cross-contaminate.

---

## Connecting to Feishu / WeChat

This is optional. If you only use the terminal, skip this section.

### One-time setup

1. Put credentials in `~/.lightclaw/channels.json` (mode 600 recommended). See [Channels config](#channels).
2. Start the channel daemon:

   ```bash
   lightclaw channel feishu start    # WS-by-default, no public ingress needed
   lightclaw channel wechat login    # interactive QR scan to enroll the bot account
   lightclaw channel wechat start    # long-poll daemon
   ```
3. From the chat app, message the bot. As an unknown sender you'll get back a pairing code:

   ```
   Welcome to LightClaw bot.
   To use this bot, ask the LightClaw operator to approve this pairing code: K7YQ3RPA
   Operator command: lightclaw identity approve K7YQ3RPA --as <name>
   ```
4. In the terminal, the admin runs `lightclaw identity pending` to see all codes, then `lightclaw identity approve K7YQ3RPA --as alice`. Pairing is one-shot per channel binding.

### What works in chat

- Text in / text out.
- Inbound media (images, files, voice → text) — saved locally and surfaced to the agent as a path to `Read`.
- The same memory and conversation tools as the terminal, scoped to the canonical user.

### What doesn't (yet)

- Outbound media, streaming cards, multi-account, channel-side `/slash` commands, push notifications, IDE bridge.

---

## Permissions

LightClaw's tools are graded by **risk**: read/search tools are `safe`, file writes are `write`, shell + web + sub-agent are `execute`. The active **mode** decides what happens when the model tries to call a non-`safe` tool:

| Mode | Behavior |
|---|---|
| `default` | `safe` runs freely; `write`/`execute` ask in REPL, deny in non-interactive mode. |
| `acceptEdits` | `safe` + `write`/`edit` run freely; `execute` still asks. |
| `bypassPermissions` | Everything runs unless an explicit deny rule matches. |
| `plan` | Read-only mode: `write` and `execute` are denied unless you've allowed them. |

Switch the mode at runtime with `/mode <mode>`. Configure persistent rules through:

- **CLI flags** (highest priority): `--allow "Bash(git status:*)"`, `--deny "Bash(rm:*)"`, `--permission-mode plan`, `--dangerously-bypass`.
- **Session rules** (in REPL): `/allow ...`, `/deny ...` — not persisted.
- **Local file** (`<cwd>/.lightclaw/permissions.local.json`): not committed to git.
- **Project file** (`<cwd>/.lightclaw/permissions.json`): committed.
- **User file** (`~/.lightclaw/permissions.json`): your machine-wide defaults.

Rule shape:

```json
{
  "allow": ["Read", "Bash(git status:*)", "WebFetch(github.com)"],
  "deny":  ["Bash(rm:*)", "Bash(sudo:*)"]
}
```

Pattern semantics:

- `Bash(rm:*)` matches `rm` and `rm -rf foo` but **not** `rmdir`.
- `WebFetch(example.com)` matches that hostname; `WebFetch(*.example.com)` matches any subdomain.
- `Read(/etc/*)` matches one level deep; `Read(/etc/**)` recurses.
- `MCP(github:list_*)` matches MCP tool names by prefix.

A built-in deny rule blocks `Read`/`Write`/`Edit` against `~/.lightclaw/**` (where identity, memory, sessions, and pairing data live), and `Bash` rejects commands that reference that path in plain text. This is a soft sandbox — see [Security notes](#security-notes-known-limits) for what it does and doesn't protect.

---

## Configuration

### `~/.lightclaw/config.json` (full reference)

```jsonc
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "providerOptions": {
    "anthropic": {
      "apiKey": "sk-...",
      "baseUrl": "https://api.anthropic.com"
    },
    "openai": {
      "apiKey": "sk-...",
      "baseUrl": "https://api.openai.com/v1"
    }
  },
  "routing": {
    "main":      "claude-sonnet-4-6",
    "compact":   "claude-haiku-4-5-20251001",
    "extract":   "claude-haiku-4-5-20251001",
    "subagent":  "claude-sonnet-4-6",
    "webSearch": "claude-sonnet-4-6"
  },
  "sessionsDir": "~/.lightclaw/sessions",
  "memoryDir":   "~/.lightclaw/memory",
  "autoCompact": true,
  "autoMemory":  true,
  "contextWindow": 200000,
  "compactThresholdRatio": 0.75,
  "compactKeepRecent":     6,
  "permissionMode": "default",
  "permissionRuleFiles": {
    "user":    "~/.lightclaw/permissions.json",
    "project": ".lightclaw/permissions.json",
    "local":   ".lightclaw/permissions.local.json"
  },
  "permissionAuditLog": "~/.lightclaw/permissions.audit.jsonl",
  "mcpEnabled": true,
  "mcpConnectTimeout":      10000,
  "mcpConnectConcurrency":  4,
  "mcpMaxToolOutputBytes":  20480,
  "hooksEnabled": true,
  "hookTimeoutBlocking":     5000,
  "hookTimeoutNonBlocking": 10000
}
```

Resolution order is **env vars → `~/.lightclaw/config.json` → defaults**. You can leave the file empty and configure entirely via env.

### Environment variables (selected)

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` | Anthropic credentials |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` | OpenAI-compatible credentials |
| `LIGHTCLAW_PROVIDER` | `anthropic` or `openai` |
| `LIGHTCLAW_MODEL` | Override main model |
| `LIGHTCLAW_ROUTING_{MAIN,COMPACT,EXTRACT,SUBAGENT,WEBSEARCH}` | Per-purpose model override |
| `LIGHTCLAW_AUTO_COMPACT` / `LIGHTCLAW_AUTO_MEMORY` | Feature toggles (`true`/`false`) |
| `LIGHTCLAW_CONTEXT_WINDOW` | Token budget for compact threshold math |
| `LIGHTCLAW_COMPACT_THRESHOLD_RATIO` | Trigger compact at this ratio (0.1 – 0.95) |
| `LIGHTCLAW_COMPACT_KEEP_RECENT` | Messages preserved during compact |
| `LIGHTCLAW_PERMISSION_MODE` | One of `default`, `acceptEdits`, `bypassPermissions`, `plan` |
| `LIGHTCLAW_PERMISSION_AUDIT_LOG` | JSONL path for permission decisions |
| `LIGHTCLAW_MCP_ENABLED` / `LIGHTCLAW_HOOKS_ENABLED` | Feature toggles |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `FEISHU_ENCRYPT_KEY` / `FEISHU_VERIFICATION_TOKEN` / `FEISHU_PROXY` | Feishu channel overrides |
| `LIGHTCLAW_WECHAT_PERMISSION_MODE` | WeChat channel permission mode |

### Channels

`~/.lightclaw/channels.json` (no credentials in source):

```jsonc
{
  "feishu": {
    "enabled": true,
    "appId":    "<app_id>",
    "appSecret": "<app_secret>",
    "encryptKey": "<encrypt_key>",
    "verificationToken": "<verification_token>",
    "transport": "ws",                    // 'ws' (default, no public ingress) or 'webhook'
    "proxy": "http://127.0.0.1:1080",     // optional; falls back to https_proxy/http_proxy env
    "permissionMode": "default",
    "allowUsers": ["*"],
    "allowChats": ["*"],
    "mediaEnabled": true,
    "mediaDir": "~/.lightclaw/state/feishu/media",
    "webhook": {                           // ignored when transport='ws'
      "host": "0.0.0.0",
      "port": 18850,
      "path": "/feishu/events"
    }
  },
  "wechat": {
    "enabled": true,
    "permissionMode": "default",
    "allowSenders": ["*"],
    "textChunkSize": 4000,
    "longPollTimeoutMs": 35000,
    "mediaEnabled": true,
    "mediaDir": "~/.lightclaw/state/wechat/media"
  }
}
```

WeChat stores its bot token under `~/.lightclaw/state/wechat/accounts/default.json` (mode 600), the long-poll cursor under `state/wechat/sync/`, context tokens under `state/wechat/context-tokens/`, and inbound media under `state/wechat/media/`.

---

## Advanced features

### MCP servers

Define MCP servers in `~/.lightclaw/mcp.json` (or per-project under `<cwd>/.lightclaw/mcp.json` / `mcp.local.json`). Later files override earlier ones by server name. The shape is the standard `{ "mcpServers": {...} }` envelope:

```json
{
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    },
    "docs": {
      "type": "http",
      "url": "http://127.0.0.1:3000/mcp",
      "headers": { "Authorization": "Bearer ${DOCS_MCP_TOKEN}" }
    }
  }
}
```

Transports: `stdio`, `http` (Streamable), `sse`. `${VAR}` expansion works in `env` and `headers`. Remote tools land as `mcp__<server>__<tool>` and default to `write` risk, so they prompt under `default` mode unless an `MCP(github:*)`-style allow rule matches.

### Lifecycle hooks

Drop `.mjs` files into `~/.lightclaw/hooks/` or `<cwd>/.lightclaw/hooks/`. Export any of: `onSessionStart`, `beforeQuery`, `beforeToolCall`, `afterToolCall`, `afterQuery`, `onSessionEnd`.

```js
export default {
  beforeToolCall({ toolName, input }) {
    if (toolName === 'Bash' && input?.command?.includes('rm -rf /')) {
      return { decision: 'deny', reason: 'blocked by project hook' }
    }
  },
}
```

### Project memory

Drop `LIGHTCLAW.md` (or `LIGHTCLAW.local.md`, ignored by git) anywhere in your project tree. LightClaw discovers all of them at session start and folds them into the system prompt. Use this for project conventions, contact lists, "anything you'd tell a new teammate on day one".

### Sub-agents

Two ship by default: `general-purpose` (broad tasks) and `explore` (read-only exploration of the codebase). The agent invokes them via `AgentTool` when a task warrants isolation. Sub-agents run with a filtered tool set (no `AgentTool` / `TodoWrite` / `MemoryWrite`) and non-interactive permissions, then fold their final answer back to the parent.

### Sessions and resume

Every REPL session writes a JSONL transcript and `meta.json` under `~/.lightclaw/sessions/<id>/`. Resume:

```bash
lightclaw --resume                    # latest session
lightclaw --resume <session-id>       # a specific one
```

`/sessions` lists yours; the agent itself can browse via `ConversationList` / `ConversationRead` / `ConversationGrep`.

### Auto-compact

When the local token estimate of the running conversation crosses `contextWindow * compactThresholdRatio` (default 0.75 of 200k = 150k), LightClaw runs a one-shot LLM summary, replaces the older messages with that summary, and keeps the most recent `compactKeepRecent` (default 6) intact. The transcript file is rewritten in place so `--resume` picks up the compacted version. You can trigger it manually with `/compact`.

---

## Security notes (known limits)

- The `~/.lightclaw/**` sandbox is enforced as **deny rules on the `Read`/`Write`/`Edit` tools** plus a substring guard on `Bash`. It blocks the model from naturally writing `cat ~/.lightclaw/users/bob.json`. It does **not** stop a determined attacker who can do `eval "$cmd"`, use symlinks, or split path tokens with `c""at`. A real process sandbox (chroot / landlock) is on the roadmap.
- Identity verification trusts the channel platform: if Feishu or WeChat says a message came from open-id `ou_xxx`, LightClaw believes it. The pairing approval step is your one chance to gate access.
- Single admin in v1. Multi-admin / role-based access is on the roadmap.

---

## CLI quick reference

```bash
# Just chat
lightclaw                                       # REPL
lightclaw --prompt "explain this repo"          # one-shot

# Sessions
lightclaw --resume                              # resume latest
lightclaw --resume <id>                         # resume specific

# Provider / model overrides
lightclaw --provider anthropic
lightclaw --model claude-sonnet-4-6

# Feature toggles
lightclaw --no-memory                           # don't auto-extract or inject memory
lightclaw --no-mcp                              # don't connect MCP servers
lightclaw --no-hooks                            # don't load hook scripts

# Permissions
lightclaw --permission-mode plan
lightclaw --allow "Bash(git status:*)"
lightclaw --deny "Bash(rm:*)"
lightclaw --dangerously-bypass

# Identity (admin commands)
lightclaw identity list
lightclaw identity pending
lightclaw identity approve <code> --as <name>
lightclaw identity reject <code>
lightclaw identity link <name> <channel:id>
lightclaw identity unlink <channel:id>
lightclaw identity remove <name> [--purge]

# Channels
lightclaw channel list
lightclaw channel feishu start
lightclaw channel wechat login
lightclaw channel wechat start
```

---

## For contributors

### Project layout

```
src/
├── cli.ts              # arg parsing + entry
├── init.ts             # bootstrap: config + state + session resume
├── init-wizard.ts      # first-run admin identity wizard
├── cli-identity.ts     # `lightclaw identity ...` subcommands
├── cli-channel.ts      # `lightclaw channel ...` subcommands
├── config.ts           # env + ~/.lightclaw/config.json resolution
├── state.ts            # process-level singleton (cwd, model, sessionId, currentUserId, ...)
├── prompt.ts           # system prompt builder
├── query.ts            # agent loop, tool dispatch, auto-compact, memory extraction
├── repl.ts             # readline REPL + slash command dispatch
├── messages.ts         # user/assistant/compact constructors
├── api.ts              # provider.streamChat() compat layer
├── token-estimate.ts   # local char-based token estimator
├── tool.ts             # Tool<I,O> interface, Zod → JSON Schema
├── tools.ts            # tool registry + capability gate
├── tools/              # built-in tools (Read/Write/Edit/Bash/Glob/Grep/Memory*/Conversation*/Web*/Todo/UseSkill/Agent)
├── identity/           # canonical users, terminal admin, pairing, secure JSON state
├── permission/         # modes, rule parsing/matching, policy, prompts, audit
├── mcp/                # MCP config, transports, registry, tool adapter
├── provider/           # Anthropic / OpenAI-compatible providers + modelFor()
├── session/            # storage (JSONL + meta.json), listing, compact
├── memory/             # LIGHTCLAW.md discovery, auto-memory, extraction
├── skill/              # loader, registry, bundled skills (verify, remember)
├── agents/             # built-in subagents (general-purpose, explore)
├── todos/              # todo list validation + persistence
├── channels/           # Channel abstraction + Feishu (ws/webhook) + WeChat (long-poll)
└── web/                # proxy-aware HTTP fetch + HTML → Markdown
```

### Architecture sketch

```
cli.ts ──► init-wizard? ──► init.ts ──► repl.ts ──► query.ts ──► provider.streamChat()
                              (state)     (UI)        (agent loop)
                                                      │
                                                      ├─► tools/ (filesystem, shell, web, conversation, memory, ...)
                                                      ├─► mcp/ (external MCP tool adapters)
                                                      ├─► permission/ (mode + rule check)
                                                      ├─► prompt.ts (system prompt template)
                                                      ├─► session/ (transcript + compact)
                                                      ├─► memory/ (discovery + auto-memory + extract)
                                                      ├─► skill/ (loader + registry + UseSkill)
                                                      └─► agents/ (sub-agent runner)
```

### Key invariants

- `state.ts` is the only process-level singleton. `initializeApp()` is the single writer; everyone else reads through getters. `beginQuery()` resets the per-turn `AbortController`.
- Tools are schema-first. Built-in tools use Zod input schemas converted to JSON Schema via `zod/v4`'s `toJSONSchema()`. MCP tools carry raw JSON Schema and skip local validation.
- Auto-compact rewrites the transcript in place — never appends.
- Identity scopes everything user-relative: session meta carries `userId`, memory is `~/.lightclaw/memory/<canonical>/`, and `Conversation*` tools refuse sessions belonging to other users.
- Sub-agents inherit the parent identity but run with an isolated message list and a filtered tool allowlist.

---

## License

MIT
