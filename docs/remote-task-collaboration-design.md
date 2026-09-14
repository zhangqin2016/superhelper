# 远程任务协作：设计与实施规格

## 产品目标

用户从现有任务发起协助，指定好友或 Team 成员；接收方在独立的本地工作空间中处理，提交不可变的成果版本；发起方验收后预览差异、检查冲突并应用。IM 是入口和讨论场所，不是任务状态的权威数据库。第一版一名负责人；多人通过拆分协作子任务参与。双方均可离线保存工作，提交和审批必须获得服务器确认。

## 非目标与诚实边界

不做远程桌面、共享文件系统或实时多人编辑。不复制原会话进程、运行凭据或完整推理记录。不自动运行接收的脚本或定时任务。已经下载到他人设备的材料无法保证远程删除。模型负责整理任务上下文、解释差异；权限、哈希、重试、路径校验和状态迁移由确定性代码执行。

## 用户流程

1. 任务菜单“请人协助”或自然语言触发创建草稿，选择接收人和来源会话。
2. 预览目标、验收标准、允许修改的文件、依赖、分享清单与敏感信息提示；显式发送后才上传材料。
3. IM 展示一张稳定的任务卡片，更新状态而不为每条进度刷屏。任务正文和材料仅任务参与者可见。会话内其他成员只能看到明确允许公开的通知；不得通过卡片携带正文或对象票据。
4. 接收方可拒绝或接受。接受不自动执行。主进程先下载验证到暂存区，创建新的独立工作空间与本地任务，再提供“开始处理”。
5. 任务说明作为他人提供的数据进入本地任务；不提升为系统指令。依赖安装、外部操作和费用使用接收方现有权限策略。缺依赖时明确显示需要准备，不伪装运行成功。
6. 接收方提交固定版本的成果：修改说明、成果文件、执行证据和未完成项；对象全部完成校验后才能原子提交。
7. 发起方查看交付版本，可“要求修改”或“验收通过”。要求修改必须带说明；对方继续自己的副本并提交新版本，旧版本保留。
8. 验收通过后提供“预览并应用”。本地基线检查通过后建立恢复点并写入；有冲突则逐文件处理，或导入为新副本。成功落盘后才显示“已应用”。

## 权威数据与边界

- 服务端 task：taskId、requesterUserId、assigneeUserId、originConversationId、revision、state、currentDeliveryId、acceptedDeliveryId、createdAt、updatedAt。
- 材料 specification：目标、范围、验收条件和背景属于加密内容；事件只带 taskId/revision/state，不带任务正文、绝对路径或带签名 URL。
- immutable input snapshot：schemaVersion、snapshotId、逐文件相对路径/长度/SHA256、对象引用、依赖声明。服务器验明上传主体、任务归属与完整性，不采信客户端给出的权限。
- immutable delivery：deliveryId、taskId、inputSnapshotId、revisionNumber、提交主体、成果对象和清单哈希、说明、验证证据；不得修改已提交成果。
- 本地 binding：accountId/taskId/inputSnapshotId → projectId/sessionId/root，只留在本机。接受、导入和建任务各有恢复检查点；重启不会反复建工作空间。
- 本地 application journal：taskId/deliveryId/baseManifest/恢复点/逐文件操作状态。审批状态与本地落盘状态是两个维度，不共用 completed。

## 状态与授权

待接受 offered → 接受 active 或拒绝 declined；active → 提交 review；review → 退回 changes_requested 或通过 accepted；changes_requested → 再提交 review。发起方可取消 offered/active/review/changes_requested。终态 accepted/declined/cancelled 不允许旧指令复活。

创建者不能指定自己为接收人。只有指定接收人可接受、拒绝、提交，只有发起方可退回、验收和取消。服务端在事务内重查设备、双方有效身份、任务权限、会话范围及 Team 状态；Team 移除和好友屏蔽后的命令/下载被拒绝，旧回执重放不能绕过授权。管理员不是隐含成果接收人。

命令必须带预期 revision。审批还必须带明确 deliveryId，不能审批“最新结果”这种可变指针。重复同一 commandId 同一请求返回原回执，不产生第二次事件；不同请求复用 ID 明确报错。revision 冲突返回最新状态供用户确认，禁止自动把旧审批套到新成果。

## 传输与持久化

复用现有加密对象上传、分片重试和验证机制，但新增 task 对象归属与下载 authorizer；不能复用 conversation ACL 假装 task ACL。先上传完成，再绑定任务/成果，未绑定对象按保留期回收。撤权后票据不续发，绑定票据重查授权。对象存储地址不是可长期分享的公开链接。

任务命令复用既有事务回执、事件、用户同步游标和实时 outbox。每个任务 revision 严格递增，客户端重复/乱序事件只触发最新投影读取。正文加密缓存与命令 journal 使用账户密钥；账号切换/服务销毁后所有异步结果失效。

客户端先持久化 intent，再联网；超时显示“正在确认”，保持同一个 commandId。状态重查、回执重查和重新发送均复用该意图。提交未知时不生成新 delivery。通知失败不回滚已提交任务。停止任务只阻止后续协作，不强行杀死接收方其他本地工作。

## 安全应用

清单拒绝绝对路径、..、符号链接、大小写/Unicode 冲突、重复目标、超限解压和设备文件。输入基线哈希与本地当前文件逐一比较：相等可替换，不等需冲突决策。新增文件发现同名目标也算冲突；删除必须在允许修改范围内且用户明确确认。

文本可三方合并；Office/PDF/图片默认新版本或新副本，不承诺通用无损自动合并。预览后应用前再次检查本地哈希，防止检查到写入之间文件被修改。采用暂存、恢复点和落盘日志；崩溃后可继续或回滚。文件成功落盘与 journal 一致后才记录 applied。

## 交互标准

卡片只展示任务名、责任人、状态、更新时间和一个主要动作；详细材料与版本放在按需打开的详情中。进度合并到卡片，不新增聊天气泡。待验收明确指出提交版本；审批前不把 AI 自报的“完成”显示为用户验收通过。运行错误、依赖等待、失去权限分别展示可理解的状态，不显示内部 ID。

覆盖浅色/深色、窄侧栏/独立窗口、键盘操作、长标题、空附件、离线、重复提交、退回再提交、失去权限和多设备并发。危险动作说明对象与后果；普通读操作不增加确认弹窗。

## 实施与发布门槛

2026-09-07 生产联调补充：服务器已部署，测试组织限定开放；真实私有桶与双账号文件全流程、同机两个完整源码客户端任务展示已有证据。最新验收及未通过项统一记录在 `remote-task-live-acceptance.md`；下方阶段记录中的“尚未联调”是历史阶段状态，不应覆盖最新证据。发布安装包及 Windows 实机仍未验收。

P1：确定性生命周期、版本合并与应用冲突规划；自动化测试恶意角色、旧 revision、旧 delivery、路径边界及不变性。
P2：数据库 migration、服务端任务 ACL/对象绑定/命令事务/同步投影；真实 PostgreSQL 测试并发与掉响应后回执重放。
P3：本地加密 journal、工作空间接收 broker、任务绑定与恢复；实际 SQLite 重启测试。
P4：任务入口与 IM 卡片，接收/提交/退回/验收交互；真实 Electron 验证，禁止用静态卡片代替服务端联通。
P5：本地预览/应用/回滚；两台客户端加真实私有对象桶验收，离线、重启、冲突和撤权场景通过后才开放功能。

各阶段必须报告真实完成范围。未完成 P2–P5 时不注册一个看似可用的协作入口，不宣称闭环或直接生产部署。

## 当前实施记录

已实现 P1 生命周期与应用冲突规划；P2 已有 migration、加密 task projection、事务命令、任务参与者事件分发、task 对象绑定及下载 ACL、严格命令/查询 HTTP 路由。复用 workspace 对象时，inputSnapshotId/deliveryId 直接引用不可变对象 ID；当前 manifestHash 是绑定包的 ciphertext SHA256，用于包身份一致性，客户端仍需校验解密后的文件清单，不能把服务器字节校验解释成成果内容验收。

真实隔离 PostgreSQL 已验证 migration、并发创建幂等、状态修改 CAS 和非参与者下载拒绝；对象上传完成状态为测试种子，未测试真实七牛上传。内存事务适配器额外验证回执失败回滚与任务加密域隔离。HTTP 已有严格 schema/身份边界单测，尚无完整签名两客户端验收。

发布开关 `COLLABORATION_TASKS_ENABLED` 默认关闭，且依赖 workspace 分享开关与有效加密配置。桌面签名策略新增可选 `tasks` 字段，同时受 IM/workspace 主开关约束；旧策略不变。

2026-09-07 桌面增量：已接通签名任务查询与状态命令、严格 IPC/preload、SQLite v20 加密任务命令 journal、原设备/原命令 ID 的手动恢复、未知结果屏障、作用域撤权清理。提交状态动作前先核对服务端任务归属，防止错误会话选择错误加密范围。读取不保留授权之外的离线任务正文。完成回执不等同本地文件已应用。

已实现按需显示的对话任务入口、任务卡片列表、详情、接受/拒绝/取消/退回/验收确认、三语言、浅深色和窄屏布局。收到任务更新后刷新只读视图；正在写反馈时仅提示更新，保留输入框和焦点。新增独立加载/失败阶段，切换语言不能恢复旧详情或旧操作。界面与真实服务端 client/service 链路相连；视觉测试使用受控 API，不冒充生产联调。

后续实施已接通任务创建与材料冻结上传、独立工作空间下载/绑定、成果文件查看与提交、实际预览应用 broker 及恢复日志。双账户自动化使用真实 SQLite/ZIP/文件写入并以受控网络模拟远端，独立传输测试执行真实加解密；这不等于两台安装客户端与真实对象桶验收。当前列表仅显示最近 50 项，没有历史分页。生产开关仍默认关闭；现场验收未完成前不发布为已上线闭环。详细完成范围及平台边界见 `remote-task-ui-implementation.md`。

本地恢复补充：远端任务授权决定下载、提交和新的文件应用；对用户已批准的本机文件事务，恢复日志单独以个人账号加密保存，组织撤权不能销毁原文件恢复能力。启动恢复未完成事务，并提供不依赖已撤销任务的本地恢复入口；退出账号后不能访问其他账号的恢复记录。

验证：相关 `test-collaboration*.mjs` 与 `test-remote-task*.mjs` 共 124 个脚本通过；新增 `test-remote-task-ui.cjs` 运行真实 Electron DOM（受控 API），覆盖权限按钮、版本绑定、重复点击、未知结果恢复、语言切换失败屏保真、输入焦点、导航隔离以及 1100/420px × 浅/深主题。原 `test-collaboration-social-navigation.cjs` 通过。旧 center 生命周期测试的夹具已适配已有本地预览与串行队列，没有修改导航业务去迎合旧夹具。本轮未跑全仓测试、未部署或打安装包。


2026-09-14 远端共享发布：新增 `COLLABORATION_SHARED_PUBLICATION_ENABLED`（默认关闭），依赖既有 IM、workspace、tasks 和 task Git 开关。服务器最终配置 gate 发布 `sharedPublicationProtocol: 1`，桌面只接受匹配的 Git/workspace 协议版本；配置的 integration API 同时检查发布开关，旧缓存策略不能绕过关闭状态。启用后的启动恢复会分批保留并重新排队旧本地已完成、outbox 尚未发送的任务，由原会话重新检查并确认远端发布；确认后才原子地标记旧 outbox 被替代。该开关与本轮代码均未部署启用，剩余私有工作区合并/撤销、Office、流式大目录和完整双客户端验收见协作核心计划及 CAPABILITY-GATE。


2026-09-14 对象清理：新增服务端开关 `COLLABORATION_OBJECT_CLEANUP_ENABLED`，默认关闭。应用迁移 052、配置独立私有存储后，服务启动时注册清理循环，关闭时等待当前操作结束。每轮最多退出 64 个过期对象，再处理 8 个到期清理任务；对象锁与绑定操作互斥，密钥先移除，已有上传凭证等待 16 分钟失效后才删除密文。清理失败保留固定错误码并退避重试，服务商删除成功而数据库未提交时可幂等重试。已绑定且未到显式过期时间的对象不会因 orphan 截止时间被清理。保留清理原因，使原所有者仍能区分过期孤立对象和撤销；这不恢复下载权限。删除请求按[七牛资源删除](https://developer.qiniu.com/kodo/1257/delete)和[管理凭证](https://developer.qiniu.com/kodo/1201/access-token)签名，仅使用独立私有桶，200/612 才表示已删除或不存在。代码和测试均未启用生产清理，也未连接真实七牛执行删除。


本地应用并发边界（2026-09-14）：任务应用、回滚及启动恢复共用系统用户目录下的永久 SQLite 协调文件，不随账号或 Electron 数据目录变化。同步操作持有内核写锁，进程崩溃自动释放；占用立即返回可重试提示，取得锁后仍复核预览和文件哈希。锁文件不保存任务内容，也不能在清理中删除或替换。当前保守地串行处理所有协作应用目录，包含父子目录。普通编辑器及前台引擎写入尚未接入此锁；独立 A/W/M 与按贡献撤销也仍待实施，不以这项改动声称完成全部双链或双客户端验收。


独立本地候选（2026-09-14）：原会话原生整合在共享发布确认后，用明确的 A、真实 W 与 M 生成私有 W′ 暂存。文本采用 [Git merge-file](https://git-scm.com/docs/git-merge-file) 的标准输出模式，私有内容不写入共享 Git 对象库；支持的 JSON 冲突使用已有结构化合并器。本地修改、未共享文件与本地删除会保留；二进制和未解决冲突等待后续处理。候选身份与 A 记录加密持久化，丢失暂存可重建，旧异步代次不能覆盖新候选，旧共享修订不能倒退 A。只有可证明的初始共享基线可自动建立 A。候选准备不等于项目验证或本地落盘，也不推进 A；自动写入、写入回执恢复、按贡献撤销及完成任务的启动恢复仍待接通。


私有候选验证（2026-09-14）：W′ 在独立的本地验证 Git 仓库中固化为真实提交，再用固定的原始测试及现有隔离检查器验证；共享 M 的通过结果不能代替 W′ 的检查。证据与当前候选代次、检查策略和私有提交绑定，并加密存储。缺少检查仍需等待，检查失败不会因共享发布成功而被标记通过。原会话显示两者区别；验证本身不写入工作目录或推进 A，自动落盘与按贡献撤销仍待接入。


版本恢复写入协调（2026-09-14）：Git 版本恢复和本地快照恢复现与协作应用、回滚共用系统用户级锁，并在异步恢复及失败回滚期间持续持锁。占用返回现有版本忙提示，普通版本保存保持原调度。当前前台引擎入口仍只检查进程内版本服务状态，不能据此声称已完成跨客户端写入协调；引擎活动的完成与崩溃归属尚需接入，自动 W′ 落盘与 A 回执暂未启用。


引擎退出确认（2026-09-14）：共享引擎停止现保留所属子进程句柄，避免主进程退出并清空字段后遗漏工具进程。停止调用返回可等待回执；POSIX 原进程组消失才确认该组已退出，发送信号、主进程退出、权限错误或等待超时均不等价于工具全部停止。Windows 暂无进程树完成证明，主动脱离原组的工具及独立后台作业也不在此回执范围内。现有退出调用仍为尽力清理，自动落盘还需将前台活动注册及完整静默条件接入同一写入协调器。


Checkpoint 56: private A/W/M preparation now offers conservative DOCX part merging via the existing bundled Python resolver. Paragraphs/cells are atomic and only stable Word container positions are reconciled; opaque unchanged OPC parts retain their bytes. Relationship/content-type changes and digital signatures are outside this policy. Runtime failure remains an explicit candidate conflict, and the policy version invalidates older cached candidates. Shared-chain Office merging, rendered fidelity, other Office formats and automatic W′ application remain pending; this does not advance A.


Checkpoint 57 connects native private validation to application through an explicitly supplied foreground-aware writer. The final applied recovery journal, candidate receipt and A generation/revision advance share one SQLite transaction after whole-candidate verification; A references shared M. Interrupted receipts retain per-file rollback evidence without advancing A. Replayed completed publication preserves later private edits. Production still needs the cross-profile foreground admission implementation; only the controlled native/HTTP fixture supplies admission today. Applied materializations require contribution-specific inverse undo, not the legacy whole-file rollback.


Checkpoint 58: controlled POSIX engine/job groups register durably under the global local-writer lock before command execution. Application admission requires every registered group to be absent, including tools surviving their leader. Engine owner IPC closes the running group on main-process death; persistent jobs retain their independent lifecycle. Safe warm-profile draining and local-write retry still need to connect this admission to automatic materialization. Existing Windows paths are unchanged and no Windows foreground-completion proof is claimed.


Checkpoint 59 supplies POSIX foreground admission in the desktop source path. Busy application requests advisory idle-profile retirement without interrupting active/unknown views or retained SDK work. Completed-shared local continuation persists in the existing work schedule and returns through a fresh original-session TaskCore turn after admission becomes available. Work-generation changes do not replace the current local validator's turn. Local A/application receipts remain atomic; contribution-specific undo and task-card local state are the next required steps. Existing operator protocol gates remain unchanged.


Checkpoint 60 adds a separate persisted local stage to existing task cards and task details. Shared publication remains its own stage; applied requires the bound local receipt and validation identity. Waiting, validation failures, conflicts and baseline recovery are visible without exposing native paths or evidence contents. Contribution-specific undo remains the next implementation step.
