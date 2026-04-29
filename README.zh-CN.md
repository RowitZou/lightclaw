# LightClaw

中文 · [English](./README.md)

LightClaw 是一个自托管的个人 AI 助手。它住在你的终端里，能在飞书 / 微信上和你对话，并跨 session 记住你告诉它的事情。一次安装，本机运行，不需要任何 SaaS 账号。

### 它能为你做什么

- **同一个助手，到处都能用。** 终端里和飞书 / 微信里是同一段对话、同一份记忆，不用切换工具。
- **让它真正动手做事。** 它会读写文件、跑 shell、抓网页、调你配的 MCP 工具——全在沙箱里，碰不到主机的其他部分。
- **危险操作用人话和你确认。** 模型想做不可逆的事时给你一个明确的"是 / 否"——也可以一次"批准这一类"，之后不用再问。
- **长任务不会越聊越糊涂。** 它记得你的项目惯例、纠正过的事、正在跑的任务；该用到的笔记会自动塞回上下文里——哪怕对话已经被自动压缩过几次。
- **模型与工具自带。** Anthropic 与 OpenAI 兼容的 API、MCP server、自定义 hook 都可以直接接。

架构、设计动机、开发历史都在另一个公开仓库 [项目 wiki](https://github.com/RowitZou/lightclaw_dev_log)。

---

## 快速开始

```bash
pnpm install
pnpm dev                 # tsx src/cli.ts —— 免构建，迭代最快
# 或者
pnpm build && pnpm start # 先 build 到 dist/cli.js 再 node 跑
```

需要 Node 22+、pnpm 10+ 和 Python 3。LocalRuntime 下 `WebFetch` 通过 environment helper 脚本执行，需要安装 `markdownify`：

```bash
python3 -m pip install --user markdownify
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
| `/help` | 看当前能用什么（模型、mode、skill、命令）。 |
| `/model <name>` | 切换当前 session 的模型。 |
| `/mode <mode>` | 切换权限严格度。 |
| `/permissions` | 查看、清空、追加 session 级权限规则。 |
| `/sandbox` | 查看或重置助手的沙箱工作环境。 |

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

飞书默认使用 `transport: "ws"`，不需要公网 webhook 入口。如果飞书应用的长连接事件没有开启加密，WS 模式可以不填 `encryptKey` / `verificationToken`；开启加密时需要填写 `encryptKey`，否则无法解密入站事件。`allowUsers` 和 `allowChats` 只有在对应列表非空时才检查；如果两个列表都为空，所有入站消息都会被丢弃。需要有意放开某一维度时使用 `["*"]`。

飞书默认走长连接（WS）transport，不需要公网 webhook。微信走 iLink 扫码登录。

助手想做需要确认的事时，会发一张三按钮卡片：

- **批准本次** —— 仅放行这一次。
- **批准这一类** —— 卡片标签会告诉你批准的范围（比如"任何 `pip install`"而不是"全部 Bash"），可以放心地放宽，但不会一次解锁整个工具。
- **拒绝** —— 直接拒绝，助手收到。

按钮不可用时，回复 `1` / `2` / `3` 也行。把 channel 设成 `bypassPermissions` 跑顺也没问题——再用 `permissions.json` 的 `ask` 列表把危险操作锁死即可（比如 `"ask": ["Bash(rm:*)"]`）。

---

## 沙箱

默认情况下，助手的工具——Bash、读写文件、抓网页——都跑在 Docker 容器里，不在你的主机上。模型乱来时也 `rm -rf` 不到你的 home，也可以放心把 bot 接给飞书上的朋友用，不等于给他们 shell。

容器你自己**不用管**：LightClaw 启动时会在后台拉公开镜像（`ghcr.io/rowitzou/lightclaw-sandbox`），还没拉完时工具调用会优雅降级到 chat-only——所以第一次对话不会卡死。镜像里自带日常工具（jq、sqlite、ripgrep、Python 数科栈、Node 22），开箱就能干活。

每个用户有自己的长跑容器。Workspace 文件跨容器重启保留；只有 writable layer（比如 `pip install` 的包）会被 `/sandbox reset` 清掉。

**单用户场景** —— 设 `runtime.backend: "local"` 减少开销。Local 模式只 admin 可用，channel 用户会被拒。

**自定义镜像 / 离网内网部署** —— 在 `~/.lightclaw/config.json` 里设 `runtime.docker.imageOverride` 指向你的 tag，重启 LightClaw 即可。

```jsonc
{
  "runtime": {
    "backend": "docker",
    "docker": {
      "memoryLimit": "4g",
      "cpuLimit": 4,
      "mounts": [
        { "host": "/data/datasets", "container": "/data", "mode": "ro" }
      ]
    }
  }
}
```

数据集 / 模型 checkpoint 推荐用 `mode: "ro"` 挂载——助手能读，但内核拒绝任何写入。完整配置见 [`info/env.md`](https://github.com/RowitZou/lightclaw_dev_log/blob/main/env.md)。

---

## 助手能用的能力

- **文件与 shell** —— `Read`、`Write`、`Edit`、`Glob`、`Grep`、`Bash`
- **Web** —— `WebFetch`（URL → 可读 Markdown）、`WebSearch`
- **任务跟踪** —— `TodoWrite`，做多步规划
- **子 Agent** —— 起并行的 `general-purpose` / `explore` 子助手做扇出工作
- **Skill** —— 内置若干小能力（`verify`、`remember`…），任务匹配时模型自动用，不需要手动调
- **MCP server** —— admin 配置的外部工具，模型以 `mcp__<server>__<tool>` 调用

以上所有调用都会走前面讲的同一套权限流。

---

## 记忆

LightClaw 帮你记三件事：

- **你的项目。** 把 `LIGHTCLAW.md` 放到仓库根，助手每次 session 都会读。`LIGHTCLAW.local.md` 用来放你不想 commit 的内容。
- **你这个人。** 它会逐渐攒起你的角色、偏好、纠正过的事——跨 session、跨渠道。下次开新对话时最相关的几条会自动回到上下文里，你不用反复自我介绍。
- **当前任务。** 长 session 内部维护一份"工作笔记"（在做什么、改了哪些文件、做过哪些决定、下一步是什么）。对话变长被自动压缩时，这些硬事实会先落盘——thread 不会被一压就断。

`LIGHTCLAW_NO_MEMORY=1` 全关。更细粒度开关见下方。

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
| `LIGHTCLAW_NO_MEMORY` / `LIGHTCLAW_NO_MCP` / `LIGHTCLAW_NO_HOOKS` | 整个子系统关掉 |
| `LIGHTCLAW_MEMORY_RECALL_*` / `LIGHTCLAW_SESSION_MEMORY_*` / `LIGHTCLAW_PRE_COMPACT_FLUSH_*` | 记忆相关的细粒度开关与阈值，详见 [`info/env.md`](https://github.com/RowitZou/lightclaw_dev_log/blob/main/env.md) |
| `LIGHTCLAW_PERMISSION_MODE` | 默认 permission mode |
| `LIGHTCLAW_RUNTIME_BACKEND` | 执行环境：`local`、`docker`（多用户场景默认）、未来的 `rjob` |
| `LIGHTCLAW_DOCKER_IMAGE` / `LIGHTCLAW_DOCKER_IDLE_TIMEOUT_MS` | 覆盖沙箱镜像 / idle stop 时间 |

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
├── commands/           # /help、/model、/mode、/sandbox、/identity、/ceiling、channel dispatch
├── channels/           # 飞书 / 微信 runner、runner strategy、session lock
├── identity/           # canonical user、pairing、workspace、安全 JSON 状态
├── permission/         # mode/rule policy 和 skill tool 边界
├── tools/              # 内置工具（Read、Write、Edit、Bash、Grep、Glob、…）
├── runtime/            # Runtime 抽象层；LocalRuntime、DockerRuntime、未来 Rjob
├── agents/             # general-purpose / explore 子 Agent
├── skill/              # loader、registry、内置 skill（verify、remember）
├── memory/             # LIGHTCLAW.md 发现与 user memory
├── session/            # 会话 JSONL transcript + meta + auto-compact
├── mcp/                # MCP Client
├── hooks/              # 生命周期 hook loader
├── todos/              # TodoWrite 存储
└── provider/           # Anthropic / OpenAI-compatible provider
scripts/
└── sandbox-helpers/    # 通过 Runtime 执行的 Python helper（WebFetch / WebSearch / Glob）
```

## License

MIT
