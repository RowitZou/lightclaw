# LightClaw

中文 · [English](./README.md)

LightClaw 是一个用 TypeScript 从头编写的自托管 AI Agent Harness，以 [Claude Code](https://github.com/anthropics/claude-code) 为架构蓝本。核心是一个轻量、终端原生的 REPL，背后连接流式工具调用的 agent loop、持久化 session、自动上下文压缩、Memory + Skill 系统、子 Agent、Web 工具、MCP 工具、生命周期 Hooks，以及飞书 webhook 渠道。

## 当前状态

Phase 1 – 7 全部完成。构建产物为 ~159 KB 的单文件 ESM bundle。已具备：

- **终端 REPL**（readline + chalk），支持流式输出与 Ctrl+C 中断
- **Agent loop**：最多 20 轮、`tool_use` ↔ `tool_result` 调度、auto-compact
- **13 个内置工具**：`Bash`、`Read`、`Write`、`Edit`、`Grep`、`Glob`、`MemoryRead`、`MemoryWrite`、`UseSkill`、`TodoWrite`、`WebFetch`、`WebSearch`、`AgentTool`
- **Session 持久化**：JSONL transcript + `meta.json`，`--resume` 恢复最近或指定 session
- **Auto-Compact**：本地 token 估算越过阈值后由 LLM 生成摘要，保留最近 N 条消息，**原地重写**不追加
- **Memory 系统**：多层 `LIGHTCLAW.md` / `LIGHTCLAW.local.md` 发现、auto-memory 目录 + frontmatter 条目 + `MEMORY.md` 索引、每轮 query 结束后的后台提取
- **Skill 系统**：builtin / user / project 三层发现、`UseSkill` 工具与 `/skill` 命令、内置 `verify` 与 `remember` 两个 Skill
- **子 Agent**：内置 `general-purpose` 与 `explore`，经 `AgentTool` 调用，拥有隔离的消息上下文和工具白名单
- **Provider 抽象**：Anthropic / OpenAI-compatible 两种流式实现，按用途做 model routing（`main` / `compact` / `extract` / `subagent` / `webSearch`）
- **Web 工具**：代理感知的 `WebFetch`（undici + turndown），以及仅在直连官方 Anthropic 端点时启用的 `WebSearch`（native server tool）
- **Todo List**：`TodoWrite` 工具 + `/todos` 命令 + session 级持久化
- **权限系统**：四种 mode（`default`、`acceptEdits`、`bypassPermissions`、`plan`）、分层 allow/deny 规则、REPL 确认提示与 audit JSONL
- **MCP Client**：支持 stdio / Streamable HTTP / SSE 连接，将远端工具注入为 `mcp__<server>__<tool>`，提供 `/mcp`、`/mcp reload` 与 `MCP(<server>:*)` 权限规则
- **Hooks**：从 user/project 目录加载 `.mjs` 生命周期钩子，支持 `/hooks`、`/hooks reload` 与 `--no-hooks`
- **飞书渠道**：webhook-only daemon（`lightclaw channel feishu start`），支持文本收发、去重、allowlist、session 路由、代理感知 SDK client 与非交互权限

刻意**未**实现：React/Ink 全屏 UI、MCP Server 模式、MCP resources/prompts/OAuth/sampling、微信/IDE Bridge 渠道、飞书 WebSocket/streaming card/附件媒体、`@include` 指令、fork-agent memory 提取、micro-compact、`allowed_tools` 强制执行、进程沙箱。

## 环境要求

- Node.js 22+
- pnpm 10+

## 安装

```bash
pnpm install
pnpm build
```

开发迭代直接用 `pnpm dev`（等价于 `tsx src/cli.ts`），无需构建。

## 配置

配置优先级（从高到低）：

1. 环境变量
2. `~/.lightclaw/config.json`
3. 内置默认值

`~/.lightclaw/config.json` 示例：

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

支持的环境变量：

| 变量 | 用途 |
|---|---|
| `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` | Anthropic Provider 凭据 |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` | OpenAI-compatible Provider 凭据 |
| `LIGHTCLAW_PROVIDER` | `anthropic` 或 `openai` |
| `LIGHTCLAW_MODEL` | 主模型名 |
| `LIGHTCLAW_ROUTING_MAIN` / `_COMPACT` / `_EXTRACT` / `_SUBAGENT` / `_WEBSEARCH` | 按用途覆盖模型 |
| `LIGHTCLAW_SESSIONS_DIR` | 自定义 session 目录 |
| `LIGHTCLAW_MEMORY_DIR` | 自定义 memory 目录 |
| `LIGHTCLAW_AUTO_COMPACT` / `LIGHTCLAW_AUTO_MEMORY` | 功能开关（`true` / `false`） |
| `LIGHTCLAW_CONTEXT_WINDOW` | 模型上下文窗口（用于 compact 阈值计算） |
| `LIGHTCLAW_COMPACT_THRESHOLD_RATIO` | 估算用量越过该比例后触发 compact（0.1 – 0.95） |
| `LIGHTCLAW_COMPACT_KEEP_RECENT` | compact 时保留的最近消息数 |
| `LIGHTCLAW_PERMISSION_MODE` | `default`、`acceptEdits`、`bypassPermissions` 或 `plan` |
| `LIGHTCLAW_PERMISSION_AUDIT_LOG` | 可选的权限决策 JSONL 路径 |
| `LIGHTCLAW_MCP_ENABLED` | 是否启用 MCP 启动（`true` / `false`） |
| `LIGHTCLAW_MCP_CONNECT_TIMEOUT` | 单个 MCP server 连接超时（毫秒） |
| `LIGHTCLAW_MCP_CONNECT_CONCURRENCY` | MCP 并发连接数 |
| `LIGHTCLAW_MCP_MAX_TOOL_OUTPUT_BYTES` | MCP tool result 截断阈值 |
| `LIGHTCLAW_HOOKS_ENABLED` | 是否加载 Hooks（`true` / `false`） |
| `LIGHTCLAW_HOOK_TIMEOUT_BLOCKING` | 阻塞型 hook 超时（毫秒） |
| `LIGHTCLAW_HOOK_TIMEOUT_NON_BLOCKING` | 非阻塞型 hook 超时（毫秒） |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 飞书渠道凭据 |
| `FEISHU_ENCRYPT_KEY` / `FEISHU_VERIFICATION_TOKEN` | 飞书 webhook 校验配置 |
| `FEISHU_PROXY` | 飞书 SDK HTTP 代理 URL |

## 使用

```bash
# 交互式 REPL
pnpm dev
pnpm start

# 单轮 prompt
pnpm dev -- --prompt "总结一下这个仓库"

# 恢复最近 / 指定 session
pnpm dev -- --resume
pnpm dev -- --resume <session-id>

# 覆盖模型或 Provider
pnpm dev -- --model claude-sonnet-4-20250514
pnpm dev -- --provider openai

# 关闭 auto-memory 提取与 memory 索引注入
pnpm dev -- --no-memory

# 关闭 MCP 启动与 MCP 工具注入
pnpm dev -- --no-mcp

# 关闭 Hooks 加载
pnpm dev -- --no-hooks

# 权限 mode 与 CLI 规则
pnpm dev -- --permission-mode plan
pnpm dev -- --allow "Bash(git status:*)" --deny "Bash(rm:*)"
pnpm dev -- --dangerously-bypass

# 飞书 webhook 渠道
pnpm dev -- channel list
pnpm dev -- channel feishu start
```

### 权限系统

| Mode | 行为 |
|---|---|
| `default` | 读/搜索工具直接执行；写入与执行类工具在 REPL 询问，非交互模式自动拒绝 |
| `acceptEdits` | 读/搜索/写入/编辑直接执行；执行、网络抓取、子 Agent 仍需确认 |
| `bypassPermissions` | 除非命中显式 deny rule，否则所有工具直接执行 |
| `plan` | 只允许读/搜索；写入与执行类工具拒绝，除非命中显式 allow rule |

规则文件格式：

```json
{
  "allow": ["Read", "Bash(git status:*)", "WebFetch(github.com)"],
  "deny": ["Bash(rm:*)", "Bash(sudo:*)"]
}
```

规则来源按 `cliArg` → `session` → `local` → `project` → `user` 合并；任意来源的 deny 都优先于 allow。`/allow` 与 `/deny` 添加的是 session 规则，不持久化；当前 permission mode 会写入 session `meta.json` 并在 `--resume` 时恢复。

模式匹配语义：
- `Bash(cmd:*)` 按 token 边界匹配 —— `Bash(rm:*)` 命中 `rm` 与 `rm -rf foo`，**不**命中 `rmdir`。
- `WebFetch(example.com)` 精确匹配 hostname；`WebFetch(*.example.com)` 匹配任意子域。
- `Read(/etc/*)` / `Write(/etc/*)` / `Edit(/etc/*)` 为路径前缀匹配。
- `MCP(github:*)` 放行 `github` server 的所有 MCP 工具；`MCP(github:list_issues)` 只放行指定工具；`MCP(github:list_*)` 按工具名前缀匹配。
- 带 content 的规则目前只对 `Bash`、`WebFetch`、`Read` / `Write` / `Edit`、`AgentTool` 生效；其他工具只支持整工具级 allow/deny。

### MCP

LightClaw 从以下路径读取 MCP server 配置：

1. `~/.lightclaw/mcp.json`
2. `<cwd>/.lightclaw/mcp.json`
3. `<cwd>/.lightclaw/mcp.local.json`

后面的配置按 server 名覆盖前面的配置。格式兼容常见的 `{ "mcpServers": ... }`：

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

支持 `stdio`、`http`（Streamable HTTP）和 `sse` 三种 transport。`env` 与 `headers` 的值支持 `${VAR}` 环境变量展开。远端工具会暴露为 `mcp__<normalized-server>__<tool>`，默认风险等级为 `write`，所以 `default` mode 下首次调用会询问，除非命中 allow rule。

### Hooks

LightClaw 从 `~/.lightclaw/hooks/` 和 `<cwd>/.lightclaw/hooks/` 加载 `.mjs` 文件。每个文件默认导出一个对象，可包含 `onSessionStart`、`beforeQuery`、`beforeToolCall`、`afterToolCall`、`afterQuery`、`onSessionEnd`。

```js
export default {
  beforeToolCall({ toolName, input }) {
    if (toolName === 'Bash' && input?.command?.includes('rm -rf /')) {
      return { decision: 'deny', reason: 'blocked by project hook' }
    }
  },
}
```

### 飞书渠道

飞书渠道读取 `~/.lightclaw/channels.json` 并启动 webhook server。源码树不包含当前环境凭据。

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

### REPL 命令

| 命令 | 说明 |
|---|---|
| `/exit` | 退出 REPL |
| `/status` | 显示 session id、消息数、token 估算、压缩次数、provider、routing |
| `/sessions` | 列出最近的 session |
| `/compact` | 手动压缩当前 session |
| `/todos` | 查看当前 todo list |
| `/memory` | 查看项目 memory 文件与 auto-memory 索引 |
| `/skills` | 列出可用 Skill |
| `/skill <name> [args]` | 按名称调用 Skill |
| `/permissions` | 查看当前 mode 与各来源权限规则 |
| `/permissions clear` | 清空 session 级权限规则 |
| `/mode <mode>` | 切换当前 session 的 permission mode |
| `/allow <rule>` / `/deny <rule>` | 添加 session 级 allow 或 deny 规则 |
| `/mcp` | 查看 MCP server 状态与工具数量 |
| `/mcp reload` | 全量重连已配置的 MCP server |
| `/hooks` | 查看已加载的生命周期 hooks |
| `/hooks reload` | 重新加载 hook 文件 |

## 目录结构

```
src/
├── cli.ts              # 参数解析与入口
├── init.ts             # 初始化：config + state + session 恢复
├── config.ts           # 环境变量 + ~/.lightclaw/config.json 解析
├── state.ts            # 进程级单例（cwd、model、sessionId、usage、...）
├── prompt.ts           # system prompt 构造（身份 + 工具 + memory + todos）
├── query.ts            # agent loop、工具派发、auto-compact、memory 提取
├── repl.ts             # readline REPL 与 slash 命令
├── messages.ts         # user/assistant/compact 消息构造
├── types.ts            # message / session / meta 公共类型
├── api.ts              # 对 provider.streamChat() 的薄兼容层
├── token-estimate.ts   # 本地基于字符的 token 估算
├── tool.ts             # Tool<I,O> 接口，Zod → JSON Schema
├── tools.ts            # 工具注册表 + capability 过滤
├── tools/              # 13 个内置工具
├── permission/         # mode、规则解析、匹配、决策、确认提示、audit
├── mcp/                # MCP 配置、transport、registry、tool adapter
├── provider/           # Anthropic / OpenAI-compatible 实现 + modelFor()
├── session/            # 存储（JSONL + meta.json）、列表、压缩
├── memory/             # LIGHTCLAW.md 发现、auto-memory、后台提取
├── skill/              # loader、registry、内置 skill（verify、remember）
├── agents/             # 内置子 Agent（general-purpose、explore）
├── todos/              # todo 校验与持久化
└── web/                # 代理感知 HTTP fetch + HTML → Markdown
```

## 架构简图

```
cli.ts ──► init.ts ──► repl.ts ──► query.ts ──► provider.streamChat()
            (state)     (UI)        (agent loop)
                                    │
                                    ├─► tools/ (Bash, Read, Write, Edit, Grep, Glob, ...)
                                    ├─► mcp/   (外部 MCP tool adapter)
                                    ├─► permission/ (mode + rule 检查)
                                    ├─► prompt.ts (system prompt template)
                                    ├─► session/ (transcript + compact)
                                    ├─► memory/  (discovery + auto-memory + extract)
                                    ├─► skill/   (loader + registry + UseSkill)
                                    └─► agents/  (sub-agent runner)
```

关键不变量：

- **`state.ts` 是唯一的进程级单例。** 仅 `initializeApp()` 写入；其余位置通过 getter 读取。每轮 query 开始时，`beginQuery()` 重置 `AbortController`。
- **工具采用 schema-first 设计。** 内置工具使用 Zod input schema，并通过 `zod/v4` 的 `toJSONSchema()` 转为 JSON Schema。MCP 工具直接携带 server 返回的 raw JSON Schema，并跳过本地 Zod 校验。新内置工具在 `src/tools.ts` 的 `builtinTools` 中注册。
- **Auto-Compact 由阈值驱动。** 每轮 assistant 结束后，`maybeAutoCompact()` 将本地 token 估算与 `contextWindow * compactThresholdRatio` 做对比，命中后**原地重写** transcript，不再 append。
- **Session 存储是 append-only 的 JSONL + 同名 `meta.json`。** 只有压缩会重写 transcript。
- **工具派发经过权限门控。** 每个工具声明 `riskLevel`，`query.ts` 在 `tool.call()` 前检查 mode + rules，被拒绝的调用作为 tool error 返回给模型。
- **MCP 只做 Client。** 启动时连接配置好的 server；失败 server 不阻塞 REPL；`/mcp reload` 执行全量重连。
- **子 Agent 同步执行。** 拥有独立的消息列表、被裁剪的工具白名单（禁用 `AgentTool` / `TodoWrite` / `MemoryWrite` 以免污染父 session），权限检查强制非交互，其 usage 会计入父 session。

## 许可证

MIT
