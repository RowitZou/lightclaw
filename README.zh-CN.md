# LightClaw

中文 · [English](./README.md)

LightClaw 是一个用 TypeScript 从头编写的自托管 AI Agent Harness，以 [Claude Code](https://github.com/anthropics/claude-code) 为架构蓝本。核心是一个轻量、终端原生的 REPL，背后连接流式工具调用的 agent loop、持久化 session、自动上下文压缩、Memory + Skill 系统、子 Agent，以及 Web 工具。

## 当前状态

Phase 1 – 4 全部完成。构建产物为 ~91 KB 的单文件 ESM bundle。已具备：

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

刻意**未**实现：React/Ink 全屏 UI、权限系统、hooks、MCP、消息渠道（飞书/微信/IDE Bridge）、`@include` 指令、fork-agent memory 提取、micro-compact、`allowed_tools` 强制执行。

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
  "compactKeepRecent": 6
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
                                    ├─► prompt.ts (system prompt template)
                                    ├─► session/ (transcript + compact)
                                    ├─► memory/  (discovery + auto-memory + extract)
                                    ├─► skill/   (loader + registry + UseSkill)
                                    └─► agents/  (sub-agent runner)
```

关键不变量：

- **`state.ts` 是唯一的进程级单例。** 仅 `initializeApp()` 写入；其余位置通过 getter 读取。每轮 query 开始时，`beginQuery()` 重置 `AbortController`。
- **工具采用 schema-first 设计。** `Tool<TInput, TOutput>` 用 Zod input schema，通过 `zod/v4` 的 `toJSONSchema()` 转为 JSON Schema。新工具在 `src/tools.ts` 的 `allTools` 中注册。
- **Auto-Compact 由阈值驱动。** 每轮 assistant 结束后，`maybeAutoCompact()` 将本地 token 估算与 `contextWindow * compactThresholdRatio` 做对比，命中后**原地重写** transcript，不再 append。
- **Session 存储是 append-only 的 JSONL + 同名 `meta.json`。** 只有压缩会重写 transcript。
- **子 Agent 同步执行。** 拥有独立的消息列表、被裁剪的工具白名单（禁用 `AgentTool` / `TodoWrite` / `MemoryWrite` 以免污染父 session），其 usage 会计入父 session。

## 许可证

MIT
