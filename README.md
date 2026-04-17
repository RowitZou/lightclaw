# LightClaw

LightClaw is a self-hosted AI agent harness inspired by [Claude Code](https://github.com/anthropics/claude-code).

## Status

Phase 1 is a minimal terminal agent:

- Readline-based interactive REPL
- Anthropic-compatible streaming chat
- Basic tool loop for shell and filesystem tasks
- Persistent JSONL session transcripts with resume support
- Automatic context compaction with local token estimation

## Requirements

- Node.js 22+
- pnpm 10+

## Setup

```bash
pnpm install
```

Configure credentials with environment variables or `~/.lightclaw/config.json`:

```json
{
	"apiKey": "sk-...",
	"baseUrl": "http://host:port",
	"model": "claude-sonnet-4-20250514",
	"sessionsDir": "~/.lightclaw/sessions",
	"autoCompact": true,
	"contextWindow": 200000,
	"compactThresholdRatio": 0.75,
	"compactKeepRecent": 6
}
```

Environment variables take precedence:

- `ANTHROPIC_API_KEY`
- `ANTHROPIC_BASE_URL`
- `LIGHTCLAW_MODEL`
- `LIGHTCLAW_SESSIONS_DIR`
- `LIGHTCLAW_AUTO_COMPACT`
- `LIGHTCLAW_CONTEXT_WINDOW`

## Usage

```bash
pnpm dev
pnpm dev -- --prompt "Summarize this repository"
pnpm dev -- --resume
pnpm build
pnpm start -- --model claude-sonnet-4-20250514
```

Inside the REPL, use `/sessions`, `/status`, `/compact`, and `/exit`.

## License

MIT
