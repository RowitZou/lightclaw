# LightClaw

中文 · [English](./README.md)

LightClaw 是一个自托管个人 AI 助手，可以住在终端里，也可以接入飞书 / 微信。它是用 TypeScript / Node.js 从头重写的 Agent Harness，架构参考 Claude Code，但 Phase 10 开始把大部分 harness 调试面从用户视角藏起来。

默认体验很简单：启动 `lightclaw`，自然语言聊天，让助手在背后使用 tool、memory、skill 和 channel。

---

## 快速开始

```bash
pnpm install
pnpm dev                 # tsx src/cli.ts —— 免构建，迭代最快
# 或者
pnpm build && pnpm start # 先 build 到 dist/cli.js 再 node 跑
```

需要 Node 22+ 和 pnpm 10+。

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

### 权限模式与 ceiling

四个 permission mode，从严到宽：

| Mode | 不询问就能跑的工具 |
|---|---|
| `plan` | 读取和搜索类工具。写入、编辑、执行、网络抓取、子 Agent 全部拒绝。 |
| `default` | 读取和搜索类工具。写入、编辑、执行、网络抓取、子 Agent 在交互模式下询问，非交互模式直接拒绝。 |
| `acceptEdits` | 读取、搜索、写入、编辑类工具。执行、网络抓取、子 Agent 仍询问。 |
| `bypassPermissions` | 全部自动放行。 |

`/mode <m>` 仅当 `m` 不超过当前 ceiling 的宽松度时才生效。默认 ceiling 是 `default`，用户可以主动切到更安全的 `plan` 或留在 `default`。如果想用更宽松的模式，admin 必须先抬升 ceiling：

```text
/ceiling bypassPermissions   # admin: 抬升所有人（含 admin 自己）的上限
/mode bypassPermissions      # 然后任何 user 才能切过去
```

这套两步显式流程对 admin 自己同样生效——没有环境变量短路通道。

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

Phase 10 移除了旧的"项目 cwd"心智模型。文件工具和 Bash 都锁在当前用户的私有 workspace：

```text
~/.lightclaw/workspaces/<canonical_user>/
```

`Read` / `Write` / `Edit` / `Glob` / `Grep` 在普通权限规则**之前**就把目标路径解析到 workspace 上做边界检查，越界直接 deny。该检查前置在 rule chain 之前，**`bypassPermissions` 模式无法绕过**。

`Bash` 的 `cwd` 锁到 workspace，并在 exec 之前拒绝以下形式：

- workspace 外的绝对路径，包括 IO 重定向（`cat </etc/x`、`echo >/tmp/y`）、管道（`cmd|/etc/x`）、命令分隔符（`cmd;/etc/x`、`cmd&/etc/x`）和子 shell 括号（`(/etc/x)`）引入的绝对路径
- `..` 相对路径逃逸
- 各种 tilde 展开形式：`~/foo`、`~user/...`、`~` 单独后跟空白或行尾
- `$HOME` / `${HOME}` 变量引用
- 没有显式 workspace 内路径的 `cd` / `pushd`

这仍然不是真正的进程沙箱。下面这些已知绕过类要等后续 phase 用真正容器隔离覆盖：

- `eval` 等间接字符串求值（`bash -c "$var"`）
- 通过变量插值隐藏绝对路径（`p=/etc; cat $p/passwd`）
- workspace 内放 symlink 指向外面

---

## 执行运行时（Runtime）

工具执行经过 `Runtime` 抽象层（`src/runtime/`）。启动时根据 `~/.lightclaw/config.json` 或 `LIGHTCLAW_RUNTIME_BACKEND` 选择 backend。

| Backend | 状态 | 行为 |
|---|---|---|
| `local`（默认）| 已交付（Phase 11 Iter 1）| `Bash` / `Grep` 走 host `/bin/bash -c`，`Read` / `Write` / `Edit` 走 host `fs.*`。无隔离，行为等同 Phase 10。 |
| `docker` | 未实现 | 后续会启动一个长跑 host 容器，把 workspace 绑定挂载，工具通过 `docker exec` 跑，`--cap-drop ALL` + 最小 cap 兜底。 |
| `rjob` | 未实现 | 后续会通过 `rjob`（kubebrain）提交集群任务，复用 gpfs 作为共享 workspace 挂载。 |

选了未实现的 backend 启动会显式报错——harness 永远不静默 fallback。

Runtime 抽象是面向未来的地基：加新 backend 只需在 `src/runtime/` 写一个文件，工具代码不动。文件操作经过 backend 的 `fs` 接口，但**所有当前 / 未来 backend 的 `fs` 都依赖共享挂载**让 host 进程直接读写 workspace inode，所以文件 ops 速度不变；真正进入容器边界的只有 `exec`。

```jsonc
{
  "runtime": {
    "backend": "local"
  }
}
```

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
| `LIGHTCLAW_RUNTIME_BACKEND` | 执行 runtime backend：`local`（默认），`docker` / `rjob` 未实现 |

---

## 贡献者地图

```text
src/
├── cli.ts              # 极简 CLI、auto-resume、channel auto-start
├── init.ts             # config + workspace-scoped state 初始化
├── init-wizard.ts      # 首次启动 admin 创建、终端 user 解析
├── repl.ts             # readline REPL + slash dispatch
├── query.ts            # 主 agent 循环（tool 派发、auto-compact）
├── prompt.ts           # system prompt 构造
├── state.ts            # 进程级 session state 单例
├── commands/           # /help、/model、/mode、/identity、/ceiling、channel dispatch
├── channels/           # 飞书 / 微信 runner、runner strategy、session lock
├── identity/           # canonical user、pairing、workspace、安全 JSON 状态
├── permission/         # mode/rule policy + workspace hard boundary
├── tools/              # 内置工具（Read、Write、Edit、Bash、Grep、Glob、…）
├── runtime/            # Runtime 抽象层；当前是 LocalRuntime，Docker / Rjob 待加
├── agents/             # general-purpose / explore 子 Agent
├── skill/              # loader、registry、内置 skill（verify、remember）
├── memory/             # LIGHTCLAW.md 发现与 user memory
├── session/            # 会话 JSONL transcript + meta + auto-compact
├── mcp/                # MCP Client
├── hooks/              # 生命周期 hook loader
├── web/                # WebFetch / WebSearch 辅助
├── todos/              # TodoWrite 存储
└── provider/           # Anthropic / OpenAI-compatible provider
```

## License

MIT
