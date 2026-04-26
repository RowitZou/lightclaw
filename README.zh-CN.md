# LightClaw

中文 · [English](./README.md)

LightClaw 是一个可以住在终端里、（可选地）也住在你聊天软件里的自托管 AI Agent。你给它一个任务——读代码、跑命令、总结对话、抓网页——它会一边调工具一边把过程流式打给你看。

它是用 TypeScript 从头写的，以 [Claude Code](https://github.com/anthropics/claude-code) 为架构蓝本。整个运行时打包出来是一个 ~230 KB 的单文件 ESM bundle。

这份 README 用第一次接触 LightClaw 的视角带你走一遍。

---

## 它能干什么

- 一个**终端 REPL**，你输入问题，看着 agent 流式回答，每一次工具调用（读文件、跑命令、抓网页……）都打在屏幕上。
- 一份**持久 memory**，跨 session、跨机器，只要你用同一个身份登录就一直跟着你——不用每次都重新介绍你的项目。
- 一个**身份层**，让你在终端、飞书、微信里对 bot 永远是同一个人，不用反复自报家门。
- **配对（pairing）式准入**：陌生人在聊天软件里找不到你的 bot，新成员需要管理员从终端批一次才能用。
- **飞书 / 微信 bot**：同事可以在手机上和同一个 agent 聊天。
- **可扩展点**：MCP server、生命周期 hooks、自定义 skill、项目级权限、项目级 memory 文件。

刻意做得很小：v1 没有 React/Ink 全屏 UI、没有 IDE bridge、没有多账号扇出、没有"团队模式"。终端只有**一个 admin**。

---

## 5 分钟上手

### 1. 前置条件

- Node.js 22+
- pnpm 10+
- 一个 Anthropic 兼容（或 OpenAI 兼容）API key

### 2. 安装

```bash
pnpm install
pnpm build
```

开发迭代直接用 `pnpm dev`（等价于 `tsx src/cli.ts`），无需构建。

### 3. 告诉 LightClaw 用哪个模型

最小配置就是 `~/.lightclaw/config.json` 一个文件：

```jsonc
{
  "provider": "anthropic",
  "providerOptions": {
    "anthropic": {
      "apiKey": "sk-..."           // 把你的 key 贴这里
    }
  }
}
```

如果你走第三方 Anthropic 兼容代理，加一条 `"baseUrl": "https://你的代理/"`（**不要**带 `/v1`，LightClaw 自己会拼）。默认模型是 `claude-sonnet-4-6`，可以用 `LIGHTCLAW_MODEL=...` 或在配置里覆盖。

### 4. 第一次启动 — 创建 admin 身份

```bash
node dist/cli.js
# 或：pnpm start
```

由于是首次启动，LightClaw 会进入一道交互提问：

```
LightClaw is not initialized. Setting up first admin.

Admin canonical name (default: 你的OS用户名):
```

回车接受 OS 用户名，或者输入个名字比如 `alice`。LightClaw 在 `~/.lightclaw/identity/` 下落几个文件，然后 banner 显示 `admin: alice` 进 REPL。从此以后 `lightclaw` 直接进 REPL，不再问。

### 5. 打个招呼

```
you> 你好，你是谁？
assistant> 我是 LightClaw，一个交互式 AI agent ……
```

退出：`/exit` 或 Ctrl-D。

入门到此结束。剩下的都是进了 REPL 之后的玩法。

---

## 在终端里跟 LightClaw 对话

REPL 里凡是不以 `/` 开头的内容都是发给模型的 prompt。模型可以调工具（Read、Write、Bash……），调用过程会流式打出来：

```
you> 这个项目是什么？
[tool] Glob {"pattern":"**/*"}
[tool-result] Glob
[tool] Read {"file_path":"package.json"}
[tool-result] Read
assistant> 这是一个叫 lightclaw 的 TypeScript 项目……
```

工具如果要做有破坏性的事（写文件、跑 Bash、抓 URL），LightClaw 会停下来问你——见下面 [权限](#权限) 章节。

### Slash 命令

凡是 `/` 开头的输入都是 REPL 命令（本地处理，不发给模型）：

#### 身份与会话

| 命令 | 作用 |
|---|---|
| `/whoami` | 显示当前 LightClaw 用户（如 `user: alice`）。 |
| `/identity` | 提示用 `lightclaw identity ...` 管理身份（详见 [身份与配对](#身份与配对)）。 |
| `/sessions` | 列出当前用户的历史会话，最近的在前。 |
| `/status` | 一行显示 session id、cwd、model、provider、permission mode、MCP/hook 数量。 |

#### memory 与历史

| 命令 | 作用 |
|---|---|
| `/memory` | 列出当前用户的长期 memory 文件。每轮对话结束自动后台抽取，加上 `MemoryWrite` 显式写入的。 |
| `/compact` | 手动压缩当前 session（LLM 总结）。准备开长任务前先压一压能省上下文窗口。 |
| `/todos` | 显示进行中的 todo 列表（agent 自己的便签——做多步任务时它会写）。 |

#### Skill

| 命令 | 作用 |
|---|---|
| `/skills` | 列出 agent 可用的所有 skill（内置 + `~/.lightclaw/skills/` + `<project>/.lightclaw/skills/`）。 |
| `/skill <name> [args]` | 把 skill 当作 prompt 模板来跑。内置两个：`verify`（用工具调用验证近期断言）和 `remember`（保存到 memory）。 |

#### 权限（详见 [权限](#权限)）

| 命令 | 作用 |
|---|---|
| `/permissions` | 显示当前 mode 与所有按 source 分组的 allow/deny 规则。 |
| `/permissions clear` | 清掉本 session 加的规则（`/allow`、`/deny` 那些）。 |
| `/mode <mode>` | 切换 permission mode：`default` / `acceptEdits` / `bypassPermissions` / `plan`。 |
| `/allow <rule>` | 添加 session 级 allow 规则，如 `/allow Bash(git status:*)`。 |
| `/deny <rule>` | 添加 session 级 deny 规则，如 `/deny Bash(rm:*)`。 |

#### 工具与集成

| 命令 | 作用 |
|---|---|
| `/mcp` | 显示 MCP server 状态（connected / failed / disabled）和工具数。 |
| `/mcp reload` | 重连所有 MCP server。 |
| `/hooks` | 列出已加载的生命周期 hook。 |
| `/hooks reload` | 重新扫描并加载 hook 脚本。 |

#### 退出

| 命令 | 作用 |
|---|---|
| `/exit` | 关闭 REPL（也支持 Ctrl-D）。 |

---

## Agent 能做什么

开箱有 **16 个工具**。你不直接调它们——模型在干活时自己挑。简要分类：

| 类别 | 工具 | 用途 |
|---|---|---|
| 文件系统 | `Read`、`Write`、`Edit`、`Glob`、`Grep` | 读写文件、按 glob/正则搜代码。 |
| Shell | `Bash` | 跑 shell 命令（受权限系统拦）。 |
| Web | `WebFetch`、`WebSearch` | 抓 URL 转 Markdown，做网络搜索（仅 Anthropic 直连可用）。 |
| Memory | `MemoryRead`、`MemoryWrite` | 当前用户的持久 memory，跨 session 保留。 |
| 历史会话 | `ConversationList`、`ConversationRead`、`ConversationGrep` | 浏览/读/搜你自己的历史 session。 |
| 任务跟踪 | `TodoWrite` | 在对话内维护结构化 todo。 |
| 子 Agent | `AgentTool` | 起隔离的子 agent（`general-purpose` 或 `explore`）做专项任务。 |
| Skill | `UseSkill` | 把 skill 当 prompt 模板执行。 |

---

## 身份与配对

终端用户是 **admin**。从聊天软件来的人是**普通 user**，要管理员先批一次才能用 bot。

admin 用 `lightclaw identity` 子命令管理所有人：

```bash
lightclaw identity list                          # 列已注册用户 + 各自的 channel 绑定
lightclaw identity pending                       # 列待批的 pairing 请求
lightclaw identity approve K7YQ3RPA --as alice   # 批准并绑到 canonical user "alice"
lightclaw identity approve M8XN2RPB --as alice   # 把第二个 channel 绑到同一个 alice
lightclaw identity reject K7YQ3RPA               # 拒绝 / 丢弃一个 pending 请求
lightclaw identity link alice feishu:ou_xxx      # admin 直接 link，跳过 pairing
lightclaw identity unlink wechat:o9_yyy          # 解某条绑定
lightclaw identity remove bob                    # 删用户（默认保留 sessions/memory；--purge 物理清）
```

一个 canonical user（alice）可以绑**多个** channel 身份（飞书 open_id、微信 user_id、终端 OS 用户）。所有这些绑定共享同一份 `~/.lightclaw/memory/alice/`、同一份对话历史（通过 `Conversation*` 工具）、对 alice 偏好的同一份长期记忆。**Session 仍按 channel 分**（`feishu-alice`、`wechat-alice`），免得上下文跨渠道串味。

---

## 接入飞书 / 微信

可选。如果你只用终端，跳过这一节。

### 一次性配置

1. 把凭据放进 `~/.lightclaw/channels.json`（建议 mode 600）。见 [Channels 配置](#channels-配置)。
2. 启动渠道 daemon：

   ```bash
   lightclaw channel feishu start    # 默认 WS 长连接，无需公网入口
   lightclaw channel wechat login    # 扫码登录 bot 账号
   lightclaw channel wechat start    # long-poll daemon
   ```
3. 在聊天 app 里向 bot 发消息。陌生 sender 会收到一条 pairing code：

   ```
   Welcome to LightClaw bot.
   To use this bot, ask the LightClaw operator to approve this pairing code: K7YQ3RPA
   Operator command: lightclaw identity approve K7YQ3RPA --as <name>
   ```
4. 终端里 admin 跑 `lightclaw identity pending` 看所有待批，再 `lightclaw identity approve K7YQ3RPA --as alice`。每个 channel 只配对一次。

### 在聊天里能做什么

- 文本进、文本出。
- 入站媒体（图片、文件、语音→转文字）—— 落到本地，agent 拿到路径用 `Read` 工具看。
- 跟终端一样的 memory 和 conversation 工具，按 canonical user 自动隔离。

### 还做不了什么

- 出站媒体、streaming card、多账号、聊天里的 `/slash` 命令、主动推送、IDE bridge。

---

## 权限

LightClaw 的工具按**风险**分级：读 / 搜索类是 `safe`，写文件是 `write`，shell + web + 子 agent 是 `execute`。当前 **mode** 决定模型试图调非 `safe` 工具时会发生什么：

| Mode | 行为 |
|---|---|
| `default` | `safe` 自动放行；`write`/`execute` 在 REPL 里弹确认，非交互场景默认 deny。 |
| `acceptEdits` | `safe` + `write`/`edit` 自动放行；`execute` 仍要确认。 |
| `bypassPermissions` | 全部放行（除非显式 deny）。 |
| `plan` | 只读模式：`write` 和 `execute` 默认 deny，除非显式 allow。 |

REPL 内 `/mode <mode>` 切换。持久规则按以下来源（**优先级从高到低**）：

- **CLI 参数**（最高）：`--allow "Bash(git status:*)"`、`--deny "Bash(rm:*)"`、`--permission-mode plan`、`--dangerously-bypass`。
- **Session 级**（REPL 内）：`/allow ...`、`/deny ...`，**不持久化**。
- **Local 文件**（`<cwd>/.lightclaw/permissions.local.json`）：不入 git。
- **Project 文件**（`<cwd>/.lightclaw/permissions.json`）：入 git。
- **User 文件**（`~/.lightclaw/permissions.json`）：你机器上全局默认。

规则格式：

```json
{
  "allow": ["Read", "Bash(git status:*)", "WebFetch(github.com)"],
  "deny":  ["Bash(rm:*)", "Bash(sudo:*)"]
}
```

模式语义：

- `Bash(rm:*)` 匹配 `rm` 与 `rm -rf foo`，**不**匹配 `rmdir`。
- `WebFetch(example.com)` 精确匹配该 hostname；`WebFetch(*.example.com)` 匹配任意子域。
- `Read(/etc/*)` 单层匹配；`Read(/etc/**)` 递归匹配。
- `MCP(github:list_*)` 按 MCP 工具名前缀匹配。

内置 deny 规则**禁止 Read/Write/Edit 访问 `~/.lightclaw/**`**（identity / memory / sessions / pairing 数据所在），同时 `Bash` 对明文引用该路径的命令做拦截。这是一个软沙箱——见 [安全说明](#安全说明已知边界)。

---

## 配置

### `~/.lightclaw/config.json` 全字段示例

```jsonc
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
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
    "main":      "claude-sonnet-4-6",
    "compact":   "claude-haiku-4-5-20251001",
    "extract":   "claude-haiku-4-5-20251001",
    "subagent":  "claude-sonnet-4-6",
    "webSearch": "claude-sonnet-4-6"
  },
  "sessionsDir": "~/.lightclaw/sessions",
  "memoryDir":   "~/.lightclaw/memory",
  "autoCompact": true,
  "autoMemory":  true,
  "contextWindow": 200000,
  "compactThresholdRatio": 0.75,
  "compactKeepRecent":     6,
  "permissionMode": "default",
  "permissionRuleFiles": {
    "user":    "~/.lightclaw/permissions.json",
    "project": ".lightclaw/permissions.json",
    "local":   ".lightclaw/permissions.local.json"
  },
  "permissionAuditLog": "~/.lightclaw/permissions.audit.jsonl",
  "mcpEnabled": true,
  "mcpConnectTimeout":      10000,
  "mcpConnectConcurrency":  4,
  "mcpMaxToolOutputBytes":  20480,
  "hooksEnabled": true,
  "hookTimeoutBlocking":     5000,
  "hookTimeoutNonBlocking": 10000
}
```

解析顺序：**环境变量 → `~/.lightclaw/config.json` → 内置默认**。文件可以为空，全靠环境变量也行。

### 常用环境变量

| 变量 | 作用 |
|---|---|
| `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` | Anthropic 凭据 |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` | OpenAI 兼容凭据 |
| `LIGHTCLAW_PROVIDER` | `anthropic` 或 `openai` |
| `LIGHTCLAW_MODEL` | 主模型覆盖 |
| `LIGHTCLAW_ROUTING_{MAIN,COMPACT,EXTRACT,SUBAGENT,WEBSEARCH}` | 按用途分别覆盖模型 |
| `LIGHTCLAW_AUTO_COMPACT` / `LIGHTCLAW_AUTO_MEMORY` | 功能开关（`true`/`false`）|
| `LIGHTCLAW_CONTEXT_WINDOW` | 用于 compact 阈值计算的 token 预算 |
| `LIGHTCLAW_COMPACT_THRESHOLD_RATIO` | 估算 token 越过此比例触发 compact（0.1–0.95） |
| `LIGHTCLAW_COMPACT_KEEP_RECENT` | compact 时保留的最近消息数 |
| `LIGHTCLAW_PERMISSION_MODE` | `default` / `acceptEdits` / `bypassPermissions` / `plan` |
| `LIGHTCLAW_PERMISSION_AUDIT_LOG` | 权限决策 JSONL 路径（可选） |
| `LIGHTCLAW_MCP_ENABLED` / `LIGHTCLAW_HOOKS_ENABLED` | 启停开关 |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `FEISHU_ENCRYPT_KEY` / `FEISHU_VERIFICATION_TOKEN` / `FEISHU_PROXY` | 飞书渠道覆盖 |
| `LIGHTCLAW_WECHAT_PERMISSION_MODE` | 微信渠道权限 mode 覆盖 |

### Channels 配置

`~/.lightclaw/channels.json`（敏感值不入源码）：

```jsonc
{
  "feishu": {
    "enabled": true,
    "appId":    "<app_id>",
    "appSecret": "<app_secret>",
    "encryptKey": "<encrypt_key>",
    "verificationToken": "<verification_token>",
    "transport": "ws",                    // 'ws'（默认，无需公网）或 'webhook'
    "proxy": "http://127.0.0.1:1080",     // 可选；不填则 fallback https_proxy/http_proxy
    "permissionMode": "default",
    "allowUsers": ["*"],
    "allowChats": ["*"],
    "mediaEnabled": true,
    "mediaDir": "~/.lightclaw/state/feishu/media",
    "webhook": {                           // transport='ws' 时忽略
      "host": "0.0.0.0",
      "port": 18850,
      "path": "/feishu/events"
    }
  },
  "wechat": {
    "enabled": true,
    "permissionMode": "default",
    "allowSenders": ["*"],
    "textChunkSize": 4000,
    "longPollTimeoutMs": 35000,
    "mediaEnabled": true,
    "mediaDir": "~/.lightclaw/state/wechat/media"
  }
}
```

微信 bot token 落在 `~/.lightclaw/state/wechat/accounts/default.json`（mode 600），long-poll cursor 在 `state/wechat/sync/`，context-token 在 `state/wechat/context-tokens/`，入站媒体在 `state/wechat/media/`。

---

## 进阶能力

### MCP servers

把 MCP server 写在 `~/.lightclaw/mcp.json`（或项目级 `<cwd>/.lightclaw/mcp.json` / `mcp.local.json`）。后者按 server name 覆盖前者。格式是标准的 `{ "mcpServers": {...} }`：

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
      "headers": { "Authorization": "Bearer ${DOCS_MCP_TOKEN}" }
    }
  }
}
```

Transport 支持：`stdio`、`http`（Streamable）、`sse`。`env` 和 `headers` 里 `${VAR}` 会做环境变量展开。远端工具暴露为 `mcp__<server>__<tool>`，默认风险 `write`，所以 `default` 模式下首次调用会确认（除非配了 `MCP(github:*)` 这种 allow 规则）。

### 生命周期 Hooks

把 `.mjs` 文件丢到 `~/.lightclaw/hooks/` 或 `<cwd>/.lightclaw/hooks/`。文件 export 一个对象，可包含：`onSessionStart`、`beforeQuery`、`beforeToolCall`、`afterToolCall`、`afterQuery`、`onSessionEnd`。

```js
export default {
  beforeToolCall({ toolName, input }) {
    if (toolName === 'Bash' && input?.command?.includes('rm -rf /')) {
      return { decision: 'deny', reason: 'blocked by project hook' }
    }
  },
}
```

### 项目 Memory

把 `LIGHTCLAW.md`（或 `LIGHTCLAW.local.md`，自动 ignore）丢在项目树任意位置。LightClaw 启动时会全部发现，注入 system prompt。适合写"项目约定 / 联系人 / 任何要告诉新同事的第一天信息"。

### 子 Agent

内置两个：`general-purpose`（通用任务）和 `explore`（只读探查代码库）。agent 在需要隔离上下文时通过 `AgentTool` 调用。子 agent 的工具白名单**不含** `AgentTool`/`TodoWrite`/`MemoryWrite`，权限非交互，最终回答带回父 agent。

### Sessions 和 resume

每次 REPL session 在 `~/.lightclaw/sessions/<id>/` 落 JSONL transcript + `meta.json`。恢复：

```bash
lightclaw --resume                    # 最近 session
lightclaw --resume <session-id>       # 指定 session
```

`/sessions` 列你的；agent 自己也可以通过 `ConversationList` / `Read` / `Grep` 翻查。

### Auto-Compact

当本地 token 估算越过 `contextWindow * compactThresholdRatio`（默认 0.75 × 200k = 150k），LightClaw 触发一次 LLM 总结，把老消息替换成摘要，保留最近 `compactKeepRecent`（默认 6）条不动。transcript 文件**原地重写**，所以 `--resume` 拿到的是压缩后的版本。也可以 `/compact` 手动触发。

---

## 安全说明（已知边界）

- `~/.lightclaw/**` 沙箱靠**`Read`/`Write`/`Edit` 工具的 deny 规则 + `Bash` 子串守卫**实现。它能拦住模型自然写出的 `cat ~/.lightclaw/users/bob.json`，**拦不住**坚决要绕的攻击者：`eval "$cmd"`、symlink、`c""at` 这种字面拼接。真正的进程沙箱（chroot/landlock）在路线图上。
- 身份验证信任聊天平台：飞书 / 微信说消息来自 `ou_xxx`，LightClaw 就信。**pairing 那一步是你唯一的准入闸**。
- v1 单 admin。多 admin / 角色权限在路线图上。

---

## CLI 速查

```bash
# 普通对话
lightclaw                                       # REPL
lightclaw --prompt "讲一下这个仓库"             # 单次

# Sessions
lightclaw --resume                              # 恢复最近
lightclaw --resume <id>                         # 恢复指定

# Provider / 模型覆盖
lightclaw --provider anthropic
lightclaw --model claude-sonnet-4-6

# 功能开关
lightclaw --no-memory                           # 不抽取 / 不注入 memory
lightclaw --no-mcp                              # 不连 MCP
lightclaw --no-hooks                            # 不加载 hook 脚本

# 权限
lightclaw --permission-mode plan
lightclaw --allow "Bash(git status:*)"
lightclaw --deny "Bash(rm:*)"
lightclaw --dangerously-bypass

# 身份（admin 命令）
lightclaw identity list
lightclaw identity pending
lightclaw identity approve <code> --as <name>
lightclaw identity reject <code>
lightclaw identity link <name> <channel:id>
lightclaw identity unlink <channel:id>
lightclaw identity remove <name> [--purge]

# Channels
lightclaw channel list
lightclaw channel feishu start
lightclaw channel wechat login
lightclaw channel wechat start
```

---

## 给贡献者

### 项目结构

```
src/
├── cli.ts              # 参数解析 + 入口
├── init.ts             # bootstrap：config + state + session resume
├── init-wizard.ts      # 首次启动 admin 身份 wizard
├── cli-identity.ts     # `lightclaw identity ...` 子命令
├── cli-channel.ts      # `lightclaw channel ...` 子命令
├── config.ts           # env + ~/.lightclaw/config.json 解析
├── state.ts            # 进程级单例（cwd / model / sessionId / currentUserId / ...）
├── prompt.ts           # system prompt 生成
├── query.ts            # agent loop / tool 派发 / auto-compact / memory 抽取
├── repl.ts             # readline REPL + slash 命令派发
├── messages.ts         # user / assistant / compact 消息构造
├── api.ts              # provider.streamChat() 兼容层
├── token-estimate.ts   # 本地 char-based token 估算
├── tool.ts             # Tool<I,O> 接口、Zod → JSON Schema
├── tools.ts            # 工具注册表 + capability gate
├── tools/              # 内置工具（Read/Write/Edit/Bash/Glob/Grep/Memory*/Conversation*/Web*/Todo/UseSkill/Agent）
├── identity/           # canonical 用户、terminal admin、pairing、安全 JSON 状态
├── permission/         # mode / 规则解析 / 匹配 / policy / prompt / audit
├── mcp/                # MCP 配置 / transport / registry / 工具适配
├── provider/           # Anthropic / OpenAI 兼容 provider + modelFor()
├── session/            # storage (JSONL + meta.json)、listing、compact
├── memory/             # LIGHTCLAW.md 发现 / auto-memory / 抽取
├── skill/              # loader / registry / bundled skills（verify、remember）
├── agents/             # 内置子 agent（general-purpose、explore）
├── todos/              # todo 列表校验 + 持久化
├── channels/           # Channel 抽象 + 飞书（ws/webhook）+ 微信（long-poll）
└── web/                # 代理感知 HTTP fetch + HTML → Markdown
```

### 架构简图

```
cli.ts ──► init-wizard? ──► init.ts ──► repl.ts ──► query.ts ──► provider.streamChat()
                              (state)     (UI)        (agent loop)
                                                      │
                                                      ├─► tools/（filesystem / shell / web / conversation / memory / ...）
                                                      ├─► mcp/（外部 MCP 工具适配）
                                                      ├─► permission/（mode + 规则检查）
                                                      ├─► prompt.ts（system prompt 模板）
                                                      ├─► session/（transcript + compact）
                                                      ├─► memory/（discovery + auto-memory + extract）
                                                      ├─► skill/（loader + registry + UseSkill）
                                                      └─► agents/（子 agent runner）
```

### 核心不变量

- `state.ts` 是唯一进程级单例。`initializeApp()` 是唯一 writer，其他都通过 getter 读。`beginQuery()` 重置每轮的 `AbortController`。
- 工具是 schema-first。内置工具用 Zod，运行时 `zod/v4` 的 `toJSONSchema()` 转 JSON Schema。MCP 工具直接拿 server 给的 raw JSON Schema，跳过本地 Zod 校验。
- Auto-compact **原地重写** transcript，从不追加。
- 身份是所有用户相关数据的 scope 维度：session meta 带 `userId`，memory 是 `~/.lightclaw/memory/<canonical>/`，`Conversation*` 工具拒读别人的 session。
- 子 agent 继承父身份，但跑在隔离消息列表 + 工具白名单里。

---

## 协议

MIT
