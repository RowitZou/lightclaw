# LightClaw

LightClaw is a self-hosted AI agent harness inspired by [Claude Code](https://github.com/anthropics/claude-code).

## Status

Phase 1 is a minimal terminal agent:

- Readline-based interactive REPL
- Anthropic-compatible streaming chat
- Basic tool loop for shell and filesystem tasks
- In-memory session state and token accounting

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
	"model": "claude-sonnet-4-20250514"
}
```

Environment variables take precedence:

- `ANTHROPIC_API_KEY`
- `ANTHROPIC_BASE_URL`
- `LIGHTCLAW_MODEL`

## Usage

```bash
pnpm dev
pnpm dev -- --prompt "Summarize this repository"
pnpm build
pnpm start -- --model claude-sonnet-4-20250514
```

Inside the REPL, use `/exit` to quit.

## License

MIT
