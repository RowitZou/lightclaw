# LightClaw

中文 · [English](./README.md)

LightClaw 是一个自托管的个人 AI 助手。它住在你的终端里，能在飞书上和你对话，并跨 session 记住你告诉它的事情。一次安装，本机运行，不需要任何 SaaS 账号。

### 它能为你做什么

- **同一个助手，到处都能用。** 终端里和飞书里是同一段对话、同一份记忆，不用切换工具。
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

写一个最小的 `~/.lightclaw/config.json` 即可启动——完整模板见下方 [配置](#配置) 一节：

```jsonc
{
  "provider": "anthropic",
  "providerOptions": {
    "anthropic": {
      "apiKey": "<your-anthropic-api-key>"
    }
  },
  "model": "claude-sonnet-4-6"
}
```

首次交互式启动会创建 v1 单 admin 身份。之后终端启动会自动恢复当前用户最近一次 session。

如果不希望状态落在 `~/.lightclaw`（比如集群开发机销毁会一并丢掉 sessions / memory / identity），把 `LIGHTCLAW_HOME` 指到共享存储后再启动：

```bash
export LIGHTCLAW_HOME=<absolute-path-on-shared-storage>/lightclaw
```

也可以一次性 `lightclaw --home <path>` 临时切。具体迁移步骤见 [`info/env.md`](https://github.com/RowitZou/lightclaw_dev_log/blob/main/env.md)。

---

## 配置

所有配置都集中在 `<LIGHTCLAW_HOME>/config.json`（默认 `~/.lightclaw/config.json`）。完整带注释模板：

```jsonc
{
  // --- Provider 与模型 ---
  "provider": "anthropic",                      // "anthropic" | "openai"
  "providerOptions": {
    "anthropic": {
      "apiKey": "<your-anthropic-api-key>",
      "baseUrl": "<https://your-anthropic-endpoint>"   // 可选；不填走官方端点
    },
    "openai": {                                  // 仅当 provider="openai" 时需要
      "apiKey": "<your-openai-compatible-key>",
      "baseUrl": "<https://your-openai-compatible-endpoint>"
    }
  },
  "model": "claude-sonnet-4-6",                 // 默认模型；运行中可用 /model 切
  "allowedModels": ["claude-sonnet-4-6", "claude-opus-4-7"],   // 可选，限制 /model 的可选项

  // 可选 per-role 路由——未配置的字段回落到 "model"
  "routing": {
    "main":      "claude-sonnet-4-6",           // 主 agent 循环
    "compact":   "claude-haiku-4-5",            // auto-compact 摘要
    "extract":   "claude-haiku-4-5",            // memory 抽取 / micro-compact
    "webSearch": "claude-haiku-4-5"             // WebSearch helper 询问
  },

  // --- 工具相关 ---
  "tools": {
    "webSearch": {
      "braveApiKey": "<your-brave-search-api-key>"   // 可选；未配置回退 DDG HTML
    }
  },

  // --- 存储路径（全部可选）---
  // 默认走 <LIGHTCLAW_HOME>/{sessions,memory,workspaces}；只有需要把 workspace 单独放
  // 到大盘 / 共享存储 / 网络挂载时才覆盖。
  "sessionsDir":   "<absolute-path-for-sessions>",
  "memoryDir":     "<absolute-path-for-memory>",
  "workspaceRoot": "<absolute-path-for-workspaces>",

  // --- Runtime 后端（Bash / Read / Write 实际跑的地方）---
  "runtime": {
    "backend": "docker",                        // "local"（admin-only） | "docker" | "rlaunch"

    // 可选的进程内 forward proxy。docker host 模式 / 集群 pod 不能直连外网时启用。
    "network": {
      "mode": "host",                           // "host" 启动 bridge；"isolated" 关闭
      "upstream": "inherit",                    // "inherit" | "direct" | "<http://upstream-proxy:port>"
      "port": 18080,
      "bindHost": "0.0.0.0",
      "acl": ["127.0.0.0/8", "<your-pod-cidr>"]  // 来源 IP 白名单；空数组 = 只放行 loopback
    },

    // DockerRuntime —— backend = "docker" 时生效
    "docker": {
      "imageOverride": "<custom-sandbox-image>",      // 默认 ghcr.io/rowitzou/lightclaw-sandbox:<version>
      "memoryLimit": "4g",
      "cpuLimit": 4,
      "idleTimeoutMs": 1800000,                       // 容器闲置 30 分钟自动 stop
      "network": "bridge",
      "tmpfs": ["/tmp"],
      "mounts": [
        { "host": "/data/datasets", "container": "/data", "mode": "ro" }
      ],
      "env": { /* 注入到容器的静态 env */ },
      "autoPull": true
    },

    // RlaunchRuntime —— backend = "rlaunch" 时生效（集群部署）
    // 这些值由集群 admin 提供，LightClaw 不带默认。
    "rlaunch": {
      "image":            "<cluster-base-image>",
      "chargedGroup":     "<your-charged-group>",
      "namespace":        "<your-cluster-namespace>",
      "cpu":              8,
      "memoryMb":         16384,
      "gpu":              0,
      "privateMachine":   "group",
      "positiveTags":     [],
      "gpfsHostPrefix":   "<host-side-gpfs-mount>",   // 例：/mnt/shared-storage-user
      "gpfsMountPrefix":  "<gpfs-url-prefix>",        // 例：gpfs://gpfs1
      "imagePullPolicy":  "IfNotPresent",
      "maxWaitDuration":  "5m",
      "workerGcTimeHours": 24,
      "predictBeforeStart":   true,
      "healthCheckIntervalMs": 300000,
      "preheatOnStartup":     true,
      "preheatOnApproval":    true
    }
  }
}
```

所有字段都是可选的，用不到的整段删掉即可。环境变量（`ANTHROPIC_API_KEY`、`LIGHTCLAW_MODEL`、`LIGHTCLAW_RUNTIME_BACKEND` 等）会覆盖文件里的同名字段。完整 env 参考见 [`info/env.md`](https://github.com/RowitZou/lightclaw_dev_log/blob/main/env.md)。

同目录下的兄弟文件：

| 文件 | 用途 |
|---|---|
| `permissions.json` | 全局 allow/deny/ask 规则；与下面的 per-user 规则合并 |
| `identity/per-user/<canonical>/permissions.json` | 用户在飞书 / 终端点过的"以后都允许"自动落到这里，跨重启保留，无需手动维护 |
| `mcp.json` | MCP server 注册 |
| `channels.json` | 飞书等渠道配置 |
| `hooks/*.mjs` | 生命周期 hook |

带凭据的文件强制 `mode 0600`。

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
- 身份管理：`/user ...` slash
- 渠道：在 `~/.lightclaw/channels.json` 里 `enabled: true`，主 `lightclaw` 进程会自动拉起

---

## Slash 命令

普通用户可见：

| 命令 | 作用 |
|---|---|
| `/help` | 列出可用命令（不含状态信息；状态请用 `/status`）。 |
| `/status` | 查看当前 user / mode / model / session / 今日用量。 |
| `/model <name>` | 切换当前 session 的模型。 |
| `/mode <mode>` | 切换权限严格度。 |
| `/rules` | 列编号规则、按编号撤销，或注册 ASK 规则（详见下文）。 |
| `/sandbox` | 查看或重置助手的沙箱工作环境。 |

Admin 专属：

| 命令 | 作用 |
|---|---|
| `/user list|pending|approve|reject|unlink|remove|feedback` | 管理 pairing、用户绑定，并查看 user 反馈。 |
| `/ceiling [<user> <read|ask|auto|yolo>]` | 不带参数列出所有 identity 的 ceiling；带参数设置单个用户。 |
| `/cost` | 本月 token 用量（按 model + 按 user 聚合，含 cache 命中和 fresh 子项）。 |
| `/feedback <text>`（user-only）| 给 admin 留反馈；admin 用 `/user feedback` 阅读。 |
| `/fresh <prompt>` | 临时一次性会话 — 不读 memory、不写 transcript。 |
| `/stop` | 中断当前 turn（已写入的文件不回滚）。 |

Channel 中以 `/` 开头的消息也会先走本地 slash 派发，所以 admin 可以在自己的飞书里审批 pairing code。

### 权限模式与 ceiling

四个 permission mode，从严到宽。channel / 用户面用 **alias** 列；**internal enum** 列是 `permissions.json` 里的原始 schema 值，作为兼容老脚本的输入也接受。

| Alias | 内部 enum | 不询问就能跑的工具 |
|---|---|---|
| `read` | `plan` | 读取和搜索类工具。写入、编辑、执行、网络抓取、子 Agent 全部拒绝。 |
| `ask` | `default` | 读取和搜索类工具。写入、编辑、执行、网络抓取、子 Agent 在交互模式下询问，非交互模式直接拒绝。 |
| `auto` | `acceptEdits` | 读取、搜索、写入、编辑类工具。执行、网络抓取、子 Agent 仍询问。 |
| `yolo` | `bypassPermissions` | 全部自动放行。 |

`/mode <m>` 仅当 `m` 不超过当前 ceiling 的宽松度时才生效。默认 ceiling 是 `ask`（即 `default`），用户可以主动切到更安全的 `read`（即 `plan`）或留在 `ask`。如果想用更宽松的模式，admin 必须先抬升 ceiling：

```text
/ceiling alice yolo            # admin: 抬升 alice 的 ceiling
/mode yolo                     # 然后 alice（或 admin 自己）才能切过去
```

输入两种形式（alias / 内部 enum）都接受；输出（status 面板、飞书卡片、ceiling 列表）一律渲染 alias。

这套两步显式流程对 admin 自己同样生效——没有环境变量短路通道。

---

## 身份与渠道

未知飞书 sender 会收到 pairing code。Admin 审批：

```text
/user approve K7YQ3RPA --as alice
```

每个 canonical user 都有：

- user-scoped memory：`~/.lightclaw/memory/<user>/`
- 带 `userId` 的 session meta
- `feishu-alice` 这类 channel session
- 私有 workspace：`~/.lightclaw/workspaces/<user>/`

渠道配置在 `~/.lightclaw/channels.json`。需要自动启动的渠道设置 `enabled: true`。

飞书默认使用 `transport: "ws"`，不需要公网 webhook 入口。如果飞书应用的长连接事件没有开启加密，WS 模式可以不填 `encryptKey` / `verificationToken`；开启加密时需要填写 `encryptKey`，否则无法解密入站事件。`allowUsers` 和 `allowChats` 只有在对应列表非空时才检查；如果两个列表都为空，所有入站消息都会被丢弃。需要有意放开某一维度时使用 `["*"]`。

助手想做需要确认的事时，会发一张三按钮卡片：

- **批准本次** —— 仅放行这一次。
- **批准这一类** —— 卡片标签会告诉你批准的范围（比如"任何 `pip install`"而不是"全部 Bash"），可以放心地放宽，但不会一次解锁整个工具。这个决定会**持久化**到 `<LIGHTCLAW_HOME>/identity/per-user/<canonical>/permissions.json`，跨进程重启保留；并发的 subagent 同类调用安装规则后会被静默放行，不会再弹一遍。
- **拒绝** —— 直接拒绝，助手收到。

对于高危操作（`Bash(rm/sudo/dd/sh/eval/...)`、`/etc` / `/usr` / `~/.ssh` / `~/.aws` 等敏感路径下的 Edit），中间的"批准这一类"按钮会**自动隐藏**——`cd /tmp && rm -rf foo` 这种链式命令也算高危，并且对老卡片回复 `2` / "批准所有"会被自动降级为 allow-once。所以飞书上手滑一下不可能把 `rm -rf` 永久放行。

按钮不可用时，回复 `1` / `2` / `3` 也行。把 channel 设成 `bypassPermissions` 跑顺也没问题——再用 `permissions.json` 的 `ask` 列表把危险操作锁死即可（比如 `"ask": ["Bash(rm:*)"]`）；`ask` 优先级高于 `allow`，bypass 模式下也照样弹卡。

---

## 沙箱

默认情况下，助手的工具——Bash、读写文件、抓网页——都跑在**沙箱**里，不在你的主机上。模型乱来时 `rm -rf` 不到你的 home，也可以放心把 bot 接给飞书上的朋友用，不等于给他们 shell。

通过 `runtime.backend` 选三种 backend：

| Backend | 适用场景 | 备注 |
|---|---|---|
| `local` | 单人终端、不接飞书。 | 只 admin 可用；接飞书的 channel user 会被拒——没有真实隔离。 |
| `docker` | 普通 Linux 主机上的多用户个人 bot。 | 每用户长跑容器，公开镜像 `ghcr.io/rowitzou/lightclaw-sandbox` lazy 拉取，闲置容器自动 stop。Workspace 文件跨重启保留；`/sandbox reset` 重建 writable layer。 |
| `rlaunch` | 集群部署（kubebrain）。 | 每用户长跑集群 worker，gpfs workspace 挂到 `/workspace`；不做 idle stop，被 GC 后由 health checker 自动重建。 |

Docker 镜像自带日常工具（jq、sqlite、ripgrep、Python 数科栈、Node 22）。LightClaw 启动时会在后台拉镜像，没拉完时工具调用优雅降级到 chat-only——第一次对话不会卡死。

需要自定义 / 内网镜像，设 `runtime.docker.imageOverride`（或集群场景的 `runtime.rlaunch.image`）后重启 LightClaw。数据集 / 模型 checkpoint 推荐 `mode: "ro"` 挂载——内核拒绝写入。

**网络 bridge.** 沙箱直连不到外网时（docker host networking、集群 pod 在 NAT 后面），设 `runtime.network.mode: "host"`。LightClaw 会在指定端口起一个进程内 forward proxy，并往容器 / pod 里注入 `http_proxy`。`upstream` 控制转发到哪里（`inherit` 继承 shell、`direct` 直连、或固定的代理 URL）；`acl` 是**来源 IP 白名单**，避免 bridge 被当成开放代理白嫖——集群部署务必加自家 pod CIDR（kubebrain 用 RFC 6598 `100.64.0.0/10`）。完整 schema 见上面的 [`配置`](#配置) 一节。

完整配置参考见 [`info/env.md`](https://github.com/RowitZou/lightclaw_dev_log/blob/main/env.md)。

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

常用环境变量（覆盖 `config.json` 同名字段）：

| 变量 | 用途 |
|---|---|
| `LIGHTCLAW_HOME` | 所有 LightClaw 状态的根（默认 `~/.lightclaw`）。集群部署改到共享存储 |
| `LIGHTCLAW_SESSIONS_DIR` / `LIGHTCLAW_MEMORY_DIR` / `LIGHTCLAW_WORKSPACE_ROOT` | 在 `LIGHTCLAW_HOME` 之外单独覆盖某个子目录 |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` | Anthropic 凭据 |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` | OpenAI-compatible 凭据 |
| `LIGHTCLAW_PROVIDER` | `anthropic` 或 `openai` |
| `LIGHTCLAW_MODEL` | 默认模型 |
| `LIGHTCLAW_ALLOWED_MODELS` | `/model` 可选模型列表，逗号分隔 |
| `BRAVE_SEARCH_API_KEY` | WebSearch Brave key（覆盖 `tools.webSearch.braveApiKey`）；不配走 DDG HTML |
| `LIGHTCLAW_NO_MEMORY` / `LIGHTCLAW_NO_MCP` / `LIGHTCLAW_NO_HOOKS` | 整个子系统关掉 |
| `LIGHTCLAW_MEMORY_RECALL_*` / `LIGHTCLAW_SESSION_MEMORY_*` / `LIGHTCLAW_PRE_COMPACT_FLUSH_*` | 记忆相关的细粒度开关与阈值，详见 [`info/env.md`](https://github.com/RowitZou/lightclaw_dev_log/blob/main/env.md) |
| `LIGHTCLAW_PERMISSION_MODE` | 默认 permission mode |
| `LIGHTCLAW_RUNTIME_BACKEND` | 执行环境：`local`、`docker`、`rlaunch`（集群） |
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
├── commands/           # /help、/status、/model、/mode、/rules、/sandbox、/user、/ceiling、channel dispatch
├── channels/           # 飞书 runner、runner strategy、session lock
├── identity/           # canonical user、pairing、workspace、安全 JSON 状态
├── permission/         # mode/rule policy 和 skill tool 边界
├── tools/              # 内置工具（Read、Write、Edit、Bash、Grep、Glob、…）
├── runtime/            # Runtime 抽象层；LocalRuntime、DockerRuntime、RlaunchRuntime + NetworkBridge
├── agents/             # general-purpose / explore 子 Agent + forked-agent runner（复用父 prefix 命中 prompt cache）
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
