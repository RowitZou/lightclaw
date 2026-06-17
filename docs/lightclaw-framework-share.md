# LightClaw 框架与特色分享

## 1. 一句话定位

LightClaw 是一个自托管的个人 AI 助手守护进程。它不是单纯的终端 Coding Agent，而是把模型、工具、沙箱、记忆、权限和飞书等协作渠道组织成一个长期在线的 Agent Runtime。

更直白地说：

- Claude Code 更像一个强大的本地终端开发助手。
- Hermes 更像一个强调自我改进和长期学习的 Agent 研究框架。
- OpenClaw 更像一个多渠道、多扩展的个人 AI 网关。
- LightClaw 的重点是：在真实工作渠道里，让 Agent 安全、可审计、可长期运行地完成工作。

## 2. LightClaw 要解决的问题

日常使用 Agent 时，常见痛点不只是“模型会不会写代码”，还有：

- Agent 只能在终端里工作，离用户真实沟通场景较远。
- 文件、代码、飞书文档、表格、附件等上下文分散。
- 工具权限过大或过小，容易在安全和效率之间摇摆。
- 长任务、后台任务、群聊协作、用户中断之后的状态管理复杂。
- 上下文会变长，历史记忆和当前任务之间缺少清晰分层。
- 集群、容器、远程 worker 等执行环境很难和对话体验自然结合。

LightClaw 的目标不是只做一个更会写代码的 CLI，而是做一个可以嵌入工作流的 Agent 操作系统雏形：用户通过飞书或终端发起任务，Agent 在受控运行时里调用工具，所有关键行为被权限系统和审计系统约束，同时把记忆、会话、技能和后台任务长期沉淀下来。

## 3. 总体架构

LightClaw 可以拆成八层：

```text
用户入口
  - CLI / 管理终端
  - 飞书私聊、群聊、话题、附件、引用消息

渠道层
  - 消息接入
  - 附件物化
  - 卡片交互
  - 会话路由

身份与权限层
  - 用户配对
  - canonical user
  - mode / ceiling
  - 工具确认
  - 审计日志

Agent 编排层
  - query loop
  - prompt 构建
  - compact
  - hook
  - signal bus
  - dispatch / background task

工具层
  - 文件、Shell、搜索、网页
  - 飞书文档、表格、云空间
  - 记忆、技能、会话检索
  - MCP 与扩展工具

运行时层
  - local
  - docker
  - rlaunch
  - workspace / scratch / mount
  - 网络代理与 ACL

状态层
  - session transcript
  - memory
  - skill
  - todo
  - artifacts
  - audit

模型与 Provider 层
  - 多模型配置
  - role model routing
  - streaming
  - retry / error classification
```

核心特点是：渠道、权限、运行时和记忆不是外围插件，而是 Agent loop 的一部分。

## 4. 核心模块说明

| 模块 | 作用 | LightClaw 的设计重点 |
| --- | --- | --- |
| Channel | 接入用户消息 | 飞书和 CLI 都可以驱动同一套 Agent Runtime |
| Identity | 识别用户和权限边界 | 配对、canonical user、私聊审批、用户级资源隔离 |
| Permission | 控制工具调用风险 | mode、ceiling、一次性确认、持久授权、审计类型区分 |
| Query | Agent 主循环 | 接收消息、构建上下文、调用模型、执行工具、返回结果 |
| Prompt | 组织系统提示和工具面 | 角色、记忆、技能、工具目录、延迟工具暴露 |
| Tools | Agent 可执行能力 | Bash、文件、Web、Feishu、Memory、Dispatch、Skill 等 |
| Runtime | 工具实际执行环境 | local、docker、rlaunch，多路径挂载和安全边界 |
| Session | 会话持久化 | transcript、fork、compact、历史恢复 |
| Memory | 长期知识沉淀 | 用户记忆、共享记忆、角色私有记忆、自动提取 |
| Skill | 可复用操作知识 | bundled skill、用户 skill、角色可见性、Skill 工具 |
| Signal Bus | Agent 内部事件总线 | background task、wake、abort、progress、interjection |
| Feishu Workspace | 飞书文档和云空间 | 文档读写、表格读写、文件夹、移动、删除、权限审计 |

## 5. 一次请求的执行流程

1. 用户在飞书或 CLI 发送消息。
2. Channel 层解析消息来源、群聊上下文、引用消息、附件和用户身份。
3. Identity 层把平台用户映射到 canonical user。
4. Permission 层加载当前用户的 mode、ceiling、规则和审批状态。
5. Session 层选择或创建当前会话，恢复 transcript 和 compact 状态。
6. Prompt 层注入系统提示、工具目录、记忆、技能、角色信息和当前任务。
7. 模型开始流式输出，必要时调用工具。
8. 工具请求进入 Runtime，在 local、docker 或 rlaunch 中执行。
9. 高风险工具进入权限确认；确认结果写入审计日志。
10. 工具结果回到模型，模型继续推理或生成最终回复。
11. 会话、工具调用、审计、记忆候选和后台任务状态被持久化。

这个流程的关键不是“模型调用工具”本身，而是每一步都带着身份、权限、状态和运行时约束。

## 6. LightClaw 的特色

### 6.1 渠道原生，而不是终端外壳

LightClaw 从一开始就把飞书当成主要交互入口之一：

- 支持私聊、群聊、话题和引用消息。
- 支持附件进入 Agent 上下文。
- 支持飞书卡片做权限确认和交互。
- 支持用户在群聊里通过 mention 驱动 Agent。
- 支持 quoted message，让 Agent 知道用户回复的是哪条消息。

这让 Agent 可以直接进入团队协作场景，而不是要求用户把所有工作搬回终端。

### 6.2 权限系统是工作流的一部分

LightClaw 的权限不是简单的 yes/no，而是按风险分层：

- 普通读操作可以更宽松。
- 文档内部增删改查可以持久授权，方便批量编辑。
- 删除整篇文档、删除表格、移动或删除云空间文件属于高风险操作，需要更严格确认。
- 上传附件、远程 URL 下载、文件写入等操作有独立安全边界。
- 所有关键动作进入 audit 日志。

这样可以同时满足两个需求：低风险操作不要频繁打断用户，高风险操作不能被过度放行。

### 6.3 运行时适配真实工程环境

LightClaw 支持三类运行时：

| 运行时 | 使用场景 | 特点 |
| --- | --- | --- |
| local | 管理员本机、可信环境 | 快速、直接、权限最高 |
| docker | 本机隔离执行 | 适合普通工具调用和开发任务 |
| rlaunch | 集群或远程 worker | 适合共享存储、GPU、长任务和受控 worker |

当前设计里有三个重要平面：

- Control Plane：控制 worker 启停、状态和中断。
- Data Plane：文件、附件和大数据通过共享文件系统或 relay 传输。
- Path Policy：控制哪些宿主机路径可以映射到运行时。

这避免把大文件、PDF、模型产物等都塞进控制通道，也让集群环境里的路径挂载和权限边界更清晰。

### 6.4 飞书云文档是深度工具，不只是发消息

LightClaw 的飞书工具不只负责收发消息，还覆盖云文档工作流：

- `FeishuRead`：读取 doc、docx、wiki、sheet 等资源。
- `FeishuCreateFile`：创建飞书文档或表格。
- `FeishuWriteDoc`：追加、替换、插入、删除、更新文档块。
- `FeishuWriteSheet`：追加、覆盖、编辑表格数据。
- `FeishuList`：列出云空间目录。
- `FeishuCreateFolder`：创建文件夹。
- `FeishuMove`：移动云空间文件。
- `FeishuDelete`：删除云空间文件。

它的设计目标是让 Agent 能直接参与“写报告、改文档、维护表格、整理云空间”这些真实办公任务。

### 6.5 记忆不是单个文件，而是分层系统

LightClaw 的记忆分为多层：

- L1：用户私有记忆。
- L2：共享记忆。
- L3：角色私有记忆。

后台还有自动提取和整理机制，可以从会话里沉淀长期有价值的信息。这样做的好处是：

- 用户习惯可以长期保留。
- 团队共识可以进入共享层。
- 不同角色可以拥有不同的专业上下文。
- 子 Agent 的经验可以沉淀到对应角色里。

### 6.6 Dispatch 和后台任务

LightClaw 不只支持单 Agent 对话，还支持：

- 同步 Dispatch：让一个角色 Agent 处理明确子任务。
- Background Dispatch：长任务在后台运行，完成后通过信号回到主会话。
- Chain Dispatch：多个角色之间可以串联，但有深度、循环和权限保护。
- Signal Bus：统一处理 progress、abort、wake、background-result 等事件。

这让 LightClaw 更接近一个多 Agent 工作台，而不是单次问答工具。

### 6.7 技能机制面向长期复用

LightClaw 的 skill 机制借鉴了 Claude Code 的思路，但更强调用户隔离和角色可见性：

- bundled skill 放在代码仓库内，作为系统内置能力。
- 用户 skill 放在用户目录下，和 canonical user 绑定。
- skill 可以声明 allowed tools、触发说明和角色范围。
- `/skillify` 可以把当前会话中的经验整理成可复用 skill。
- ToolSearch 和延迟工具暴露减少 prompt 噪声。

相比只把 skill 当成 prompt 片段，LightClaw 更关注 skill 在多用户、多角色、多渠道环境里的加载边界。

## 7. 与 Claude Code、Hermes、OpenClaw 的对比

### 7.1 总览

| 维度 | LightClaw | Claude Code | Hermes Agent | OpenClaw |
| --- | --- | --- | --- | --- |
| 核心定位 | 自托管、渠道原生的个人 Agent Runtime | 终端里的 Coding Agent | 自我改进型通用 Agent 框架 | 多渠道个人 AI 网关 |
| 主要入口 | 飞书、CLI、后台任务 | Terminal / TUI | CLI、消息网关、Web/TUI | 多渠道消息、Web、Canvas |
| 重点用户场景 | 团队沟通、飞书文档、代码和集群任务 | 本地代码开发 | 长期学习、研究型 Agent、自动技能沉淀 | 多平台个人助手和插件生态 |
| 工具执行 | local、docker、rlaunch | 本地 shell 和工具 | local、docker、SSH、云沙箱等多后端 | 本地工具、插件、扩展 |
| 渠道能力 | 深度飞书集成 | 不作为重点 | 多消息渠道 | 多消息渠道很强 |
| 飞书云文档 | 深度支持读写和云空间 | 不作为重点 | 需要扩展 | OpenClaw 有较完整 Feishu 扩展 |
| 权限审计 | 强调确认、持久授权、风险分层和 audit | 终端交互确认为主 | 取决于工具和部署 | 扩展化权限机制 |
| 记忆系统 | 用户、共享、角色多层记忆 | 项目和会话上下文为主 | 记忆和自改进是核心 | 有长期助手记忆能力 |
| Skill | bundled + 用户 skill + 角色可见性 | skill 机制成熟，面向 CLI 工作流 | skills hub 和自我改进突出 | 通过扩展和 skill 支持 |
| 多 Agent | Dispatch、Background、Chain、Signal Bus | 以单 Agent 编程流为主 | 支持 delegate 和长期任务 | 支持 app/node/agent 扩展 |
| 集群适配 | rlaunch、GPFS、mount、网络代理 | 不作为重点 | 支持多种执行后端 | 取决于扩展 |
| 最适合 | 在飞书和工程环境中安全运行长期 Agent | 高效写代码、改仓库、跑命令 | 研究自进化 Agent 和长期学习 | 做跨平台个人 AI 网关 |

### 7.2 LightClaw vs Claude Code

Claude Code 的优势非常明确：它是成熟的终端 Coding Agent。

Claude Code 的特点：

- CLI/TUI 体验成熟。
- 面向代码仓库的上下文组织强。
- 工具调用、diff、文件编辑、命令执行体验好。
- skill 机制清晰，`skillify` 可以把经验沉淀成 `SKILL.md`。
- 对开发者来说学习成本低，直接在项目目录里工作。

LightClaw 借鉴了 Claude Code 的几个方向：

- skill 机制。
- compact 和上下文管理。
- 工具权限确认。
- 面向真实代码仓库的文件和 shell 工具。

但 LightClaw 的差异在于：

- LightClaw 不是只在终端里工作，而是把飞书作为一等入口。
- LightClaw 需要处理群聊、私聊、卡片、附件、引用消息、后台任务。
- LightClaw 的权限需要适配多用户和渠道场景。
- LightClaw 的运行时要覆盖 docker、rlaunch 和共享存储。
- LightClaw 的目标是长期在线，而不只是一次终端会话。

一句话概括：Claude Code 是更强的本地开发 CLI；LightClaw 是把 Coding Agent 能力嵌进工作渠道和运行时系统。

### 7.3 LightClaw vs Hermes Agent

Hermes Agent 的核心关键词是 self-improvement。

Hermes 的特点：

- 强调从使用经验中生成和改进 skills。
- 有长期记忆和 session search。
- 支持 cron、delegate、RPC tools。
- 支持多种 terminal backend，例如 local、Docker、SSH、Singularity、Modal、Daytona、Vercel Sandbox。
- 支持 Telegram、Discord、Slack、WhatsApp、Signal、Email 等消息入口。
- 更像一个面向研究和长期演化的 Agent 框架。

LightClaw 和 Hermes 的相似点：

- 都重视长期记忆。
- 都有 skill 和后台任务。
- 都支持不止一种执行环境。
- 都不满足于单轮对话。

LightClaw 的不同点：

- LightClaw 更强调飞书和企业办公场景。
- LightClaw 对飞书文档、表格、云空间做了更具体的工具化。
- LightClaw 的权限系统更贴近“聊天渠道里调用工具”的审批体验。
- LightClaw 的 rlaunch 设计更贴近当前集群和共享存储环境。

一句话概括：Hermes 更像自我改进 Agent 的研究平台；LightClaw 更像面向实际工作渠道落地的 Agent Runtime。

### 7.4 LightClaw vs OpenClaw

OpenClaw 和 LightClaw 在方向上最接近，都在做个人 AI 助手和多渠道入口。

OpenClaw 的特点：

- 多渠道支持广，包括 WhatsApp、Telegram、Slack、Discord、Google Chat、Signal、iMessage、飞书、微信、QQ 等。
- 插件和 extension 生态丰富。
- 支持 live Canvas、voice wake、apps、nodes、onboarding、cron 等能力。
- Feishu extension 里也有较完整的 doc、drive、permission、wiki、sheet 相关实现。
- 更像一个大而全的本地优先 AI assistant gateway。

LightClaw 从 OpenClaw 可以学习的地方：

- Feishu API 覆盖面。
- 扩展组织方式。
- 多渠道产品化体验。
- 文档、表格、云空间操作的完整度。

LightClaw 的不同点：

- LightClaw 更聚焦当前飞书和工程执行环境，没有追求一次性覆盖所有渠道。
- LightClaw 的 runtime、rlaunch、mount、GPFS、网络代理是核心能力。
- LightClaw 对权限审批、审计、用户配对、角色隔离做得更重。
- LightClaw 更强调“Agent 在受控环境里做事”的工程闭环。

一句话概括：OpenClaw 是多渠道和扩展生态更广的个人助手网关；LightClaw 是更聚焦飞书、权限和工程运行时的落地版本。

## 8. LightClaw 当前最值得强调的能力

### 8.1 从聊天到执行的闭环

用户不需要打开终端，也可以在飞书里让 Agent：

- 看附件。
- 读仓库。
- 查网页。
- 改代码。
- 写飞书文档。
- 更新表格。
- 启动后台任务。
- 调用子 Agent。

Agent 不只是“回复建议”，而是可以真正执行，并把执行结果回到同一个对话上下文。

### 8.2 可控的自动化

LightClaw 不是无边界自动化，而是有明确控制点：

- 哪个用户可以用。
- 当前 mode 是什么。
- 哪类工具可以自动执行。
- 哪类操作必须确认。
- 哪些路径可以挂载。
- 哪些飞书资源可以读写。
- 操作是否进入审计日志。

这使得它更适合真实团队环境。

### 8.3 长期在线的 Agent 状态

LightClaw 不把每次请求当成孤立任务：

- session 记录历史。
- compact 避免上下文爆炸。
- memory 保存长期信息。
- skill 保存可复用流程。
- background task 可以跨消息继续运行。
- wake 机制可以把后台状态重新带回用户面前。

这让 Agent 更接近一个长期协作对象。

### 8.4 面向大文件和复杂上下文

LightClaw 的工具链覆盖：

- PDF。
- Office 文档。
- 网页。
- 代码仓库。
- 飞书云文档。
- 飞书表格。
- 附件。
- 共享文件系统路径。

同时通过 spill、workspace、scratch、runtime path policy 等机制，避免所有内容都直接进入模型上下文。

## 9. 适合在分享中讲的三个例子

### 例子一：飞书群聊里改文档

1. 用户在群里 mention Agent。
2. 用户贴一个飞书文档链接。
3. Agent 使用 `FeishuRead` 读取完整文档结构。
4. 用户要求“把这一节改成周会汇报格式”。
5. Agent 调用 `FeishuWriteDoc` 修改文档内部 block。
6. 文档内部编辑可以按策略持久授权，删除整篇文档仍需严格确认。
7. 结果在飞书里返回。

这个例子体现渠道原生、飞书文档工具、权限分层。

### 例子二：rlaunch 挂载外部目录做任务

1. 用户通过 `/mount add` 挂载共享目录。
2. LightClaw 根据路径转换规则映射到 runtime。
3. rlaunch worker 重启后获得新的挂载视图。
4. Agent 在受控路径里读取数据或执行脚本。
5. `/mount list` 可以看到当前挂载和权限。

这个例子体现运行时、共享存储、动态挂载和安全边界。

### 例子三：把经验沉淀成 skill

1. 用户和 Agent 完成一套固定流程。
2. 用户调用 `/skillify`。
3. Agent 从最近会话里总结可复用步骤。
4. 用户确认后写入当前用户的 skill 目录。
5. 后续相似任务可以通过 Skill 工具加载。

这个例子体现长期复用和用户级技能隔离。

## 10. 当前设计取舍

LightClaw 没有追求所有方向都最强，而是做了几个明确取舍：

| 取舍 | 选择 | 原因 |
| --- | --- | --- |
| 入口 | 优先飞书和 CLI | 先把真实工作流跑通 |
| 执行 | 重视 runtime 和沙箱 | Agent 要能安全地做实际操作 |
| 权限 | 风险分层而不是全自动 | 团队环境需要可控自动化 |
| 记忆 | 多层记忆 | 区分用户、共享和角色上下文 |
| skill | 用户级和角色级可见性 | 避免多用户环境下经验串线 |
| Feishu | 深度文档和云空间能力 | 直接覆盖办公协作核心场景 |
| 多渠道 | 暂不追求最广 | 避免在基础运行时稳定前摊太开 |

## 11. 后续可以继续演进的方向

- 更完整的飞书文件类型支持，例如更多附件、图片、表格样式和评论能力。
- 更细粒度的文档 diff 和审批卡片。
- 更系统的 skill 自动推荐和用户确认流程。
- 更强的上下文预算可视化，帮助用户知道是什么撑爆了上下文。
- 更稳定的后台任务中断、wake 和恢复提示。
- 更多 runtime 后端和更清晰的路径映射策略。
- 独立的 dev log 或架构文档站，方便长期追踪设计变化。

## 12. 汇报时的推荐结构

可以按 20 分钟分享来讲：

| 时间 | 内容 |
| --- | --- |
| 2 分钟 | 为什么需要 LightClaw：Agent 要进入真实工作流 |
| 4 分钟 | 总体架构：渠道、权限、Agent loop、工具、运行时、状态 |
| 5 分钟 | 三个特色：飞书原生、运行时沙箱、权限审计 |
| 4 分钟 | 记忆、skill、dispatch 和后台任务 |
| 3 分钟 | 和 Claude Code、Hermes、OpenClaw 的对比 |
| 2 分钟 | 当前进展、设计取舍和下一步 |

## 13. 最后总结

LightClaw 的价值不在于“又做了一个 Agent CLI”，而在于把 Agent 放进真实协作系统里：

- 用户在飞书里发起任务。
- Agent 在受控 runtime 里执行。
- 工具调用有权限和审计。
- 文档、表格、代码、附件都可以进入工作流。
- 记忆、skill、dispatch 让能力可以长期沉淀。

相比 Claude Code，LightClaw 更重渠道和运行时。

相比 Hermes，LightClaw 更重飞书办公和工程落地。

相比 OpenClaw，LightClaw 更重权限、审计、rlaunch 和受控执行闭环。

这就是 LightClaw 当前最核心的特色：一个面向真实工作环境的、自托管、可控、可长期运行的 Agent Runtime。
