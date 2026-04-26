# LightClaw

[中文说明](./README.zh-CN.md) · English

LightClaw is a self-hosted personal AI assistant that lives in your terminal and, optionally, in Feishu / WeChat. It is a from-scratch TypeScript / Node.js agent harness inspired by Claude Code, but Phase 10 intentionally hides most harness internals from the user surface.

The default experience is simple: start `lightclaw`, chat naturally, and let the assistant use tools, memory, skills, and channels behind the scenes.

---

## Quick Start

```bash
pnpm install
pnpm build
node dist/cli.js
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

Admin-only commands:

| Command | Purpose |
|---|---|
| `/identity list|pending|approve|reject|link|unlink|remove` | Manage pairing and user bindings. |
| `/ceiling <default|plan|acceptEdits|bypassPermissions>` | Set the permission ceiling for identities. |

Channel messages that begin with `/` are dispatched locally too, so the admin can approve a pairing code from their own Feishu / WeChat account.

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

`Read` / `Write` / `Edit` / `Glob` / `Grep` are denied outside that workspace before normal permission rules run. `Bash` rejects obvious workspace escapes such as absolute paths outside the workspace, `..`, `$HOME`, and `~`.

This boundary still is not a real process sandbox; symlinks, `eval`, and indirect shell tricks are future hardening work.

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

---

## Contributor Map

```text
src/
├── cli.ts              # tiny CLI surface, auto-resume, channel auto-start
├── init.ts             # config + workspace-scoped state initialization
├── repl.ts             # readline REPL + slash dispatch
├── commands/           # /help, /model, /mode, /identity, /ceiling
├── channels/           # Feishu / WeChat runners and channel slash dispatch
├── identity/           # canonical users, pairing, workspaces, secure JSON state
├── permission/         # mode/rule policy plus hard workspace boundary
├── tools/              # built-in tools
├── skill/              # loader, registry, bundled skills
├── memory/             # LIGHTCLAW.md discovery and user memory
├── mcp/                # MCP client
├── hooks/              # lifecycle hook loader
└── provider/           # Anthropic / OpenAI-compatible providers
```

## License

MIT
