# LightClaw

[中文](./README.zh-CN.md) · English

LightClaw is a **self-hosted, multi-user AI agent**. It runs as a long-lived daemon on your own machine (or cluster), talks to you (and people you authorize) over Feishu, and can read/write files, run commands, fetch the web, and operate Feishu cloud docs — all inside a sandbox. It remembers your project conventions, your corrections, and the tasks in flight across sessions. One deploy, your own machine, no SaaS.

---

## Features

<table>
<tr><td><b>Feishu-native</b></td><td>@ it in a DM / group / topic to talk; every conversation scope is isolated. Working process renders as live-updating cards (a per-turn process card + a per-task panel tracking the whole task tree) instead of message spam; the message stream stays a conversation. The terminal is a slash-only admin console — it does not run the agent.</td></tr>
<tr><td><b>Actually does things</b></td><td>Read/write/edit files, run shell (foreground + background long jobs), fetch the web, read PDF / Office, operate Feishu cloud docs — all in the sandbox.</td></tr>
<tr><td><b>Multi-user + permissions</b></td><td>Admin pairs users; each gets an isolated workspace / memory / rules. Four permission modes + plain-language approval cards + per-user ceilings.</td></tr>
<tr><td><b>Sandboxed</b></td><td>Tools run in a local / Docker / cluster (rlaunch) sandbox by default — handing the bot to someone is not handing them a shell.</td></tr>
<tr><td><b>Long-horizon memory</b></td><td>Remembers you, your project, and the current task across sessions; flushes hard facts before auto-compaction, consolidates scattered notes in the background.</td></tr>
<tr><td><b>Multi-agent</b></td><td>The main agent is a manager: it delegates to specialist sub-agents (coding / research / Feishu / review…) — fan out in parallel, run in the background, or schedule. Every delegation is a durable <b>task run</b>: it survives daemon restarts, pauses on declared wakes, and a watchdog revives whatever stalls.</td></tr>
<tr><td><b>Model-flexible</b></td><td>Anthropic / OpenAI-compatible / Codex OAuth at once; pin different models per role (Claude for the main chat, a small model for memory extraction).</td></tr>
<tr><td><b>Extensible</b></td><td>MCP servers, lifecycle hooks, admin-defined roles, and natural-language-triggered skills.</td></tr>
</table>

---

## Quick start

Needs Node 22+, pnpm 10+, Python 3.

```bash
pnpm install
pnpm dev                  # tsx src/cli.ts —— build-free, fastest iteration
# or: pnpm build && pnpm start
```

A minimal `~/.lightclaw/config.json` is enough to boot (only `endpoints` / `models` / `defaultModel` are required):

```json
{
  "endpoints": { "anthropic-direct": { "apiKey": "<your-api-key>" } },
  "models": {
    "claude-sonnet-4-6": {
      "endpoint": "anthropic-direct", "schema": "anthropic", "upstreamModel": "claude-sonnet-4-6"
    }
  },
  "defaultModel": "claude-sonnet-4-6"
}
```

First launch creates a single admin identity bound to the current terminal user, then starts the daemon. To let the agent talk, add a Feishu section and set `enabled: true` (see [Feishu setup](#feishu-setup)).

> To keep data on shared storage (cluster deploys, surviving a wiped dev box), `export LIGHTCLAW_HOME=<path>` before launching.

---

## Configuration

Everything lives in `<LIGHTCLAW_HOME>/config.json` (default `~/.lightclaw/config.json`). **The full list of options with every default is in [`config.example.jsonc`](./config.example.jsonc)** — only the three required fields above are mandatory; everything else is optional, and environment variables override the file. The runtime uses plain `JSON.parse`, so strip the comments when copying fields over.

Sibling files in the same dir: `permissions.json` (permission rules), `mcp.json` (MCP servers), `hooks/*.mjs` (hooks), `roles/<name>/ROLE.md` (custom roles).

---

## Usage

```bash
lightclaw                 # start the daemon: enabled channels + terminal admin console
lightclaw --home <dir>    # temp home    lightclaw --config <file>  # external read-only config
```

The terminal does not run the agent — talk to the agent over Feishu. Common slash commands (shared by terminal and Feishu, except where tagged `admin` / `feishu`):

| Command | What it does |
|---|---|
| `/help` `/status` | Command list / current user·mode·model·usage |
| `/model` `/mode` | Switch model / permission strictness |
| `/rules` | List / revoke / add permission rules |
| `/stop` `(feishu)` | Abort the current session's in-flight turn |
| `/secret` `/mount` `(feishu)` | Personal secrets / dynamic gpfs mounts |
| `/feedback` | Leave feedback for the admin |
| `/user` `/ceiling` `/cost` `/sandbox` `/feishu-workspace` `/auth` `(admin)` | Pairing, ceilings, usage, sandbox, cloud workspace, Codex login |

**Permissions**: four modes from strict to loose — `read` / `ask` / `auto` / `yolo`, with approval cards for risky operations. `/mode` cannot exceed the ceiling the admin grants (`/ceiling <user> <mode>`). Even under `yolo` you can lock specific operations with the `ask` list in `permissions.json` (e.g. `"ask": ["Bash(rm:*)"]`).

---

## Sandbox

Tools run sandboxed by default; `runtime.backend` picks the backend:

| Backend | For | Notes |
|---|---|---|
| `local` | Just you | Admin still talks over Feishu, but paired non-admin users are refused (no local isolation) |
| `docker` | Multi-user bot on an ordinary host | Per-user long-lived container, public image pulled lazily, idle containers auto-stop |
| `rlaunch` | Cluster (kubebrain) | Per-user long-lived cluster worker, gpfs mounted at `/workspace` |

When the sandbox can't reach the internet directly (docker host networking / cluster pods behind NAT), set `runtime.network.mode: "host"` to start an in-process forward proxy. Image contents, networking, and hardening fields are all in the `runtime` section of [`config.example.jsonc`](./config.example.jsonc).

---

## Feishu setup

Configure the `channels.feishu` section in `config.json` and set `enabled: true`. The default `transport: "ws"` is a long-lived connection — **no public ingress needed**.

> If both `allowUsers` and `allowChats` are empty, all inbound messages are dropped; open a dimension with `["*"]`.

An unknown sender gets a pairing code; the admin approves with `/user approve <code> --as <name>`, after which the user has an isolated workspace / memory / rules. When the assistant wants to do something that needs confirmation it sends a three-button card (Allow once / Allow this kind / Deny); high-risk operations cannot be permanently allowed via "Allow this kind".

<details>
<summary>Feishu open-platform scopes and events for self-hosting</summary>

Permissions (bot tenant access token):

- `im:message` / `im:message:readonly` / `im:resource` / `im:message.reaction:write` / `im:file` — send/receive, read quoted parents, download attachments, typing reaction, push files
- `contact:user.base:readonly` — resolve sender display names
- `docs:document(:readonly)` / `sheets:spreadsheet(:readonly)` / `wiki:wiki:readonly` — read/write Feishu docs / sheets / wiki links
- `drive:drive` — grant the requester access, manage the cloud workspace

Event subscriptions: `im.message.receive_v1`, `im.message.recalled_v1`, `card.action.trigger`.

> After changing scopes or events you must **re-publish the app version** in the developer console for them to take effect.

</details>

---

## Memory

LightClaw remembers three things: **your project** (drop a `LIGHTCLAW.md` at the repo root and it's read every session; `LIGHTCLAW.local.md` for things you won't commit), **you** (it accrues your role / preferences / corrections across sessions and pulls the most relevant ones back when you open a new chat), and **the current task** (a working scratchpad in long sessions, flushed to disk before compaction). `LIGHTCLAW_NO_MEMORY=1` turns it all off.

---

## License

MIT
