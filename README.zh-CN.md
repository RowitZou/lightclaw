# LightClaw

中文 · [English](./README.md)

LightClaw 是一个**自托管的多用户 AI Agent**。它作为常驻 daemon 跑在你自己的机器（或集群）上，通过飞书和你（以及你授权的人）对话，能读写文件、跑命令、抓网页、操作飞书云文档——全部在沙箱里完成。它跨 session 记住你的项目惯例、纠正过的事和正在跑的任务。一次部署，本机运行，不依赖任何 SaaS。

---

## 特性

<table>
<tr><td><b>飞书原生</b></td><td>私聊 / 群 / 话题里 @ 它就能对话，每个会话维度独立隔离。执行过程渲染成原地更新的卡片（每轮一张过程卡 + 每个任务一张全程任务面板），不刷屏，消息流保持纯对话；终端是纯 slash 的 admin 控制台，不跑 agent。</td></tr>
<tr><td><b>真正动手</b></td><td>读写文件、跑 shell（前台 + 后台长任务）、抓网页、读 PDF / Office、操作飞书云文档——全在沙箱里完成。</td></tr>
<tr><td><b>多用户 + 权限</b></td><td>admin 配对用户，每人独立 workspace / 记忆 / 规则；四档权限模式 + 人话确认卡 + per-user 上限。</td></tr>
<tr><td><b>沙箱隔离</b></td><td>工具默认跑在本地 / Docker / 集群（rlaunch）沙箱里，碰不到主机其它部分——接给别人用不等于给他们 shell。</td></tr>
<tr><td><b>长任务记忆</b></td><td>跨 session 记住你、你的项目、当前任务；自动压缩前先落盘，后台周期把散乱记忆整合成主题知识。</td></tr>
<tr><td><b>多 Agent 协作</b></td><td>主 agent 是管理者：把活派给专门子 agent（编码 / 调研 / 飞书 / 复审…），可并行扇出、后台跑、定时触发。每次派活都是一张可持久的<b>工单（task run）</b>——daemon 重启不丢、可挂起等唤醒、卡住有 watchdog 拉起。</td></tr>
<tr><td><b>模型灵活</b></td><td>同时接 Anthropic / OpenAI 兼容 / Codex OAuth，按角色钉不同模型（主对话走 Claude、记忆抽取走小模型）。</td></tr>
<tr><td><b>可扩展</b></td><td>MCP server、生命周期 hook、admin 自定义角色、自然语言触发的 skill。</td></tr>
</table>

---

## 快速开始

需要 Node 22+、pnpm 10+、Python 3。

```bash
pnpm install
pnpm dev                  # tsx src/cli.ts —— 免构建，迭代最快
# 或 pnpm build && pnpm start
```

写一个最小的 `~/.lightclaw/config.json` 即可启动（只有 `endpoints` / `models` / `defaultModel` 必填）：

```json
{
  "endpoints": { "anthropic-direct": { "apiKey": "<your-api-key>" } },
  "models": {
    "claude-sonnet-4-6": {
      "endpoint": "anthropic-direct", "schema": "anthropic", "upstreamModel": "claude-sonnet-4-6"
    }
  },
  "defaultModel": "claude-sonnet-4-6"
}
```

首次启动创建单 admin 身份并绑定当前终端用户，然后拉起 daemon。要让 agent 能对话，再配一段飞书并 `enabled: true`（见 [飞书接入](#飞书接入)）。

> 想把数据放到共享存储（集群部署、避免开发机销毁丢数据），启动前 `export LIGHTCLAW_HOME=<path>`。

---

## 配置

所有配置集中在 `<LIGHTCLAW_HOME>/config.json`（默认 `~/.lightclaw/config.json`）。**完整的可配置项与每一项默认值见 [`config.example.jsonc`](./config.example.jsonc)**——除上面三个必填项外其余全部可选，环境变量优先级高于文件。运行时是纯 `JSON.parse`，拷字段时记得删掉注释。

同目录兄弟文件：`permissions.json`（权限规则）、`mcp.json`（MCP server）、`hooks/*.mjs`（hook）、`roles/<name>/ROLE.md`（自定义角色）。

---

## 使用

```bash
lightclaw                 # 拉起 daemon：启用的 channel + 终端 admin 控制台
lightclaw --home <dir>    # 临时切 home    lightclaw --config <file>  # 外部只读配置
```

终端不跑 agent——和 agent 对话走飞书。常用 slash（终端与飞书共用，`admin` / `飞书` 标注例外）：

| 命令 | 说明 |
|---|---|
| `/help` `/status` | 命令列表 / 当前 user·mode·model·用量 |
| `/model` `/mode` | 切模型 / 切权限严格度 |
| `/rules` | 看 / 撤 / 加权限规则 |
| `/stop` `(飞书)` | 中断当前会话的 turn |
| `/secret` `/mount` `(飞书)` | 个人密钥 / 动态 gpfs 挂载 |
| `/feedback` | 给 admin 留反馈 |
| `/user` `/ceiling` `/cost` `/sandbox` `/feishu-workspace` `/auth` `(admin)` | 配对、权限上限、用量、沙箱、云空间、Codex 登录 |

**权限**：四档从严到宽 `read` / `ask` / `auto` / `yolo`，危险操作弹卡确认。`/mode` 不能超过 admin 给的上限（`/ceiling <user> <mode>`）。即便 `yolo` 也能用 `permissions.json` 的 `ask` 列表锁死指定操作（如 `"ask": ["Bash(rm:*)"]`）。

---

## 沙箱

工具默认在沙箱里跑，`runtime.backend` 选后端：

| Backend | 适用 | 备注 |
|---|---|---|
| `local` | 只服务你自己 | admin 照常走飞书对话，但配对的其他用户会被拒（本地无隔离）|
| `docker` | 普通主机多用户 bot | 每用户长跑容器，公开镜像 lazy 拉取，闲置自动 stop |
| `rlaunch` | 集群（kubebrain）| 每用户长跑集群 worker，gpfs 挂到 `/workspace` |

沙箱直连不到外网时（docker host 网络 / 集群 pod 在 NAT 后），设 `runtime.network.mode: "host"` 起进程内 forward proxy。镜像内置、网络与加固字段全在 [`config.example.jsonc`](./config.example.jsonc) 的 `runtime` 段。

---

## 飞书接入

在 `config.json` 的 `channels.feishu` 段配置并设 `enabled: true`。默认 `transport: "ws"`（长连接，**无需公网入口**）。

> `allowUsers` / `allowChats` 两个都为空会丢弃所有入站消息；放开某维度用 `["*"]`。

未知 sender 会收到配对码，admin 用 `/user approve <code> --as <name>` 审批，之后该用户拥有独立 workspace / 记忆 / 规则。助手做需确认的事时发三按钮卡片（批准本次 / 批准这一类 / 拒绝），高危操作不允许「批准这一类」永久放行。

<details>
<summary>自托管所需的飞书开放平台权限与事件</summary>

权限管理（机器人 tenant access token）：

- `im:message` / `im:message:readonly` / `im:resource` / `im:message.reaction:write` / `im:file` — 收发消息、读引用、下载附件、思考中表情、推文件
- `contact:user.base:readonly` — 解析发送者昵称
- `docs:document(:readonly)` / `sheets:spreadsheet(:readonly)` / `wiki:wiki:readonly` — 读写飞书文档 / 表格 / 知识库链接
- `drive:drive` — 授权请求者、管理云空间

事件订阅：`im.message.receive_v1`、`im.message.recalled_v1`、`card.action.trigger`。

> 改完权限或事件后必须在后台**重新发布应用版本**才生效。

</details>

---

## 记忆

LightClaw 帮你记三件事：**你的项目**（仓库根放 `LIGHTCLAW.md` 每次都读，`LIGHTCLAW.local.md` 放不 commit 的）、**你这个人**（跨 session 攒角色 / 偏好 / 纠正过的事，开新对话自动回最相关的几条）、**当前任务**（长 session 维护工作笔记，压缩前先落盘）。`LIGHTCLAW_NO_MEMORY=1` 一键全关。

---

## 设计文档

- [Multi-Agent 协作机制设计](./docs/collaboration-master-plan.md) —— 「派活」不是一次性 RPC，而是可持久、可观察、可续跑的**工单（task run）**：agent 是*员工*不是*函数*。已在 v0.3.0 落地：落盘工单账本、交付/验收结算、watchdog + 升级、声明式唤醒的挂起/续跑、飞书实时任务面板都出自这份设计。

---

## License

MIT
