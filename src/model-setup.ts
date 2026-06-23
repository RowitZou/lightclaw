export function formatEndpointTemplates(): string {
  return [
    'Endpoint templates:',
    '',
    'Endpoint parameters:',
    '  <endpoint>        A short alias you choose, for example openai-default or codex-default.',
    '  apiKeyRef         A secret name created by /secret set. The real key is never stored in config.json.',
    '  authRef           A Codex auth reference such as codex:default, created by /auth codex import.',
    '  --base-url        Optional provider base URL. Use this for OpenAI-compatible gateways.',
    '  --proxy           Optional endpoint-specific proxy. Leave empty unless this endpoint needs a special route.',
    '',
    'Codex OAuth:',
    '  /auth codex import --from <daemon-readable-codex-auth.json> --name default',
    '  /endpoint add-codex codex-default codex:default',
    '  /model custom add gpt-codex openai-auth codex-default <codex-upstream-model> --reasoning medium --max-output-tokens 64000',
    '',
    'OpenAI API key:',
    '  /secret set OPENAI_KEY <VALUE>',
    '  /endpoint add-key openai-default OPENAI_KEY --base-url https://api.openai.com/v1',
    '  /model custom add gpt-openai openai openai-default gpt-4.1 --max-output-tokens 64000',
    '',
    'Anthropic API key:',
    '  /secret set ANTHROPIC_KEY <VALUE>',
    '  /endpoint add-key anthropic-default ANTHROPIC_KEY --base-url https://api.anthropic.com',
    '  /model custom add claude-sonnet anthropic anthropic-default claude-sonnet-4-6 --max-output-tokens 64000',
    '',
    'OpenAI-compatible self-hosted gateway:',
    '  /secret set GATEWAY_KEY <VALUE>',
    '  /endpoint add-key local-gateway GATEWAY_KEY --base-url http://127.0.0.1:8000/v1 --proxy <proxy-url-if-needed>',
    '  /model custom add local-model openai local-gateway <served-model-id> --reasoning low --max-output-tokens 32000',
    '',
  ].join('\n')
}

export function formatModelTemplates(): string {
  return [
    'Model config templates:',
    '',
    'Model parameters:',
    '  <model>           The LightClaw display name you choose, for example gpt-codex-mid.',
    '  schema            openai-auth for Codex OAuth; openai for OpenAI/OpenAI-compatible APIs; anthropic for Anthropic.',
    '  endpoint          The endpoint alias from /endpoint list.',
    '  upstreamModel     The real model id sent to the provider. Copy it from your provider docs or an admin-provided example.',
    '  --reasoning       Optional: none | minimal | low | medium | high | xhigh. Use low for speed, medium as default, high/xhigh for harder coding/reasoning; none/minimal only when the upstream model supports them.',
    '  --max-output-tokens Optional per-model output cap. Common starting values: 32000 or 64000.',
    '  --param key=value Optional provider-specific request parameter, for example --param temperature=0.2.',
    '  --param-json key=<json> Optional structured parameter value, for example --param-json response_format={"type":"json_object"}.',
    '  --params-json <object> Bulk JSON object for provider-specific request parameters.',
    '  --no-default      Add the model without switching your defaultModel to it.',
    '  --timeout-ms      Probe timeout for the automatic model check after add/set.',
    '  /model custom param-help [openai|anthropic|openai-auth] shows request parameter examples.',
    '',
    'Codex OAuth:',
    '  /model custom add gpt-codex-fast openai-auth codex-default <codex-upstream-model> --reasoning low --max-output-tokens 64000',
    '  /model custom add gpt-codex-mid openai-auth codex-default <codex-upstream-model> --reasoning medium --max-output-tokens 64000',
    '  /model custom add gpt-codex-deep openai-auth codex-default <codex-upstream-model> --reasoning high --max-output-tokens 64000',
    '  /model custom add gpt-codex-xdeep openai-auth codex-default <codex-upstream-model> --reasoning xhigh --max-output-tokens 64000',
    '',
    'OpenAI API key:',
    '  /model custom add gpt-openai openai openai-default gpt-4.1 --max-output-tokens 64000 --param temperature=0.2',
    '',
    'Anthropic API key:',
    '  /model custom add claude-sonnet anthropic anthropic-default claude-sonnet-4-6 --max-output-tokens 64000 --param top_p=0.9',
    '',
    'OpenAI-compatible self-hosted gateway:',
    '  /model custom add local-model openai local-gateway <served-model-id> --reasoning low --max-output-tokens 32000 --param temperature=0.1 --param top_p=0.95',
    '',
    'Modify later:',
    '  /model custom set gpt-codex-mid --reasoning high',
    '  /model custom set gpt-codex-mid --max-output-tokens 32000',
    '  /model custom set gpt-codex-mid --param temperature=0.2 --clear-param top_p',
    '  /model custom set gpt-codex-mid --reasoning - --max-output-tokens -',
    '  /model custom check gpt-codex-mid',
    '',
  ].join('\n')
}

const MODEL_SETUP_REQUIRED_REPLY = [
  '当前用户还没有可用模型。',
  '',
  '请发送 `/ui` 打开 LightClaw 控制台，在卡片里先配置 endpoint，再添加模型 config。',
  '',
  '需要文本模板时可发送 `/endpoint templates` 和 `/model custom templates`。',
].join('\n')

export function formatModelSetupRequiredReply(): string {
  return MODEL_SETUP_REQUIRED_REPLY
}

export function isModelSetupRequiredReply(text: string): boolean {
  return text === MODEL_SETUP_REQUIRED_REPLY
}

export function formatVisualSetupOpenedReply(): string {
  return [
    '当前用户还没有可用模型。',
    '',
    '已为你打开 LightClaw 控制台。请在卡片里进入“添加 / 配置模型”，先配置 endpoint，再添加模型 config。',
    '',
    '之后可以随时发送 `/ui` 重新打开这个界面。',
  ].join('\n')
}
