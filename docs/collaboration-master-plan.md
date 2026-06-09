# LightClaw Multi-Agent 协作机制设计稿（讨论用）

> **这是一份处于设计阶段的提案,用来和协作者讨论方向,尚未实现、尚未排期。** 欢迎在这个分支上直接评论 / 提 PR。
>
> 目标一句话:**让每个 agent role 真正成为一个「员工」,而不是一个「工具」**。源头是一份早期的「Agent 间通信与可恢复协作机制」构想稿(下文称「原构想」),本稿是对它对照当前 LightClaw 架构做可行性核验、并把设计推到自洽后的结果。
>
> 直接动因:当前一个真实 bug —— **后台任务的「孤儿结果」**(后台 dispatch / Bash 后台执行完成后,结果有时投递不回任何活着的 agent),暴露出「把 agent 当函数调用」这一根因,值得单开一条主线治本。

---

## 一、北极星与一句话重构

**北极星**:agent role = 员工,不是工具。工具是「调用→返回→结束」;员工是「持续的身份 + 可观察的过程 + 能问能被指挥 + 能交接续做」。

但核验后做了一个关键重构 —— **「员工六件」(履历/可观察/上行/下行/交接/边界)是症状,不是原语。** 把它当六个 feature 去建,会得到一堆 bespoke 机制;要成为**框架**,必须找到所有协作形态(pipeline / fan-out / review loop / 长程监控)都能投影上去的那一小撮基元。它们坍缩成:

> **两个原语 + 一条已经做完的边界。**
>
> 1. **工单(TaskRun)= 一条 per-task 的 append-only 事件日志。** 进度 / 消息 / checkpoint / artifact 全是带 `kind` 的事件。→ 这一条给你 履历 + 可观察 + artifact。
> 2. **再唤醒规则(re-animation)= 某 agent 关心的事件落地 → 框架把它叫醒**(活着 → interjection drain;死了/下班 → 合成 turn / 重建)。→ 这一条给你 上行 + 下行 + 交接。
> 3. **边界 = 已完成。** `BLOCKED_WORKER_TOOLS`(worker 永不直接打扰用户)+ `reachableRoles`(无任意广播)+ 四类 audit,现有的角色体系里已是现状,几乎无需做。

**为什么这个重构重要**:LightClaw **早已为「单个 agent」造好了一台 actor + event-sourcing 引擎** —— append-only transcript = event sourcing;interjection queue = actor mailbox;background-result 合成 turn = actor activation;crash-resume = actor 重启。协作框架**不是要发明新东西,是把这台引擎从「单 agent」抬到「task」这一层**。行业谱系:durable execution(Temporal:状态是事件日志、worker 无状态、从日志 resume)× blackboard(共享协调对象、scope 收窄到 task)× actor model(信箱驱动激活)× 结构化并发 / OTP 监督树(生命周期 + 恢复)。我们不是开荒,是认领自己重复造过的轮子。

**「员工」隐喻保留,但 durability 的落点从「进程」挪到「工单」**:一个每天下班、靠书面交接续做的人,仍然是员工。员工的「履历 / 记忆 / 身份」活在持久的工单 + memory 层,不活在一个常驻进程里。这就是本稿的核心意象 —— **数字交接班**。

---

## 二、三条硬约束(定调,后续一切设计必须对齐)

原构想是 vision 高度,漏了决定一切的硬约束。核验补全为三条:

- **约束 A —— 只有 background 并发,blocking 没有 live parent。** blocking dispatch 是「你站着等他干完」,父此刻冻在 tool 里、不在跑。能被观察、被打断、能反向通信的只有 background。⇒ **协作机制主战场 = background dispatch**;blocking 退化为「无 live 交互的工单」(仍进 store,但只 2 写:起 + 止,见 §四)。**不引入新的 attached 模式**。

- **约束 B —— main 是 turn 驱动,不是常驻 daemon。** main 只在 user 入站 turn(或合成 turn)里活一个 turn,turn 之间不存在。⇒ **上行通信不能同步阻塞等待**(worker 挂着等一个可能永不上线的父 = 烧钱 + hang + 对抗 stream-idle watchdog)。正确形态是异步、store-mediated、靠唤醒回灌。

- **约束 C —— 唤醒 main 是贵的(原构想没提)。** main 是 orchestrator(通常是最贵的模型),一次合成 turn = 一次满 context 的往返。一个派 5 worker、每个 3 里程碑 + 1 提问的任务,天真实现 = 20 次 orchestrator turn 只为协调。⇒ **scheduler 必须 coalesce + threshold,绝不 per-event 唤醒 main**。原构想的「用户侧只看 milestone/blocker」过滤要**同时作用在 main 的再唤醒上**:routine 进度静默累积进日志(按需查),只有 `needsAttention/blocker` 即时叫醒,其余攒批。**安静是默认,吵闹要够格。** 这条是框架可负担性的承重墙。

**三个设计常量(勿误判为缺口)**:worker 永不直接打扰用户(边界,非缺口);不复活旧 transcript(此前已删,哲学一致);main 非常驻是设计(别为协作把它变 24/7 daemon);不做全局 artifact registry / blackboard(与「path-as-handle、无 sidecar registry」的现有立场冲突)。

---

## 三、用户视角:最终体验长什么样

一句话:**bot 从「派活之后就消失、最后甩个结果」变成「派活之后一直跟你保持联系的同事」。** 以「在集群上起个训练、盯着、挂了处理」这个长任务为例:

**今天**:你说「起个训练盯着点」→ bot「好的我来处理」→ 黑屏几小时 → 你问「到哪了」它自己也不知道(派出去的活看不见)→ 想中途改方向没法插手 → daemon 半夜重启,任务直接蒸发,你早上发现啥都没发生(这就是「孤儿结果」bug 的根)。

**目标**:
- bot 先确认拿不准的:「上次 8 卡、这次只剩 4 卡,用 4 卡还是等 8 卡?」(上行提问)
- 只在关键节点冒泡:「✅ 进队列」「✅ 开始训练,首个 checkpoint 正常」(可观察 + 节流)
- 你随时能问「现在咋样」→「6000 step,loss 1.2 还在降,约还要 3 小时」(进度可查)
- 你能中途改:「先停,换数据集再跑」→ bot 停掉、换、保留旧 checkpoint(下行控制)
- daemon 半夜重启 → 早上 bot:「昨晚重启过,我从上个 checkpoint 接着跑了,现在 14000 step」(续跑 / 交接班)

你能看到的就这五件事,全是「人类同事」该有的。底下那套工单 / 事件 / 唤醒全是实现,你只会看到上面这段对话。

---

## 四、核心模型:工单(TaskRun)

**工单 = bot 每派出一件活,就给这件活开一张「档案」**:记着这活干啥、什么状态、干到哪步、有没有人留言、产出文件在哪、谁在跑。前面那五件事 **没有这张档案一件都做不到**:你问「到哪了」要有地方查;worker 想提问、它下班了你没回,这条问题要存得住;你说「停」要有对象能停;崩了要接着跑要知道上次到哪。**工单不是花哨机制,就是「给每件委派出去的活配一张能查、能留言、能喊停、崩了还在的工单」。**

### 4.1 工单是一棵树(两级)

- **顶层一张**:对应用户的总目标。归 **main**。
- **底下若干子工单**:main 每派一次活,框架自动在顶层下挂一张子工单。归那个 **worker**。

这棵树**跟现有的 dispatch 链(chainState / DAG)同形**,只是给每个节点配了张持久档案。

### 4.2 发起 / 判完成 / scope

- **谁发起 —— 分两层**:子工单 **框架自动生成**(每次 Dispatch 顺手开,零仪式);顶层工单 **main 负责**,但不靠它额外调「建工单」工具 —— 自然触发是 main 判断「这是个多步/长程的活」(信号 = 它写了正经多步计划、或发起首个后台派发),框架就为这轮开顶层工单。一问一答的轻 turn 不开。

- **谁判完成 —— 分工干净**:每张**子**工单完没完是机械事实(worker 跑完返回 = 关闭,带成功/失败状态;**worker 返回 ≠ 成功**,可能报告失败);**整体目标**完没完是 **main 的判断**(看完所有子工单结果,决定还要不要补派/返工)。**worker 判「我这块停了」,main 判「整件事成了」。**

- **scope —— 各管一块,worker 不需要全局状态**(正是现有「worker 从全新 prompt 起步、不继承父对话」哲学落到工单上):
  - **worker 视野 = 它自己那张子工单**(目标 / 进度 / 自己工作区产物 / 发给它的留言)。窄。
  - **main 视野 = 整棵树**(顶层 + 所有子工单状态)。宽。**只有 main 看全局,这本就是 orchestrator 的职责。**
  - worker 不读兄弟工单、不读父的完整状态。**可见性跟着树走**:看自己节点,是 dispatcher 则看自己孩子的状态摘要,永远看不到兄弟内部。
  - B 要 A 的产出?**不是 B 读 A 的工单,而是 main 派 B 时把 A 的相关产出揉进 B 的任务说明**。**main 是唯一集成点**,worker 之间永远解耦(也是为何砍掉 sibling 直接消息)。理由:① 上下文卫生(别拿无关全局污染 worker context);② 跟人类组织一样,外包商只拿自己那份工作说明书。

### 4.3 工单由哪些部分组成

- **身份**:id / 父工单 / 归哪个 role
- **目标**:要干成什么(worker 的任务说明书)
- **状态**:queued / running / blocked / paused / done / failed / cancelled
- **进度日志**:一条只追加的事件流(开始、某步完成、卡住、产出文件、收发留言都往这记)
- **checkpoint**:最近一次「干到哪了 / 下一步」的快照 —— 崩了靠它重建(质量是关键,见 §七)
- **产物指针**:产出文件在工作区哪个路径(path-as-handle,无 registry)
- **谁在跑**:当前哪个 session 在执行,还是没人 —— **看门狗的命门**
- **唤醒源**(暂停时):在等谁(见 §六)

> 数据模型取向:**event-log-first,不要胖可变结构。** 每工单一份 `events.jsonl` + 派生 `meta.json`(status / 最新 checkpoint 指针),和现有 `transcript.jsonl + meta.json` 同构、天然 crash-safe。mailbox 不是独立字段(就是 `kind=message` 的事件),checkpoint 不是独立数组(就是 `kind=checkpoint` 的事件)。把进度/消息/checkpoint 拍进一个胖可变结构(多 writer:worker + main + scheduler 同写一份 JSON)会重演非原子写竞态,**否决**。

### 4.4 框架判「死活」,不判「进度」(关键澄清)

容易误以为「工单 = 框架维护的客观真相」。**不对 —— 要把「进度」和「死活」分开**:

- **进度(做到哪了、这块成没成)还是模型说了算。** 框架不可能独立知道「训练好不好」「bug 真修没」。**在内容/进度层,工单和 TodoWrite 一样都是模型自述,工单没有更客观。**
- **框架真正独占、不靠模型的是「死活」(liveness)**:此刻有没有活进程在跑这件活?到没到终态?多久没动静?—— 进程和 session 就是框架在管,这三件它闭眼也知道。
- **看门狗只吃「死活」,根本不碰「进度」**。它从不问「你真做到 80% 了吗」,只问「**此刻有没有人真在干、它标完成了没**」—— 答案 100% 在框架手里,跟模型嘴上说什么无关。所以**即便进度是模型自述,看门狗照样成立**。

**两类失败,工单能兜的不一样**:

| 失败类型 | 能否靠死活兜住 |
|---|---|
| **基建把活弄丢**(worker 崩 / daemon 重启 / 后台 fire 静默失败 / 孤儿结果) | **完全能。** 纯 liveness,跟模型判断无关,看门狗一抓一个准。孤儿结果、崩溃续跑全在此 |
| **模型自己放弃/误判**(以为做完其实没做、烂尾) | **不能完全靠框架。** 内容对错框架判不了,只能做**结构性矛盾检查**(如「标完成但名下还有未关子工单」)+ 兜底升级给用户。真要确认对错得让模型跑验证,那是动作不是框架判断 |

长程持续性的大头恰是第一类,那一类框架靠死活就客观兜底;第二类本就不是任何持久化机制能根治的。

### 4.5 工单 vs TodoWrite

两者表面都是「计划 + 勾完成」,但是两层:

| | TodoWrite | 工单(TaskRun) |
|---|---|---|
| 给谁看 | agent 自己(第一人称独白) | main / 用户 / 看门狗(第三人称档案) |
| 谁维护 | 模型自己写自己勾 | 框架维护(模型只往里喂事件) |
| 住在哪 | 埋在该 agent 的 transcript 里 | 独立落盘,在任何人对话之外 |
| 活多久 | agent 这轮结束/崩了就没 | 持久,比 agent 活得长 |
| 别人能动吗 | 不能(读不到) | 能查、能喊停、能改方向 |
| 「完成」是 | 模型勾个框(自述,会忘会漏) | 框架记录的生命周期事实 |

**为什么不是换个名字**:看门狗只能盯 context 外的东西;todo 埋在 transcript 里,框架靠它对账得解析别人的对话、且 agent 下班/崩溃 todo 就随 context 没了。一旦要求「持久 + 外部 + 别人能查 + 跨 agent」,这份计划就被挤出 transcript、必须搬新家 —— 那个家就是工单。**不是多造一个东西,是同一份计划换了「谁拥有、住在哪」。**

**二者是连起来的:todo 是源,工单是它的持久投影。** 模型继续用 todo 在脑子里规划(有用的思考草稿),框架把有意义的部分镜像到工单(勾掉一个 todo → 工单上一条进度;当前 todo 状态 → checkpoint 的素材)。**这条线已半通**:进度信号现在就是 TodoWrite 勾完触发的。**顶层工单 = 把 main 现有的 durable TodoWrite 计划从它脑子里搬到框架手里**,好让看门狗不必读 main 的对话就知道整件事完没完。

---

## 五、交流与生命周期(同一台机器的两面)

### 5.1 agent 之间怎么交流

**核心:agent 之间不直接对话。「交流」= 往工单写一条消息事件 + 框架把收件人叫醒去读。** 不是独立子系统,就是工单事件日志多一种类型 + 又一次唤醒。方向只有两个,沿树边走:

- **下行(main → worker,改方向/喊停)**:main 把消息写到 worker 工单。worker 还活着(后台并发)→ 下个工具边界 drain 进它的 interjection(管子现成);已下班/死了 → 没活人可发,**带新指令重新派一个**。
- **上行(worker → main,提问/求决策)**:worker 在自己工单写一条带 `needsAttention` 的问题。main turn 驱动、此刻不在线 → 框架**合成一个 turn 叫醒 main**(复用现有 background-result「事件叫醒 main」),main 决定、把答案写回下行。
- **横向(worker ↔ worker):不存在直连。** B 要 A 的产出 → main 派 B 时揉进任务说明,或 B 被动读工作区里 A 的文件。**main 是唯一交换机。** 工单树只有父子边、没兄弟边,这个形状本身强制了它。

**关键性质**:全异步,**没有任何 agent 阻塞等回复**(约束 B);传输全复用现成 signal bus,不新建通道。**只相邻父子通信、不跨孙**(下节会看到:这不只是整洁,它保证 wait 图无环,是死锁可判的前提)。

### 5.2 agent 怎么维持生命周期

反直觉但关键:**agent 不维持生命周期 —— 工单维持。agent 是故意「用完即弃」的。**

一个 agent 的「一生」是**一连串短班次**,不是一段连续存在。每班次:框架从工单(目标 + 最近 checkpoint + 必要 context)**实例化一个全新 agent** → 干到一个自然停点(完成 / 卡住 / 被打断 / 主动下班 / 崩溃)→ 在工单留 checkpoint → **死掉、进程没了** → 某触发(答案到了 / 看门狗 / 新 user 消息 / 子工单完成)再开**一个新班次** → 全新 agent 读工单接着干。**连续性活在工单的持久状态里,每班次重新注入一个干净 agent。这就是数字交接班。**

为什么「用完即弃」是优点:常驻进程空等 = 烧钱 + 对抗 idle watchdog + 怕崩;无状态 + 从持久态重建 = 闲时零进程、崩了只重建一次、每班次 context 干净。这正是此前删掉 transcript-resume 的哲学。

main / worker 区别只是程度:**main 现在就这样**(永不常驻,一触发一班次,班次间靠 durable plan / 工单 / memory 续);**worker 现在是「一次性单班」**,唯一新增的是让它能在同一工单上跑**多个班次**(下班→续做),变得跟 main 一样 episodic。触发班次的事件(user turn / 合成 turn / interjection / 看门狗)**全是已有或要复用的唤醒机制**。

### 5.3 二者统一

一条消息到达,**本身就是开启新班次的触发之一**。所以「怎么交流」和「怎么活」是同一个答案 —— 事件落在工单上,框架唤醒一个 agent 去处理。**说话 = 往工单写一条事件;活着 = 被唤醒去读事件。** 这就是 **actor 模型**:agent 就是「它的信箱 + 它的持久状态」,平时不占资源,有消息来活一下、处理完回到休眠。

> **工单(状态) + 事件日志(交流) + 唤醒规则(生命周期) = 一台机器的三个视角,不是三个机制。**

---

## 六、Liveness / 暂停 / 死锁协议(durability 的核心)

把「没完成又没人跑就叫醒」做对,需要一套分布式 liveness / 死锁检测协议(谱系:结构化并发 + OTP 监督 + wait-for 图死锁检测)。

### 6.1 结构化并发不变量(不变量 A,推广形态)

> **一张工单只要还有任何「未了的绑定义务」—— 未结的子工单、在跑的后台 bash、还会触发的定时任务 —— 就不能进终态。**

这就是结构化并发 / join barrier(Kotlin coroutine、Trio nursery、Swift task group:父作用域不结束直到子任务结束)。它顺手把「标完成但子工单没关」那个结构异常变成**构造上不可能**。注意:**它跟「暂停的合法唤醒源」是同一条件的两面** —— 工单不能结束 ⟺ 它还挂着至少一个唤醒源。

### 6.2 显式暂停 = typed await + 唤醒源

「没有 role 在跑」有歧义:可能是合法等待(等子工单 / 后台 bash / 定时任务 / 训练进展),也可能是崩了。消歧的标准解:**显式暂停状态,由 agent 自己设**(Temporal 那类「workflow 在 await 信号」vs「worker 死了」的区分)。

但**暂停不能只是个布尔标记,必须是「带等待对象的 typed await」**:

> **一个暂停,只有当它声明的「唤醒源」真实存在、且仍可能触发时,才合法。**

唤醒源 taxonomy:等某**子工单** join(合法 iff 该子工单存在且非终态,含「还没触发运行」)/ 等某**后台 bash**(iff 在跑)/ 等某**定时·cron** fire(iff 还会触发,**训练监控的不轮询关键 case** 落这:暂停并登记「30 分钟后叫我」,定时唤醒一次、看一眼、再睡,零轮询零烧 token)/ 等**父的下行回复**(不变量 B)/ 等**用户决策**(复用现有提问卡 / 审批卡,自带超时)。

**配套规则**:暂停**原子地写当下 checkpoint**(不写就挂起,挂起中被杀就从陈旧点恢复,不安全)。

### 6.3 搁浅 / 死锁检测(统一不变量)

§6.1 + §6.2 合成一条干净的检测条件,统一了那几个异常:

> **非终态工单,既没有活 agent 在跑、又没有一个合法唤醒源 → 搁浅/死锁 → 叫醒或升级。**

这覆盖了「没设 pause 却停」「全 pause 但没有绑定后台任务」「等的子工单其实已终态」等所有情形。这是经典 **wait-for 图死锁检测**,而 §5.1 的「只相邻父子通信」保证了 wait 图无环(树/DAG),正是死锁可判的前提 —— 局部性是承重的。

**实现要 level-triggered,不要 edge-triggered**:「子工单刚好在父设 pause 的瞬间完成」这种 lost-wakeup 竞态(条件变量经典坑),解法是 daemon 的对账扫描每次**从当前所有工单状态重新推导「它搁浅了吗」**,不依赖「接住那一下完成信号」。状态驱动、可重入(就是 K8s controller 的 reconcile)。看门狗跑**两处**:平时周期扫 + **每次启动时全量扫一遍所有非终态工单**(catch daemon 宕机期间漏的;现有的「启动时扫描残留 turn 续跑」是雏形)。

### 6.4 父总可唤醒(不变量 A 的推论 → bubble-up 退役)

现在系统里靠「找不到直接父就向上找活祖先、再不行兜底 main/DM」(spawner-aware delivery),**恰恰是因为今天没有持久的父** —— 父跑完就蒸发,没东西可唤醒。一旦上了不变量 A,父工单永远开着,框架**总能为它实例化一个 agent**(暖或冷)。**findability 和「暖不暖」是两回事**,所以 **bubble-up 在新设计里是死代码,可以删**,通信回归严格相邻父子。

精确尾巴:**「找得到」≠「唤醒便宜」。** 唤醒一个冷的父就为转交一条消息 = 一整轮 LLM。所以不靠「保持暖」省钱,而靠 **batching**(子发父的消息攒着,等父反正要跑时一次性给 —— 约束 C)。

### 6.5 不变量 B + 超时逃生阀

> **不变量 B:子 agent 在「发出上行消息后、收到下行回复前」,不能把工单设为完成。**

保证消息能送达。但**必须加超时**:父可能永远不回(父自己崩了 / 问题已作废)。超时 → 子带默认继续,或升级给用户(复用现有提问卡 / 审批卡的超时兜底那套)。否则子被永久钉死。

---

## 七、暖 session vs 冷重建(重建时机)

### 7.1 当初为何删 resume,在新设计下逐条对

| 当初删 resume 的理由 | 在新设计下还成立吗 |
|---|---|
| transcript 太长、context 爆 | **基本中和** —— 现有 auto-compact + turn 内压缩,暖 session 长了就压,不会无界涨 |
| 烂尾后难安全续 | **被显式 pause 中和** —— 从 agent 自己声明的干净挂起点续,比复活死在随机位置的 transcript 安全得多 |
| 工具状态 / repo 漂移 | **仍成立,且 gap 越长越严重** —— 唯一没被消掉的硬理由 |

结论:删 resume 的理由大半已被「工单 + 显式 pause + 成熟压缩」消掉,暖恢复今天比当初可行得多 —— 但还有两个物理现实绕不过。

### 7.2 物理现实

- **崩溃无条件杀掉内存里的 session。** 崩后手上只有盘上的东西,**崩溃这一类暖 session 物理上不存在**,只能从持久态重建,没得选。
- **provider 的 prompt cache 就几分钟 TTL。** 长暂停(训练几小时)后缓存早凉,「暖」恢复其实是「冷缓存回放整条 transcript」—— 省下的是 context、token 一分不少地重读、还背漂移风险。

⇒ 只在「短间隔、没崩」时 session 才真的暖;一旦跨崩溃或长暂停,暖就没了。

### 7.3 裁决:投资 checkpoint 质量,而非跨 gap 保暖

真痛点是「工单进度缺细节、新 session 要再盘一遍浪费轮数」。但**这不是「要暖 session」的论据,是「checkpoint 写得不够好」的论据。**

新 agent 重新盘,是因为 checkpoint 太薄。解法不是拖着整条 transcript(贵 + 漂移 + 把刚删的 resume 连毛病请回来),而是**把 checkpoint 写厚**:哪些文件关键、当前假设、已确认的关键发现、有哪些坑、下一步 —— 由 agent **在 pause 那刻、带完整 context 主动蒸馏**出来,是高质量交接,不是事后有损压缩。

> **厚 checkpoint + 冷重建 ≈ 暖 session 的收益(不重盘),却没有它的代价(无巨型 transcript 回放、无漂移、不把删掉的机制请回来)。** 这正是「数字交接班」比喻自己指向的:写一张好的交接条,不是交一整天的脑内日记。

**裁决三条**:
- **短/频繁 yield**:别杀 worker,保持 live(hot)。暖在这里真便宜真保真,现成机制(live worker + interjection)已能做。
- **跨崩溃 / 长暂停(超 TTL)**:暖在物理上没了,**默认从工单 + 厚 checkpoint 冷重建**;工程投入放在「让 checkpoint 够厚」。
- **整条 transcript 回放**:只留作个别「连续性极重要 + 间隔很短」场景的 opt-in,**不做默认**。

---

## 八、恢复状态机(两轴 + 有界重试 + 升级)

恢复策略 = 监督树 + restart strategy。

### 8.1 两根正交轴(别混)

「provider 挂了 → 新 session」是个陷阱:新 session 一样要调那个挂掉的 API,救不了。要分两根独立的轴:

- **轴 1:现在到底能不能跑一个 agent?**(provider / runtime 健康)
- **轴 2:要暖恢复还是冷重建?**(session 还新不新鲜)

**「provider 挂了」属于轴 1,跟暖/冷无关**,触发的是 §8.3 的退避 + 有界重试 + 升级,**不是冷重建**。轴 1 先答「能不能跑」,能跑了轴 2 再答「nudge 还是 rebuild」。

### 8.2 冷重建必带「对账提醒」

崩溃/长暂停冷重建时,**注入一条对账指令**(不是泛泛「可能丢了」):checkpoint 声称「我建了 X、正要改 Y」→ 重建的 agent 必须先核 X 在不在、Y 改没改,再往下走。**跨崩溃做不到 exactly-once,只能 at-least-once + 重建后对账**,这条提醒是对账入口。checkpoint 频率是个旋钮(写得勤→丢得少、对账便宜,但开销大)。

### 8.3 有界重试 = max-restart-intensity,不是「一次就判死」

唤醒本身会失败(API 没回来、runtime 不可用),必须有界 + 升级。但「重试一次不行就判死」太硬:**一个长任务一生会合法地暂停/恢复很多次**,用「一生总共 1 次」会误杀。正确判据是 OTP 的 **max-restart-intensity:单位时间窗内重启超 N 次**才算病态(如 5 分钟内崩 3 次)。病态的不是「恢复多」,是「短时间内反复恢复都推不动」。

**分两种失败、两个预算**(都升级给用户 DM,但报的话不同,且都带工单现状 —— 最近 checkpoint、当时等谁、什么失败,让用户能接手):

| 失败 | 现象 | 处理 |
|---|---|---|
| **基建挂**(轴 1) | 连 agent 都跑不起来 | 退避重试唤醒(间隔递增),超窗 → 升级「系统问题,恢复不了」 |
| **推不动**(轴 2 之后) | agent 能跑,但反复被唤醒却卡在同处 / 一恢复就又崩 | 窗内超 N 次 → 升级「任务卡在 X 步,推不动」 |

这个窗内预算把两个坑一起兜住:**毒 checkpoint / 毒任务的崩溃循环**(把「恢复后又崩」计进预算即可)、**daemon 宕机**(靠 §6.3 的启动全量扫描捞起所有搁浅工单)。

### 8.4 判定树

发现一张工单「非终态、没在推进」时,按序问:

1. **是合法暂停吗?**(声明了 pause + 唤醒源还活着)→ 是:啥都不做,正常等。否:往下。
2. **现在跑得起 agent 吗?**(provider/runtime 健康)→ **否:退避 + 有界重试唤醒,超窗升级「基建问题」**(别冷重建)。是:往下。
3. **老 session 还暖还新吗?**(进程还活 + gap < TTL)→ 暖:同 session nudge(便宜;最好在 end_turn 那刻边触发抓住「想结束但工单没到终态又没声明 pause」,看门狗 level-triggered 兜底)。冷(崩了 / 进程没了 / 暂停超 TTL):**冷重建 from 厚 checkpoint + 注入对账提醒**。
4. **(横切)每次恢复记进「窗内 N 次」预算**,超了停手,带 checkpoint + 诊断升级给用户。

---

## 九、与现状的复用映射

**大头是复用 —— 地基早为「单 agent」铺好,只是要抬到「task」层。agent 主循环的执行模型基本不动(Phase 0–2),只有 worker 级续跑(Phase 3)才碰一点,且复用 main 已有的复活骨架。**

| 你看到的能力 | 直接复用 | 改 / 新建 |
|---|---|---|
| 关键节点冒泡 | progress 信号 + forward-progress-to-channel + worker-activity-stream(已建约 6 成,只 TodoWrite 触发) | 扩成**通用 publishProgress**(start/step/blocked/artifact/heartbeat/done)+ 节流/升级策略 |
| 问「到哪了」 | `/status` 已画派发链树、router 已登记 in-flight | 从**持久工单**读(现在查内存,崩了没)+ `TaskInspect` 入口 |
| 工单档案本身 | bg-tasks 的 per-user 存储 + `transcript.jsonl + meta.json` 事件日志范式 | 把 bg-tasks **泛化成 TaskRun store**(覆盖 blocking 退化记录)。改造非重起 |
| 上行问 + 下行控 | 两端管子全现成:给活 worker 递消息 = interjection 队列 + tool-boundary drain;叫醒不在线的 main = background-result 合成 turn;Cancel/Update 工具壳在 | Cancel 补**真 abort**(现在只删记录);接「worker 问 → 叫醒 main → 回答 → 回灌」这条线(新 subscriber,两头现成);约束 C 的**唤醒批处理** |
| 崩了自己接着跑 | **最大资产**:crash-resume(启动扫描 + 残留 turn 续跑)已存在;「不复活 transcript、用持久态重建」已是既定哲学;query 重试 / transient-error 分类 / age·attempts 闸 | 现在只复活 **main**,抬到 **worker 级**;加 **checkpoint 结构** + **pause/唤醒源 typed-await 协议** + **看门狗 reconcile 循环** |
| 边界 | `BLOCKED_WORKER_TOOLS` / `reachableRoles` / 四类 audit | **不用动** |
| 传输 | signal bus(6 类信号) | **不新建,全映射上去** |

---

## 十、演进路线(Phase 0/1/2/3)

> 节奏锚定:每期 dogfood 出真信号再启动下一期(§十二)。

| Phase | 一句话 | 关键交付 | 触发 / 风险 |
|---|---|---|---|
| **0(现在,独立)** | 修「孤儿结果」 | Bash 后台执行接同一套 live-ancestor→main delivery 语义。**纯 signal-bus 层,不依赖 store** —— 从「统一 store」里**拆出来先修**,别把干净 bugfix 拖进投机重构 | 已坐实真 bug / **低** |
| **1** | durable 工单 + 可观察 | ① bg-tasks → 泛化 **TaskRun event-log store**(含 blocking 退化记录)② 通用 **publishProgress** ③ **TaskInspect** ④ 不变量 A(工单树完整性)⑤ 看门狗作为**检测器**(level-triggered reconcile + 启动全扫),逮搁浅 → 复用现有 crash-resume 唤醒 **main** / 升级给用户 | 真有「看不见 worker / 崩了丢活」痛点 / **低**(纯加法、不碰执行模型) |
| **2** | 下行控制 + 精确 liveness | ① redirect / cancel / pause **活着的** worker(复用 interjection)② `CancelDispatch` 真 abort ③ 约束 C 的 **main 唤醒批处理** ④ **显式 pause = typed await + 唤醒源**(让合法暂停不误触发看门狗) | 真有「中途改方向 / 训练监控不轮询」痛点 / **中**(碰边界不碰复活) |
| **3** | 上行问 + 交接续做 | ① **上行 ask + worker 级 checkpoint-resume 合成一个 feature**(ask 必须住这,见下)② 厚 checkpoint 冷重建 + 对账 ③ 完整恢复状态机(两轴 / 窗内预算 / 两失败) | 真有「长任务被打断 / 跨 session 续 / 崩溃恢复」痛点 / **高**(碰执行模型,复用 main 复活骨架) |

**为什么是这个顺序 —— 兼修一处自相矛盾**:原构想把「上行 ask」放 Phase 2、「checkpoint resume」放 Phase 3,但它自己又说「ask = resume 是同一台机器」。**这是自相矛盾**:因为老板(main)turn 驱动、随时不在线,「worker 问老板」天然依赖「worker 能下班再被叫回」—— **ask-parent 和 checkpoint-resume 是同一个 feature,必须同期**。所以本稿:Phase 2 只做**下行控制**(控制活 worker,复用 interjection,不需复活,易);**上行 ask 并入 Phase 3** 跟 resume 一起(难,需复活骨架)。Phase 0 先把「孤儿结果」这笔债独立还掉。Phase 1 纯加法、风险最低、且看门狗作「检测器」即可还掉大半 durability(逮孤儿/崩溃 → 唤醒 main / 升级),不必等 worker 级复活。

---

## 十一、与现有机制的边界

- **vs memory 层**:工单 / checkpoint = **进行中**任务的短期状态;memory = **沉淀后**的长期事实。连接点:后台 memory 整合(autoDream)消费工单 artifact / checkpoint,把稳定事实升级为 memory。**不要**让 checkpoint 重复 memory 职责,也不建第二个长期记忆。
- **vs skill composition(Dispatch 底座):结论是「不用协调」。** skill 系统的 composition 设计把 blocking Dispatch 当「带返回值的调用」用(子 context 当栈帧、finalText 当返回值)。本设计 **刻意不动 blocking 语义**(只给它加 2 写退化记录、不改 finalText 拼回),协作全建在 background 路径上、是 blocking 的超集。两者只在 Dispatch 工具壳上相交,而壳的 blocking 行为不变,故 skill composition **不受影响**。
- **vs signal bus**:bus 是传输层,工单是状态层。progress / message / control / abort 全映射到现有 signal kinds,不新增传输。
- **原构想里被否决/降级的点**:sibling 直接广播(被 main-集成点取代)、全局 blackboard 结构体(被 per-task artifact + memory 取代)、同步 `AgentWaitForMessage`(被异步唤醒取代)。

---

## 十二、立项 checklist(每期开工前走一遍)

1. 信号触发器真出现了?(对照 §十「触发」列;只是「未来可能有用」→ drop)
2. dogfood 真痛点 vs 这期设计目标对齐?
3. 与 §二 三硬约束(A/B/C)+ 两原语(§一)一致?
4. 是否依赖更前置的期?(看 §十「为什么是这个顺序」,尤其 ask=resume 同期)
5. 涉及 prompt 改动:独立成 PR 且开工前讨论;结构 refactor 必须 byte-identical 出 prompt。
6. 命名:对消费方用「requester / reader」措辞,避免「parent / 主 agent」字样;工具命名跟 Dispatch family。

走完才进详细工程设计,不是这份稿列了就一定做。
