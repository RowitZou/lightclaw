# LightClaw

[中文说明](./README.zh-CN.md) · English

LightClaw is a self-hosted AI agent harness written from scratch in TypeScript, with [Claude Code](https://github.com/anthropics/claude-code) as its architectural blueprint. It runs as a lightweight, terminal-native REPL backed by a streaming tool-using agent loop, persistent sessions, automatic context compaction, a memory + skill system, sub-agents, web tools, MCP tools, lifecycle hooks, and a Feishu webhook channel.

## Status

Phases 1 – 7 are complete. The current build ships as a ~159 KB single-file ESM bundle and exposes:

- **Terminal REPL** (readline + chalk) with streaming output and Ctrl+C interruption
- **Agent loop** with up to 20 turns, tool-use ↔ tool-result routing, and auto-compact
- **13 built-in tools**: `Bash`, `Read`, `Write`, `Edit`, `Grep`, `Glob`, `MemoryRead`, `MemoryWrite`, `UseSkill`, `TodoWrite`, `WebFetch`, `WebSearch`, `AgentTool`
- **Session persistence**: JSONL transcript + `meta.json`, `--resume` to restore the latest or a specific session
- **Auto-compact**: LLM-driven summarization once local token estimate crosses a threshold, keeping the most recent N messages
- **Memory system**: `LIGHTCLAW.md` / `LIGHTCLAW.local.md` discovery across multiple scopes, an auto-memory directory with frontmatter entries and a `MEMORY.md` index, plus background extraction at the end of each query
- **Skill system**: three-layer discovery (builtin / user / project), `UseSkill` tool and `/skill` command, two bundled skills (`verify`, `remember`)
- **Sub-agents**: built-in `general-purpose` and `explore` agents via the `AgentTool`, with isolated message context and a filtered tool allowlist
- **Provider abstraction**: Anthropic and OpenAI-compatible streaming, per-purpose model routing (`main` / `compact` / `extract` / `subagent` / `webSearch`)
- **Web tools**: proxy-aware `WebFetch` (undici + turndown) and Anthropic native server-side `WebSearch` (enabled only when talking to the official Anthropic endpoint)
- **Todo list**: `TodoWrite` tool + `/todos` command + session-scoped persistence
- **Permission system**: four modes (`default`, `acceptEdits`, `bypassPermissions`, `plan`), layered allow/deny rules, REPL approval prompts, and audit JSONL
- **MCP client**: stdio / Streamable HTTP / SSE server connections, `mcp__<server>__<tool>` tool injection, `/mcp` status, `/mcp reload`, and `MCP(<server>:*)` permission rules
- **Hooks**: `.mjs` lifecycle hooks from user/project directories, `/hooks`, `/hooks reload`, and `--no-hooks`
- **Feishu channel**: webhook-only daemon (`lightclaw channel feishu start`) with text inbound/outbound, dedup, allowlists, session routing, proxy-aware SDK client, and non-interactive permissions

Deliberately **not** implemented yet: React/Ink UI, MCP server mode, MCP resources/prompts/OAuth/sampling, WeChat/IDE bridge channels, Feishu WebSocket/streaming cards/media, `@include` directives, fork-agent memory extraction, micro-compact, `allowed_tools` enforcement, process sandboxing.

## Requirements

- Node.js 22+
- pnpm 10+

## Installation

```bash
pnpm install
pnpm build
```

For iterative development, `pnpm dev` runs `tsx src/cli.ts` directly — no build step needed.

## Configuration

Configuration is resolved in this order (highest priority first):

1. Environment variables
2. `~/.lightclaw/config.json`
3. Built-in defaults

Example `~/.lightclaw/config.json`:

```jsonc
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514",
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
    "main": "claude-sonnet-4-20250514",
    "compact": "claude-haiku-4-20250514",
    "extract": "claude-haiku-4-20250514",
    "subagent": "claude-sonnet-4-20250514",
    "webSearch": "claude-sonnet-4-20250514"
  },
  "sessionsDir": "~/.lightclaw/sessions",
  "memoryDir": "~/.lightclaw/memory",
  "autoCompact": true,
  "autoMemory": true,
  "contextWindow": 200000,
  "compactThresholdRatio": 0.75,
  "compactKeepRecent": 6,
  "permissionMode": "default",
  "permissionRuleFiles": {
    "user": "~/.lightclaw/permissions.json",
    "project": ".lightclaw/permissions.json",
    "local": ".lightclaw/permissions.local.json"
  },
  "permissionAuditLog": "~/.lightclaw/permissions.audit.jsonl",
  "mcpEnabled": true,
  "mcpConnectTimeout": 10000,
  "mcpConnectConcurrency": 4,
  "mcpMaxToolOutputBytes": 20480,
  "hooksEnabled": true,
  "hookTimeoutBlocking": 5000,
  "hookTimeoutNonBlocking": 10000
}
```

Supported environment variables:

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` | Anthropic provider credentials |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` | OpenAI-compatible provider credentials |
| `LIGHTCLAW_PROVIDER` | `anthropic` or `openai` |
| `LIGHTCLAW_MODEL` | Main model name |
| `LIGHTCLAW_ROUTING_MAIN` / `_COMPACT` / `_EXTRACT` / `_SUBAGENT` / `_WEBSEARCH` | Per-purpose model override |
| `LIGHTCLAW_SESSIONS_DIR` | Override session directory |
| `LIGHTCLAW_MEMORY_DIR` | Override memory directory |
| `LIGHTCLAW_AUTO_COMPACT` / `LIGHTCLAW_AUTO_MEMORY` | Feature toggles (`true` / `false`) |
| `LIGHTCLAW_CONTEXT_WINDOW` | Model context window in tokens (compact threshold math) |
| `LIGHTCLAW_COMPACT_THRESHOLD_RATIO` | Trigger compact when estimated usage crosses this ratio (0.1 – 0.95) |
| `LIGHTCLAW_COMPACT_KEEP_RECENT` | Number of most recent messages to preserve during compact |
| `LIGHTCLAW_PERMISSION_MODE` | `default`, `acceptEdits`, `bypassPermissions`, or `plan` |
| `LIGHTCLAW_PERMISSION_AUDIT_LOG` | Optional JSONL path for permission decisions |
| `LIGHTCLAW_MCP_ENABLED` | Enable or disable MCP startup (`true` / `false`) |
| `LIGHTCLAW_MCP_CONNECT_TIMEOUT` | Per-server MCP connection timeout in milliseconds |
| `LIGHTCLAW_MCP_CONNECT_CONCURRENCY` | MCP connection concurrency |
| `LIGHTCLAW_MCP_MAX_TOOL_OUTPUT_BYTES` | Maximum MCP tool result size before truncation |
| `LIGHTCLAW_HOOKS_ENABLED` | Enable or disable hook loading (`true` / `false`) |
| `LIGHTCLAW_HOOK_TIMEOUT_BLOCKING` | Timeout for blocking hooks in milliseconds |
| `LIGHTCLAW_HOOK_TIMEOUT_NON_BLOCKING` | Timeout for non-blocking hooks in milliseconds |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | Feishu channel credentials |
| `FEISHU_ENCRYPT_KEY` / `FEISHU_VERIFICATION_TOKEN` | Feishu webhook verification settings |
| `FEISHU_PROXY` | Feishu SDK HTTP proxy URL |

## Usage

```bash
# Interactive REPL
pnpm dev
pnpm start

# One-shot prompt
pnpm dev -- --prompt "Summarize this repository"

# Resume the latest session, or a specific one
pnpm dev -- --resume
pnpm dev -- --resume <session-id>

# Override model or provider
pnpm dev -- --model claude-sonnet-4-20250514
pnpm dev -- --provider openai

# Disable auto-memory extraction and memory index injection
pnpm dev -- --no-memory

# Disable MCP startup and MCP tool injection
pnpm dev -- --no-mcp

# Disable hook loading
pnpm dev -- --no-hooks

# Permission modes and CLI rules
pnpm dev -- --permission-mode plan
pnpm dev -- --allow "Bash(git status:*)" --deny "Bash(rm:*)"
pnpm dev -- --dangerously-bypass

# Feishu webhook channel
pnpm dev -- channel list
pnpm dev -- channel feishu start
```

### Permissions

Modes:

| Mode | Behavior |
|---|---|
| `default` | Read/search tools run freely; write and execute tools ask in REPL and deny in non-interactive mode |
| `acceptEdits` | Read/search/write/edit tools run freely; execute/network/subagent tools still ask |
| `bypassPermissions` | All tools run unless an explicit deny rule matches |
| `plan` | Read/search tools run; write and execute tools are denied unless explicitly allowed |

Rule files use:

```json
{
  "allow": ["Read", "Bash(git status:*)", "WebFetch(github.com)"],
  "deny": ["Bash(rm:*)", "Bash(sudo:*)"]
}
```

Rule sources are checked as `cliArg` → `session` → `local` → `project` → `user`; any matching deny wins over allow. Session rules come from `/allow` and `/deny` and are not persisted. The current permission mode is saved in session `meta.json` and restored by `--resume`.

Pattern semantics:
- `Bash(cmd:*)` matches on a token boundary — `Bash(rm:*)` covers `rm` and `rm -rf foo` but does **not** match `rmdir`.
- `WebFetch(example.com)` matches the exact hostname; `WebFetch(*.example.com)` matches any subdomain.
- `Read(/etc/*)` / `Write(/etc/*)` / `Edit(/etc/*)` use path prefix matching.
- `MCP(github:*)` allows all MCP tools from the `github` server; `MCP(github:list_issues)` allows only that tool; `MCP(github:list_*)` matches by tool-name prefix.
- Per-input rule content is honored for `Bash`, `WebFetch`, `Read` / `Write` / `Edit`, and `AgentTool`; other tools only support whole-tool allow/deny.

### MCP

LightClaw reads MCP server definitions from:

1. `~/.lightclaw/mcp.json`
2. `<cwd>/.lightclaw/mcp.json`
3. `<cwd>/.lightclaw/mcp.local.json`

Later files override earlier files by server name. The format is compatible with the common `{ "mcpServers": ... }` shape:

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
      "headers": {
        "Authorization": "Bearer ${DOCS_MCP_TOKEN}"
      }
    }
  }
}
```

Supported transports are `stdio`, `http` (Streamable HTTP), and `sse`. `env` and `headers` values support `${VAR}` expansion. Remote tools are exposed as `mcp__<normalized-server>__<tool>` and default to `write` risk, so `default` mode asks before running them unless an allow rule matches.

### Hooks

LightClaw loads `.mjs` files from `~/.lightclaw/hooks/` and `<cwd>/.lightclaw/hooks/`. A hook file exports an object with any of these functions: `onSessionStart`, `beforeQuery`, `beforeToolCall`, `afterToolCall`, `afterQuery`, `onSessionEnd`.

```js
export default {
  beforeToolCall({ toolName, input }) {
    if (toolName === 'Bash' && input?.command?.includes('rm -rf /')) {
      return { decision: 'deny', reason: 'blocked by project hook' }
    }
  },
}
```

### Feishu Channel

The Feishu channel reads `~/.lightclaw/channels.json` and starts a webhook server. Source code contains no environment-specific credentials.

```jsonc
{
  "feishu": {
    "enabled": true,
    "appId": "<app_id>",
    "appSecret": "<app_secret>",
    "encryptKey": "<encrypt_key>",
    "verificationToken": "<verification_token>",
    "proxy": "http://127.0.0.1:1080",
    "permissionMode": "default",
    "allowUsers": ["*"],
    "allowChats": ["*"],
    "webhook": {
      "host": "0.0.0.0",
      "port": 18850,
      "path": "/feishu/events"
    }
  }
}
```

### REPL commands

| Command | Description |
|---|---|
| `/exit` | Leave the REPL |
| `/status` | Show session id, message count, token estimate, compaction count, provider, routing |
| `/sessions` | List recent sessions |
| `/compact` | Manually summarize the current session |
| `/todos` | Show the current todo list |
| `/memory` | Show project memory files and auto-memory index |
| `/skills` | List available skills |
| `/skill <name> [args]` | Invoke a skill by name |
| `/permissions` | Show current mode and permission rules by source |
| `/permissions clear` | Clear session-level permission rules |
| `/mode <mode>` | Switch the current session permission mode |
| `/allow <rule>` / `/deny <rule>` | Add a session-level allow or deny rule |
| `/mcp` | Show MCP server status and tool counts |
| `/mcp reload` | Reconnect all configured MCP servers |
| `/hooks` | Show loaded lifecycle hooks |
| `/hooks reload` | Reload hook files |

## Project layout

```
src/
├── cli.ts              # argument parsing and entry point
├── init.ts             # bootstrap: config + state + session resume
├── config.ts           # env + ~/.lightclaw/config.json resolution
├── state.ts            # process-level singleton (cwd, model, sessionId, usage, ...)
├── prompt.ts           # system prompt builder (identity + tools + memory + todos)
├── query.ts            # agent loop, tool dispatch, auto-compact, memory extraction
├── repl.ts             # readline REPL with slash commands
├── messages.ts         # user/assistant/compact message constructors
├── types.ts            # shared message / session / meta types
├── api.ts              # thin compat layer over provider.streamChat()
├── token-estimate.ts   # local char-based token estimator
├── tool.ts             # Tool<I,O> interface, Zod → JSON Schema
├── tools.ts            # tool registry + capability gate
├── tools/              # 13 built-in tools
├── permission/         # modes, rule parsing, matching, policy, prompts, audit
├── mcp/                # MCP config, transports, registry, tool adapter
├── provider/           # Anthropic / OpenAI-compatible providers + modelFor()
├── session/            # storage (JSONL + meta.json), listing, compact
├── memory/             # LIGHTCLAW.md discovery, auto-memory, extraction
├── skill/              # loader, registry, bundled skills (verify, remember)
├── agents/             # built-in subagents (general-purpose, explore)
├── todos/              # todo list validation + persistence
└── web/                # proxy-aware HTTP fetch + HTML → Markdown
```

## Architecture sketch

```
cli.ts ──► init.ts ──► repl.ts ──► query.ts ──► provider.streamChat()
            (state)     (UI)        (agent loop)
                                    │
                                    ├─► tools/ (Bash, Read, Write, Edit, Grep, Glob, ...)
                                    ├─► mcp/   (external MCP tool adapters)
                                    ├─► permission/ (mode + rule checks)
                                    ├─► prompt.ts (system prompt template)
                                    ├─► session/ (transcript + compact)
                                    ├─► memory/  (discovery + auto-memory + extract)
                                    ├─► skill/   (loader + registry + UseSkill)
                                    └─► agents/  (sub-agent runner)
```

Key invariants:

- **`state.ts` is the only process-level singleton.** `initializeApp()` is the single writer; everything else reads through getters. `beginQuery()` resets the per-turn `AbortController`.
- **Tools are schema-first.** Built-in tools use Zod input schemas converted to JSON Schema via `zod/v4`'s `toJSONSchema()`. MCP tools carry raw JSON Schema from the server and skip local Zod validation. New built-ins register in `builtinTools` inside `src/tools.ts`.
- **Auto-compact** is threshold-driven. After every assistant turn, `maybeAutoCompact()` compares the local token estimate against `contextWindow * compactThresholdRatio` and rewrites the transcript in place — no append — if triggered.
- **Session storage is append-only JSONL + sibling `meta.json`.** Compaction is the only operation that rewrites the transcript.
- **Tool dispatch is permission-gated.** Each tool declares `riskLevel`, `query.ts` checks mode + rules before `tool.call()`, and denied calls are returned to the model as tool errors.
- **MCP is client-only.** Startup connects configured servers once, failed servers do not block the REPL, and `/mcp reload` performs a full reconnect.
- **Sub-agents run synchronously** with an isolated message list, a filtered tool allowlist (no `AgentTool` / `TodoWrite` / `MemoryWrite` to protect the parent), non-interactive permission checks, and usage folded back into the parent session.

## License

MIT
