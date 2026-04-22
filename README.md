# LightClaw

[中文说明](./README.zh-CN.md) · English

LightClaw is a self-hosted AI agent harness written from scratch in TypeScript, with [Claude Code](https://github.com/anthropics/claude-code) as its architectural blueprint. It runs as a lightweight, terminal-native REPL backed by a streaming tool-using agent loop, persistent sessions, automatic context compaction, a memory + skill system, sub-agents, and web tools.

## Status

Phases 1 – 5 are complete. The current build ships as a ~108 KB single-file ESM bundle and exposes:

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

Deliberately **not** implemented yet: React/Ink UI, hooks, MCP, messaging channels (Feishu/WeChat/IDE bridge), `@include` directives, fork-agent memory extraction, micro-compact, `allowed_tools` enforcement, process sandboxing.

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
  "permissionAuditLog": "~/.lightclaw/permissions.audit.jsonl"
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

# Permission modes and CLI rules
pnpm dev -- --permission-mode plan
pnpm dev -- --allow "Bash(git status:*)" --deny "Bash(rm:*)"
pnpm dev -- --dangerously-bypass
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
                                    ├─► permission/ (mode + rule checks)
                                    ├─► prompt.ts (system prompt template)
                                    ├─► session/ (transcript + compact)
                                    ├─► memory/  (discovery + auto-memory + extract)
                                    ├─► skill/   (loader + registry + UseSkill)
                                    └─► agents/  (sub-agent runner)
```

Key invariants:

- **`state.ts` is the only process-level singleton.** `initializeApp()` is the single writer; everything else reads through getters. `beginQuery()` resets the per-turn `AbortController`.
- **Tools are schema-first.** `Tool<TInput, TOutput>` uses Zod input schemas converted to JSON Schema via `zod/v4`'s `toJSONSchema()`. New tools register in `allTools` inside `src/tools.ts`.
- **Auto-compact** is threshold-driven. After every assistant turn, `maybeAutoCompact()` compares the local token estimate against `contextWindow * compactThresholdRatio` and rewrites the transcript in place — no append — if triggered.
- **Session storage is append-only JSONL + sibling `meta.json`.** Compaction is the only operation that rewrites the transcript.
- **Tool dispatch is permission-gated.** Each tool declares `riskLevel`, `query.ts` checks mode + rules before `tool.call()`, and denied calls are returned to the model as tool errors.
- **Sub-agents run synchronously** with an isolated message list, a filtered tool allowlist (no `AgentTool` / `TodoWrite` / `MemoryWrite` to protect the parent), non-interactive permission checks, and usage folded back into the parent session.

## License

MIT
