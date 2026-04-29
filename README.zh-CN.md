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
| `/help` | 显示当前 model/mode、可用 model/mode、skill 目录和命令。 |
| `/model <name>` | 切换当前 session 的模型。 |
| `/mode <mode>` | 在当前 ceiling 内切换 permission mode。 |
| `/sandbox reset` | 重置自己的 Docker sandbox：保留 workspace 文件，丢弃容器 writable layer。 |

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

Feishu channel 现在支持交互式权限审批。`default` / `acceptEdits` 模式下遇到需要确认的写入或执行类工具时，LightClaw 会发送飞书审批卡片；用户可以点“是”或“否”。如果卡片按钮不可用，也可以直接回复“是”/“否”作为文本 fallback，回复“取消”可以清掉卡住的待审批请求。按钮生效需要在飞书开发者后台启用机器人互动卡片能力，并在回调订阅里添加 `card.action.trigger`。其他非交互 channel 仍会在 ask 场景下拒绝工具调用；作为可信个人 bot 使用时，也可以把 channel baseline 配成 `bypassPermissions`，再用 identity pairing、allowlist、permission ceiling 和 workspace boundary 作为安全护栏。

---

## Runtime 边界

Phase 10 移除了旧的"项目 cwd"心智模型。文件工具和 Bash 都锁在当前用户的私有 workspace：

```text
~/.lightclaw/workspaces/<canonical_user>/
```

Phase 11 Iter 3 删除旧的路径字符串守卫层。安全边界按 runtime 拆分：

- `local` 是单用户、admin-only。已 pairing 的非 admin channel user 会在 runtime acquire 前被拒绝。
- `docker` 给每个 canonical user 一个隔离的长跑容器。workspace 挂到 `/workspace`，额外挂载可选 `rw` 或 `ro`。
- Permission mode 和规则仍然控制 tool 风险等级（`safe` / `write` / `execute`），但不再拿来模拟文件系统沙箱。

---

## 执行运行时（Runtime）

工具执行经过 `Runtime` 抽象层（`src/runtime/`）。启动时根据 `~/.lightclaw/config.json` 或 `LIGHTCLAW_RUNTIME_BACKEND` 选择 backend。

| Backend | 状态 | 行为 |
|---|---|---|
| `local`（默认）| 已交付（Phase 11 Iter 1-Redesign + Iter 3 闸门）| environment 视图退化在 host 上执行：`Bash` / `Grep` 走 `/bin/bash -c`，文件工具走 `runtime.fs`，Web 工具走 Python helper。没有真实隔离，仅 admin 可用。 |
| `docker` | 已交付（Phase 11 Iter 2）| environment-domain 工具在 per-user 长跑 Docker 容器内执行。用户 workspace bind mount 到 `/workspace`；helper 脚本在 `/opt/lightclaw/sandbox-helpers`；idle 容器会 stop，之后再 start，保留 writable layer。 |
| `rjob` | 未实现 | 后续会通过 `rjob`（kubebrain）提交集群任务，复用 gpfs 作为共享 workspace 挂载。 |

选了未实现的 backend 启动会显式报错——harness 永远不静默 fallback。

Runtime 抽象是面向未来的地基：加新 backend 只需在 `src/runtime/` 写一个文件，工具代码不动。Environment 工具通过 `runtime.exec` 和 `runtime.fs` 看到同一套运行时视图（`Bash`、`Grep`、`Read`、`Write`、`Edit`、`Glob`、`WebFetch`、`WebSearch`）。Host-domain 工具继续使用 LightClaw 受信状态（`Memory*`、`Conversation*`、`TodoWrite`、`AgentTool`、`UseSkill`、MCP）。

```jsonc
{
  "runtime": {
    "backend": "docker",
    "docker": {
      "image": "ghcr.io/rowitzou/lightclaw-sandbox:0.1.0",
      "idleTimeoutMs": 1800000,
      "memoryLimit": "4g",
      "cpuLimit": 4,
      "network": "bridge",
      "tmpfs": ["/tmp"],
      "mounts": [
        { "host": "${HOME}/.cache/pip", "container": "/root/.cache/pip", "mode": "rw" },
        { "host": "/data/datasets", "container": "/data", "mode": "ro" }
      ],
      "env": {
        "http_proxy": "http://127.0.0.1:1080",
        "https_proxy": "http://127.0.0.1:1080"
      },
      "autoPull": true
    }
  }
}
```

Docker backend 说明：

- 需要 Docker 20.10+，且当前用户必须有访问 Docker daemon 的权限。
- 默认镜像是 `ghcr.io/rowitzou/lightclaw-sandbox:<package.json version>`；也可用 `runtime.docker.image`、`runtime.docker.imageOverride` 或 `LIGHTCLAW_DOCKER_IMAGE` 覆盖。
- 一个 canonical user 对应一个容器，命名为 `lightclaw-sandbox-<user>-<deploymentHash>`，terminal / 飞书 / 微信共享同一 user 容器。
- 只读挂载使用 Docker 的 `:ro` bind 选项。内核会用 `EROFS` 拒绝该挂载内的写入、元数据修改、truncate 和删除，推荐给数据集 / 模型 checkpoint 使用。
- idle 回收走 `docker stop`，不是 `docker rm`：workspace 文件和容器 writable layer 会保留。`/sandbox reset` 才会删除容器，并在下次 environment tool call 时重建。
- Docker image 发布流水线在 `.github/workflows/sandbox-image.yml`；镜像包含 Debian 12 slim、常用 CLI（jq / yq / wget / unzip / vim-tiny / less / dnsutils / netcat / sqlite3）、ripgrep、git、curl、Python 3 + 数据科学 baseline（numpy / pandas / scipy / matplotlib / requests / httpx / pyyaml / pyarrow / tqdm / markdownify）、Node 22 LTS + pnpm、以及 sandbox helpers。

### Sandbox 镜像：开箱即用

当 `runtime.backend = "docker"` 时，LightClaw 启动时会**异步预拉取**镜像（不阻塞主进程），在镜像 ready 之前 environment 类工具会降级到 chat-only。常规用户**不需要**任何镜像相关配置。

| 场景 | 你做的事 | LightClaw 做的事 |
|---|---|---|
| 首次使用 docker | 设 `runtime.backend = "docker"` 后启动 | 后台 `docker pull ghcr.io/rowitzou/lightclaw-sandbox:<version>`；用户消息触发 environment 工具时返回"镜像准备中，可以聊天"的柔和提示，ready 后无缝接管 |
| 重启 LightClaw | 无 | `docker image inspect` 命中本地缓存 → tracker 立即 ready，零网络请求 |
| 本地 build 调试 | `docker build -t lightclaw-sandbox:dev .` 后设 `runtime.docker.imageOverride: "lightclaw-sandbox:dev"` | 用本地 tag，不发 pull |
| 内网 mirror / 离网 | 把 `lightclaw-sandbox:<version>` mirror 到内网 registry，设 `runtime.docker.imageOverride: "<mirror>/lightclaw-sandbox:<version>"` | 从 mirror 拉 |
| CI 临时覆盖 | `LIGHTCLAW_DOCKER_IMAGE=...` 环境变量 | 优先级最高，不写入 config |
| 自管镜像 | 设 `runtime.docker.autoPull: false` | LightClaw 只 inspect 不拉；本地无镜像时 agent 提示"管理员已禁用自动拉取" |

`/sandbox` 子命令：

- `/sandbox status` —— 查看 readiness 状态、镜像名、已拉时长、上次错误、当前容器名
- `/sandbox prefetch` —— state 为 failed / not-attempted 时强制重新拉取（修复代理 / 网络后用）
- `/sandbox reset` —— 删容器；下次 environment tool call 重建

**镜像 visibility**：上游 `ghcr.io/rowitzou/lightclaw-sandbox` 已发布为 public package。如果你 fork 仓库后用自己的 org 发布，需在仓库 Packages 设置里把 GHCR package visibility 改为 public（GitHub 没暴露 API）。改 `runtime.docker.image` 或 `imageOverride` 后**需要重启 LightClaw 进程**才生效——镜像就绪态在启动时绑定。

---

## Tool、Skill、MCP、Hooks

模型仍能使用 Phase 1-9 的 toolset：文件工具、Bash、Web、Memory、Conversation、TodoWrite、子 Agent、MCP tool 和 `UseSkill`。

每个 tool 都显式标记为 `environment` 或 `host`。新增 environment 工具时，文件系统、进程、glob 和任意网络副作用都必须经过 `context.runtime`；不要在工具实现里直接 import host `fs`、`child_process`、HTTP client 或 glob 库。

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
| `LIGHTCLAW_RUNTIME_BACKEND` | 执行 runtime backend：`local`（默认）、`docker` 或未来的 `rjob` |
| `LIGHTCLAW_DOCKER_IMAGE` | 覆盖 DockerRuntime 镜像 |
| `LIGHTCLAW_DOCKER_IDLE_TIMEOUT_MS` | 覆盖 DockerRuntime idle stop 时间 |

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
