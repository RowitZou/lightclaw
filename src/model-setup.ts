// Dev-facing setup template text for the BYO endpoint / backend commands
// (B3 noun-verb surface: `endpoint add --type ...` + `backend add ...`).
// English-only by design — these are example command transcripts, not
// localized user-facing strings.

export function formatEndpointTemplates(): string {
  return [
    'Endpoint templates:',
    '',
    'Endpoint parameters:',
    '  <endpoint>        A short alias you choose, for example openai-default or anthropic-default.',
    '  --type            openai | anthropic | codex. Sets the wire protocol family.',
    '  --key             A raw API key OR an existing secret name. A raw key is auto-stored in secrets (0600) and only the reference lands in config.json.',
    '  --auth-path       (--type codex only) Path to a codex login auth.json the daemon can read.',
    '  --base-url        Optional provider base URL. Use this for OpenAI-compatible gateways. Not for --type codex.',
    '  --proxy           Optional endpoint-specific proxy. Leave empty unless this endpoint needs a special route.',
    '',
    'OpenAI API key:',
    '  /config endpoint add openai-default --type openai --key <KEY> --base-url https://api.openai.com/v1',
    '  /config backend add gpt-openai --endpoint openai-default --upstream gpt-4.1 --max-tokens 64000',
    '',
    'Anthropic API key:',
    '  /config endpoint add anthropic-default --type anthropic --key <KEY> --base-url https://api.anthropic.com',
    '  /config backend add claude-sonnet --endpoint anthropic-default --upstream claude-sonnet-4-6 --max-tokens 64000',
    '',
    'OpenAI-compatible self-hosted gateway:',
    '  /config endpoint add local-gateway --type openai --key <KEY> --base-url http://127.0.0.1:8000/v1 --proxy <proxy-url-if-needed>',
    '  /config backend add local-model --endpoint local-gateway --upstream <served-model-id> --reasoning low --max-tokens 32000',
    '',
    'Your own Codex (ChatGPT OAuth) account:',
    '  /config endpoint add my-codex --type codex --auth-path ~/.codex/auth.json',
    '  /config backend add gpt-codex --endpoint my-codex --upstream gpt-5.5 --reasoning medium',
    '',
  ].join('\n')
}

export function formatModelTemplates(): string {
  return [
    'Backend (BYO model) templates:',
    '',
    'Backend parameters:',
    '  <name>            The LightClaw display name you choose, for example gpt-openai.',
    '  --endpoint        The endpoint alias from /config endpoint list. The schema is derived from its --type.',
    '  --upstream        The real model id sent to the provider. Defaults to <name> when omitted.',
    '  --reasoning       Optional: none | minimal | low | medium | high | xhigh. Use low for speed, medium as default, high/xhigh for harder coding/reasoning; none/minimal only when the upstream model supports them.',
    '  --max-tokens      Optional per-model output cap. Common starting values: 32000 or 64000.',
    '  --default         Set this model as your defaultModel.',
    '',
    'OpenAI API key:',
    '  /config backend add gpt-openai --endpoint openai-default --upstream gpt-4.1 --max-tokens 64000',
    '',
    'Anthropic API key:',
    '  /config backend add claude-sonnet --endpoint anthropic-default --upstream claude-sonnet-4-6 --max-tokens 64000',
    '',
    'OpenAI-compatible self-hosted gateway:',
    '  /config backend add local-model --endpoint local-gateway --upstream <served-model-id> --reasoning low --max-tokens 32000',
    '',
    'Your own Codex (ChatGPT OAuth) account:',
    '  /config backend add gpt-codex --endpoint my-codex --upstream gpt-5.5 --reasoning medium',
    '',
    'Modify later:',
    '  /config backend set gpt-openai --reasoning high',
    '  /config backend set gpt-openai --max-tokens 32000',
    '  /config backend set gpt-openai --reasoning - --max-tokens -',
    '  /config backend check gpt-openai',
    '',
  ].join('\n')
}
