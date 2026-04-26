# LightClaw

中文 · [English](./README.md)

LightClaw 是一个自托管个人 AI 助手，可以住在终端里，也可以接入飞书 / 微信。它是用 TypeScript / Node.js 从头重写的 Agent Harness，架构参考 Claude Code，但 Phase 10 开始把大部分 harness 调试面从用户视角藏起来。

默认体验很简单：启动 `lightclaw`，自然语言聊天，让助手在背后使用 tool、memory、skill 和 channel。

---

## 快速开始

```bash
pnpm install
pnpm build
node dist/cli.js
```

凭据可以放在 `~/.lightclaw/config.json`，也可以走环境变量：

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

首次交互式启动会创建 v1 单 admin 身份。之后终端启动会自动恢复当前用户最近一次 session。

---

## CLI 面

```bash
lightclaw
lightclaw --prompt "帮我规划今天"
lightclaw --resume
lightclaw --resume <session-id>
lightclaw --help
```

Phase 9 的旧 CLI flag / 子命令已经收口到配置和 slash：

- 模型 / provider：`~/.lightclaw/config.json`、`LIGHTCLAW_MODEL`、`LIGHTCLAW_PROVIDER`
- 功能开关：`LIGHTCLAW_NO_MEMORY=1`、`LIGHTCLAW_NO_MCP=1`、`LIGHTCLAW_NO_HOOKS=1`
- 权限细规则：编辑 `~/.lightclaw/permissions.json`
- 身份管理：`/identity ...` slash
- 渠道：在 `~/.lightclaw/channels.json` 里 `enabled: true`，主 `lightclaw` 进程会自动拉起

---

## Slash 命令

普通用户可见：

| 命令 | 作用 |
|---|---|
| `/help` | 显示当前 model/mode、可用 model/mode、skill 目录和命令。 |
| `/model <name>` | 切换当前 session 的模型。 |
| `/mode <mode>` | 在当前 ceiling 内切换 permission mode。 |

Admin 专属：

| 命令 | 作用 |
|---|---|
| `/identity list|pending|approve|reject|link|unlink|remove` | 管理 pairing 和用户绑定。 |
| `/ceiling <default|plan|acceptEdits|bypassPermissions>` | 设置 identities 的权限上限。 |

Channel 中以 `/` 开头的消息也会先走本地 slash 派发，所以 admin 可以在自己的飞书 / 微信里审批 pairing code。

---

## 身份与渠道

未知飞书 / 微信 sender 会收到 pairing code。Admin 审批：

```text
/identity approve K7YQ3RPA --as alice
```

每个 canonical user 都有：

- user-scoped memory：`~/.lightclaw/memory/<user>/`
- 带 `userId` 的 session meta
- `feishu-alice` / `wechat-alice` 这类 channel session
- 私有 workspace：`~/.lightclaw/workspaces/<user>/`

渠道配置在 `~/.lightclaw/channels.json`。需要自动启动的渠道设置 `enabled: true`。

---

## Workspace 边界

Phase 10 移除了旧的“项目 cwd”心智模型。文件工具和 Bash 都锁在当前用户的私有 workspace：

```text
~/.lightclaw/workspaces/<canonical_user>/
```

`Read` / `Write` / `Edit` / `Glob` / `Grep` 在普通权限规则之前先做 workspace 边界检查，越界直接 deny。`Bash` 会拒绝明显逃逸形式，比如 workspace 外绝对路径、`..`、`$HOME`、`~`。

这还不是真正的进程沙箱；symlink、`eval`、间接 shell 拼接仍属于后续安全加固范围。

---

## Tool、Skill、MCP、Hooks

模型仍能使用 Phase 1-9 的 toolset：文件工具、Bash、Web、Memory、Conversation、TodoWrite、子 Agent、MCP tool 和 `UseSkill`。

Skill 不再通过 `/skill` 手动调用。Skill description 使用 `TRIGGER` / `SKIP` 指引，模型会在任务匹配时自然调用 `UseSkill`。Skill 的 `allowed_tools` 现在会在 skill 激活后强制限制后续 tool 调用。

MCP server 和 hooks 仍是 admin 的配置文件能力，放在 `~/.lightclaw/` 下；用户面的 `/mcp`、`/hooks` 等调试 slash 已删除。

---

## 配置提示

常用环境变量：

| 变量 | 用途 |
|---|---|
| `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` | Anthropic 凭据 |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` | OpenAI-compatible 凭据 |
| `LIGHTCLAW_PROVIDER` | `anthropic` 或 `openai` |
| `LIGHTCLAW_MODEL` | 默认模型 |
| `LIGHTCLAW_ALLOWED_MODELS` | `/model` 可选模型列表，逗号分隔 |
| `LIGHTCLAW_NO_MEMORY` / `LIGHTCLAW_NO_MCP` / `LIGHTCLAW_NO_HOOKS` | 关闭子系统 |
| `LIGHTCLAW_PERMISSION_MODE` | 默认 permission mode |

---

## 贡献者地图

```text
src/
├── cli.ts              # 极简 CLI、auto-resume、channel auto-start
├── init.ts             # config + workspace-scoped state 初始化
├── repl.ts             # readline REPL + slash dispatch
├── commands/           # /help、/model、/mode、/identity、/ceiling
├── channels/           # 飞书 / 微信 runner 与 channel slash dispatch
├── identity/           # canonical user、pairing、workspace、安全 JSON 状态
├── permission/         # mode/rule policy + workspace hard boundary
├── tools/              # 内置工具
├── skill/              # loader、registry、内置 skill
├── memory/             # LIGHTCLAW.md 发现与 user memory
├── mcp/                # MCP Client
├── hooks/              # 生命周期 hook loader
└── provider/           # Anthropic / OpenAI-compatible provider
```

## License

MIT
