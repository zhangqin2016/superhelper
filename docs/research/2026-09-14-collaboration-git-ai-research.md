# Lily 通用工作台协作方案

建议将协作的中心从“一次任务的一份文件包”提升为“有稳定身份的共享项目”。项目与每台设备上的工作空间长期绑定，任务贡献独立的变更集，Git 保存版本关系，文件对象存储负责大文件，AI 在绑定会话中自动处理合并并提供验证证据。用户通过自然语言发起、提交、调整与撤销；任务卡片负责持续呈现状态与结果。

本报告提出目标方案与分阶段实施边界，不表示这些能力已经上线。研究范围覆盖 Office、代码和大文件；资料核对截至 2026-09-14。产品参考来自官方交互说明，研究参考区分正式论文、预印本与实验性原型，不将它们视为对 Lily 实际效果的背书。

## 1. 决策与方案取舍

采用 **Git + 文件对象存储 + AI 合并执行器** 作为主路线。保留现有服务端任务权限、回执、实时事件、本地加密记录和恢复机制。实时协同算法只用于 Lily 自己控制数据模型的协作笔记等局部能力，逐步加入。

| 路线 | 适配程度 | 主要收益 | 主要代价与边界 | 决策 |
|---|---|---|---|---|
| 扩展现有 ZIP 快照 | 单次材料交接 | 兼容路径最短 | 每次全包，任务间缺少共同历史；继续自建差异、合并、增量传输 | 保留兼容导入，不再作为持续协作底座 |
| Git + 对象存储 + AI | 普通文件夹、代码、Office、媒体混合项目 | 成熟版本图；任务隔离；变更交付；可恢复；适配外部编辑器 | 必须补齐项目绑定、权限域、Office 合并、客户端落盘事务 | 推荐主路线 |
| 全量 CRDT 文档系统 | Lily 原生编辑器 | 在线与离线编辑可汇合，细粒度操作历史 | 外部 Word/Excel 和任意文件没有统一操作模型，改造成本很大 | 作为局部扩展，不替代文件协作 |

Local-first 研究强调离线可用、数据控制与协作可以兼容；它提供的是设计原则，而非任意文件自动合并的现成实现。[1 · Local-first software](https://www.inkandswitch.com/essay/local-first/)

对 Lily 的具体产品承诺应为：**一次绑定、按任务提交变化、收到成果自动整合、全程可追踪、已有工作可恢复。** 不承诺 AI 对任何冲突都能做出正确业务判断，也不以此为由让普通冲突默认回到人工操作。

## 2. 当前实现与目标之间的差距

以下是本地源码事实，不根据旧设计文档推断功能已存在。

| 主题 | 当前事实 | 目标 |
|---|---|---|
| 分享入口 | 导出工作空间包、聊天附件、远程任务三条路径分离 | 对外明确区分“发材料”和“请人协作”；任务始终有稳定卡片 |
| 任务卡片 | 位于独立任务列表；聊天时间线未接入任务渲染 | 聊天和工作空间会话呈现同一任务引用 |
| 创建时机 | 先冻结、上传并验证输入包，再创建远程任务 | 先持久化协作意图与可见卡片，材料未就绪时明确显示准备状态 |
| 来源工作空间 | 已能用 projectId 指定，并记录源目录 | 延续并提升为共享项目绑定 |
| 接收工作空间 | 首次接收分配随机目录；同任务正常会复用 | 首次选择已有工作空间或新建，后续多个任务复用绑定 |
| 提交 | 从工作副本重新冻结完整 ZIP | 提交本次任务的新增、修改、删除、重命名 |
| 大小限制 | 任务包 256 MiB；单文件 200 MiB；任务清单 10,000 文件 | 清单与内容分离；容量由配额、可用磁盘和资源策略决定 |
| ZIP | STORE 不压缩；生成完整内存缓冲 | 流式对象传输，不把目录物化为一个大包 |
| 合并 | 基线、当前、交付哈希比较；同文件双方修改即冲突 | Git 初步合并 + 类型适配 + AI 意图整合 + 验证 |
| 本地 Git | 已有私有 version-vault.git，失败回退本地快照 | 复用 Git 能力，但保留私有备份与共享仓库的边界 |
| 自动执行 | 更新事件刷新任务视图；未接入自动合并执行 | 远程交付进入持久化队列，并投影到绑定会话 |

源码依据：[任务面板](/Users/zhangqin/aicode/ceshitermianl/src/renderer/modules/collaboration-remote-tasks.js)、[工作流](/Users/zhangqin/aicode/ceshitermianl/src/main/collaboration/task-workflow.js)、[接口白名单](/Users/zhangqin/aicode/ceshitermianl/src/main/collaboration/task-workflow-view.js)、[打包](/Users/zhangqin/aicode/ceshitermianl/src/main/collaboration/task-bundle.js)、[包上限](/Users/zhangqin/aicode/ceshitermianl/src/main/collaboration/workspace-package.js)、[导出过滤](/Users/zhangqin/aicode/ceshitermianl/src/main/workspace-export-planner.js)、[哈希冲突规划](/Users/zhangqin/aicode/ceshitermianl/src/main/collaboration/task-apply-plan.js)、[本地版本服务](/Users/zhangqin/aicode/ceshitermianl/src/main/workspace-version-service.js)、[Git 仓库路径](/Users/zhangqin/aicode/ceshitermianl/src/main/workspace-git.js)。

已有加密传输实现使用有界流和分帧验证；不能把任务 ZIP 的内存限制误诊成整个传输层都需要重写。相关能力在 [encrypted-container.js](/Users/zhangqin/aicode/ceshitermianl/src/main/collaboration/encrypted-container.js)。

## 3. 成熟交互值得借鉴的部分

| 参考 | 已有交互依据 | Lily 应吸收的设计 | 不直接照搬的部分 |
|---|---|---|---|
| Linear Agent Sessions | Agent 状态、活动和继续对话归属具体任务 | 任务中可见地执行；等待输入与正在工作明确区分 | 不另建一个让用户管理 Agent 的控制台 |
| Figma 分支与合并 | 页面/对象级变化摘要、并排与叠加比较、版本恢复 | 默认看成果影响，细节按需展开；文档按页、表格按区域比较 | 不让普通用户逐项处理 Git 冲突 |
| GitHub Merge Queue | 对最新目标及前序合入结果验证 | 多人交付按项目整合，检查针对实际将发布的版本 | 不直接复制 PR 审核表单 |
| Dropbox 在线文件 | 文件存在与文件已下载分开呈现 | 大项目先呈现清单，按需取内容，可固定离线 | 初期不宣称具备 Finder/资源管理器系统占位能力 |
| Microsoft Word Compare/Combine | 根据原版与修订版生成可检查的合并文档 | 以原文档为基底保留结构、审阅来源 | 不承诺后台 Python 已拥有 Word 同等合并能力 |

来源：[2 · Linear](https://linear.app/developers/agent-interaction)、[3 · Figma](https://help.figma.com/hc/en-us/articles/5691189138839-Merge-branch-into-main-file)、[4 · GitHub](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)、[5 · Dropbox](https://help.dropbox.com/sync/make-files-online-only)、[6 · Word](https://support.microsoft.com/en-us/word/compare-and-merge-two-versions-of-a-document)。这些是各自产品中的行为，下面的组合是对 Lily 的设计建议。

建议把主交互收敛为三个持续存在的对象：工作空间、会话、任务卡片。版本图、上传队列、合并执行细节都归属于它们，不再增加同级产品导航。

### 发起与材料准备

用户在“季度经营计划”工作空间说：“请小林更新预算，保留我正在写的说明，完成后自动合并。”系统建立 taskId，将任务卡片立即放入本地会话。服务端确认创建后，对方也看到同一任务的“材料准备中”状态；离线时只在本机显示“待发送”，不能伪装对方已收到。

卡片包含任务名、负责人、共享项目、当前阶段和一个主要动作。默认不展示提交哈希、对象 ID、绝对目录。材料清单形成后，提供“本次范围”摘要；未准备完成的对象不能授权执行或被显示为材料完整。

这要求增加“任务意图已创建、材料尚未封存”的独立阶段。服务端任务和时间线引用同事务落库；输入版本后续用 revision 条件更新一次绑定，不能通过一条普通聊天消息冒充任务创建成功。

### 接收与绑定

对方首次接受项目时，选择“接收到已有工作空间”或“新建工作空间”。以后同一共享项目的任务直接使用已经绑定的位置。位置失效时修复绑定，不凭同名目录自动猜测目标。

界面只有一个工作空间；内部可以有多个 Git worktree 用于任务和合并隔离。这些临时目录不作为新项目塞满侧栏。用户从 Word、Excel 或编辑器打开的是已明确物化的本地文件。

### 提交与自动整合

“把这次预算修改交付”生成固定的任务变更集。卡片先显示本次变化摘要和实际待上传量，再进入上传、校验、整合状态。发送一份成果后继续编辑，应形成下一版本，而不是修改正在传输的那一版。

接收交付自动触发整合，默认不再增加“预览并应用”的必经按钮。AI 的执行活动归入已绑定会话；不抢走用户正在阅读的页面，不清空输入，也不打断正在运行的前台任务。执行完成后同一张卡片显示具体成果、验证范围和“查看变化”；撤销仍可通过自然语言完成。

项目可以保留业务验收策略，但“AI 已生成候选”“共享版本已整合”“已写入本机”“业务已验收”必须分别记录。自动合并不是自动伪造人工验收。

### 一个真正需要决策的例子

双方将同一预算上限分别改为 120 万和 150 万。AI 先查任务要求、最近授权的决策与相关资料；有明确依据便按依据整合。没有依据时，卡片只提出“预算上限采用 120 万还是 150 万？”这一项问题，并保留其他已经解决的结果。不能让模型通过取平均值或相信最近文件时间来杜撰业务规则。

## 4. 提交变化的准确含义

Git 在逻辑上记录整个项目的快照，并复用没有变化的内容；“提交改动”不意味着每个提交本质上只是一个 patch 文件，更不意味着重新上传整个文件夹。[7 · What is Git?](https://git-scm.com/book/en/v2/Getting-Started-What-is-Git%3F)

Lily 必须分开三层：

| 层次 | 含义 |
|---|---|
| 用户看到的提交 | 本次任务贡献的变化与说明 |
| 版本记录 | 基线、结果树、父提交、任务身份、证据引用 |
| 网络传输 | 远端缺少的 Git 对象、文件对象或内容块及必要元数据 |

例如，工作空间共 20 GB，本次只修改一份表格和一段说明，未改的视频不重新上传。表格内部改一个单元格，仍可能需要上传整个新的表格对象；这与“不重传整个项目”是两个不同的优化问题。接收者从未拥有的基线和必要依赖，首次仍要传输。

任务交付至少绑定：sharedWorkspaceId、taskId、deliveryId、baseCommit、resultCommit、文件变化清单、说明与验证证据。删除以显式变化表示；离线未下载的文件、被排除的文件、读取失败的文件都不构成删除。重命名保存旧路径与新路径；Git 的重命名推断只是辅助，不作为授权依据。

### “自己更新的内容”不能只靠扫整个目录

最可靠的归属来自任务从基线创建的隔离工作副本。任务内的变化对比该基线，且受已授权范围约束；不采用全局 `git add .` 把无关工作一并提交。

外部编辑器直接修改主目录的情况，需要把相应修改收纳到指定任务。文件路径、修改时间和“哪个 Agent 最后碰过文件”不能可靠区分同一个文件中属于不同任务的片段。归属明确的直接纳入；混杂且无法确定的，在会话中呈现具体变化供一次性确认。提交草稿不应通过推断扩大原始分享范围。

范围过滤在进入共享对象库前执行；敏感内容未获授权时保留在本机，并明确指出未包含的内容。缺失关键材料会阻止该次交付标记完整，不静默制造残缺成果。

## 5. 项目、工作空间与版本的身份模型

| 实体 | 作用 | 存放位置 |
|---|---|---|
| SharedWorkspace | 稳定项目身份、成员范围、共享版本、整合策略 | 服务端 |
| WorkspaceBinding | sharedWorkspaceId 到本机 projectId、目录和会话的映射 | 当前账号与设备本地 |
| Task | 目标、负责人、范围、讨论、业务生命周期 | 服务端 + 授权投影 |
| Delivery | 不可变的任务变更版本 | 服务端元数据 + Git/对象存储 |
| IntegrationAttempt | 针对明确目标版本的合并与验证尝试 | 执行端持久化；安全摘要同步 |
| Materialization | 某台设备将共享结果写入本地的状态 | 本地；仅同步必要回执 |

同一个 sharedWorkspaceId 可以绑定到不同设备上的不同路径；本地路径不是远程协议中的授权凭据。会话绑定应明确保存，由用户选择的会话优先，不能因为另一个会话最近活跃就改投递位置。

Git worktree 允许同一个仓库拥有多个工作目录，共享仓库内容与历史；它解决的是执行隔离，不要求产品界面出现多个工作空间。[8 · git-worktree](https://git-scm.com/docs/git-worktree)

### 现有本地 Git 不应直接 push

当前 `.lily-work/version-vault.git` 用于本机恢复。推荐保留其职责，并为共享范围建立持久的协作仓库；两者通过已授权的文件树交接，不把私有历史、密钥或未提交材料当作共享祖先推送。

已有标准 `.git` 项目的适配，可在成员对完整仓库具有匹配权限时使用原远端和分支策略。仅邀请别人修改一个子目录时，需要独立、经过过滤的共享仓库，不能将 sparse-checkout、隐藏 refs 或 Git namespace 视作目录读权限。Git 官方明确说明 namespace 不能提供有效的仓库读隔离。[9 · gitnamespaces](https://git-scm.com/docs/gitnamespaces)

因此，一般业务用户无需创建 GitHub 账号；Lily 可提供标准 Git 远端，由现有账号与项目权限签发短期访问凭据。Git 服务使用成熟协议实现，不在 Fastify 内重写 Git 协商或 pack 格式。Git 服务与对象服务应具有各自受限的凭据，渲染层和模型均不能获得长期服务器凭据。

## 6. 自动合并需要两条明确的链路

共享版本整合与本机未发布修改的协调必须分离。这是避免“自动接收把私人草稿也发出去”的核心。

**共享整合：**以当前已发布共享版本 H 和交付 D 为输入，根据共同基线构建候选 M；验证通过并持有有效发布权限后，将共享目标从 H 条件更新为 M。这里只能包含明确发布的内容。

**本地物化：**以本机上次同步的版本 A、当前真实文件 W 和新的共享版本 M 为输入，得到 W′，保留本地未发布修改。W′ 仍然是本地状态；不能因为它完成了接收合并就自动 push 成公共版本。

业务上用户看到“对方的修改已经合进这个工作空间”，技术上应同时能说明共享版本是否已更新、本机是否落盘、哪些内容仍只在本机。

### 合并执行协议

1. **接收事件与去重。** 交付事件进入本地 SQLite 收件箱；用 deliveryId 和目标绑定建立稳定入队身份。重复 WebSocket、重连补同步、掉回执不会触发第二个等价合并。
2. **建立执行上下文。** 从绑定会话读取相关任务要求、双方变更说明、共同基线、最新文件与验证依据。远端文字是数据，不可提升为系统指令或改变本机权限。
3. **后台准备候选。** Git 使用现代 `merge-tree --write-tree` 计算初步结果，不改活动工作目录；其可以执行三方内容合并和重命名检测，但输出树可能仍有冲突，必须检查状态与冲突条目。[10 · git-merge-tree](https://git-scm.com/docs/git-merge-tree)
4. **按类型处理并验证。** 结构化工具处理明确的合并，AI 处理剩余意图冲突和关联文件，执行下面定义的验证。隔离目录、工具调用与结果都关联到原会话的可见运行记录。
5. **重新检查目标。** 共享目标已改变时，基于新 H 重新整合并验证，不提交基于旧目标检查通过的结果。借鉴合并队列对真实目标组合的验证方式。[4 · GitHub Merge Queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)
6. **发布共享结果。** 唯一有效整合者使用带旧值的条件更新发布 Git ref；失败表示需要读取现状重新判断。`update-ref` 支持旧 OID 校验，但其事务不覆盖 PostgreSQL 与文件系统。[11 · git-update-ref](https://git-scm.com/docs/git-update-ref)
7. **写入本机。** 本机协调使用工作空间级写入租约及代次标识，不只依赖会话队列。落盘前重读真实文件哈希，建立恢复点，逐文件 journal 写入；失败保留已准备候选并恢复未完成事务。
8. **确认结果。** 本机文件与 journal 一致后记录 materialized；服务端提交与事件投影使用可恢复回执。模型最终回答不得直接将任务状态改成“已合并”。

Git ref、服务端数据库、本地 SQLite、用户文件之间不存在一个天然全局事务。应采用持久化操作记录、幂等回执和重启对账：ref 已更新但响应丢失时查该 integrationId 的发布记录；本地写入未完成时恢复原事务；事件重复时只刷新投影。

共享整合者在服务端以 sharedWorkspaceId、目标 revision 领取带代次的执行资格，多个在线设备不同时发布。设备失联后可移交资格；旧执行者即使恢复也不能提交过期结果。工作副本里有真实新进展时持续执行；相同错误和相同候选反复循环才受无进展约束，不因大文件或合法长任务固定超时而丢失工作。

### 会话可见性与执行隔离

“在原会话合并”定义为：该会话拥有合并任务、上下文、进度、提问和最终结果，不等于把一个绑定旧目录的引擎进程直接切到临时 cwd。现有引擎与工作目录的会话关系需要明确适配；可建立会话拥有的内部合并执行器，将其事件投影回原会话，不创建新的用户可见项目。

候选准备可在隔离副本进行；写入活动工作区必须和前台写入串行协调。Windows 文件被 Excel 占用时保留候选并说明等待关闭文件；编辑器内尚未保存的内容不可假装已被 Git 捕获。对于不受 Lily 控制的外部进程，本地文件 journal 只能提供可恢复写入，不能承诺任意进程都观察到跨文件的原子切换。

自动触发受设备现实状态约束。桌面退出或设备休眠时，事件持久等待恢复，不宣称本机仍在运行。未来云端执行是明确的独立能力，必须具有授权运行环境，不能偷换为当前桌面自动执行。

## 7. AI 合并的研究依据与验证策略

**SafeMerge（2018）**将语义无冲突与文本无冲突分开，在 52 个真实合并场景上评估验证方法。对 Lily 的启示是：即使 Git 干净合并，也可能破坏行为，因此验证不能只扫描冲突标记。该论文不是通用 Office 或任意代码的即插即用证明器。[12 · SafeMerge](https://arxiv.org/abs/1802.06551)

**MergeBERT（FSE 2022）**通过三方 token 差异与学习到的合并模式生成结果；正式论文报告特定数据集上的 63–68% 准确率。应借鉴“基线 + 两侧修改”的输入结构，不能把该数值解释成今天任意 Agent 的成功率。[13 · MergeBERT](https://www.microsoft.com/en-us/research/wp-content/uploads/2022/09/mergebert-fse22-camera-ready.pdf)

**Merge-Bench（2026 年 5 月预印本）**提供来自 1,439 个仓库的 7,938 个冲突片段，并讨论模型过度尝试解决的问题。评测限制了片段大小，以开发者提交和代码归一化匹配等口径衡量结果；这些口径不等于运行正确，也不能覆盖完整工作空间任务。Lily 应借鉴公开基准的构造与“错误自动合入率”评估，不直接拿榜单选一个模型作为安全保证。[14 · Merge-Bench](https://arxiv.org/html/2605.25890v1)

**Java 合并评测（2026 年 7 月预印本）**采用生成、结构验证、重试，并区分开发者匹配、独立合理性和结构有效性。它有 Java、样本与模型裁判校准的边界；其价值是提示 Lily 将不同证据分别记录，不把第二次 LLM 判分作为确定性验收。[15 · Calibrated LLM-as-Judge](https://arxiv.org/html/2607.27674v1)

**SAM（2023 预印本，关联 2024 JSS 论文）**探索生成测试作为局部行为规格，表明测试可以暴露部分语义冲突，但存在漏检。Lily 可从双方分支生成针对变化的检查，不能据此宣称测试通过就证明全部业务语义正确。[16 · Detecting Semantic Conflicts with Unit Tests](https://arxiv.org/abs/2310.02395)

这些研究并不否定自动化。它们支持采用有反馈的 AI 执行流程：模型提出具体修改，工具验证真实结果，失败时带证据修正，只将无法获得的业务决策交给人。

建议把证据记录为结构化集合：候选内容哈希、输入版本、检查器及版本、执行结果、覆盖范围、保留的原始变化、未解决的意图。模型自报“信心 95%”不能单独授权写入。模型可以补充测试，但不得通过删除或放宽原有检查来制造合并成功。

## 8. Office、代码与媒体应采用不同合并方式

| 类型 | 合并方法 | 必须检查 | 无法验证时的交付 |
|---|---|---|---|
| 代码、Markdown | Git 三方合并；必要时结构分析与 AI 修改 | 解析、类型、相关测试、任务意图、关联调用 | 保留候选与失败证据，继续修正或提出具体决策 |
| JSON/配置 | 已知 schema 下按字段处理；数组身份显式定义 | 重复键、类型、顺序语义、关联配置 | 不把所有数组当集合；保留两侧来源 |
| Excel | 按工作表、表/行身份、单元格、公式与样式建立三方变化 | 公式与依赖、合计、引用、命名区域、图表与关键外观 | 结构复杂或往返不保真时提供候选新版本，保留原件 |
| Word | 按段落、表格、样式、关系、批注/修订建立对应 | 内容保留、编号、页眉页脚、引用与逐页渲染 | 不将提取的纯文本重建成“已无损合并”的 DOCX |
| PowerPoint | 按幻灯片及对象关系合并 | 母版、布局、图片关系、备注、逐页渲染 | 不可靠的对象对应先保留版本与具体差异 |
| PDF | 优先合并来源文档后重新导出；批注可做专门适配 | 页面完整性、文字、表格与视觉变化 | 无源文件时保留版本，避免声称可通用语义合并 |
| 图片、视频、音频 | 完整内容对象版本化；有编辑工程时优先合并工程元数据 | 可解码、尺寸/时长、关联资源完整性 | 可呈现或生成候选，不称“字节自动合并” |

SpreadsheetML 包含工作簿、工作表、共享字符串等多个部分，说明 XLSX 合并不能等同于按一个 XML 文本文件做 Git merge。[17 · Microsoft Open XML](https://learn.microsoft.com/en-us/office/open-xml/spreadsheet/structure-of-a-spreadsheetml-document)

以上 Office 路线是需要实现与验证的目标能力。稳定对象身份会被外部应用保存、行列插入、复制粘贴破坏；必须结合基线、关系与结构对齐，不依赖单一 ID 或单元格坐标。未知 XML 部分、宏、嵌入对象、数字签名和应用特性必须检测并保留或明确报告限制；自动打开执行宏不属于合并。

文档读写与渲染沿用项目的 Python/LibreOffice 管线，普通电脑优先轻量处理。AI 使用需要的局部内容与视觉证据，不把整个大目录送入模型，也不把专门的大模型作为每个用户必装依赖。

## 9. 大文件与大目录

目标为“清单先行、内容按需、任务增量、流式执行”。第一次共享一个文件，远端没有该内容时仍需上传；第一次接收执行某项任务，所需文件仍需下载。优化的对象是无关与已存在的重复内容。

**第一层：Git 管理小文件和内容指针。** 对明显的大二进制文件使用 Git LFS 或兼容的内容对象层。LFS 指针包含内容 OID 和大小，不等同于文件内部的增量 patch；其标准模型不能被描述为自动只上传改过的字节。[18 · Git LFS specification](https://raw.githubusercontent.com/git-lfs/git-lfs/main/docs/spec.md)

**第二层：成熟对象传输。** 第一阶段复用现有认证、分片、流式加密、断点恢复和文件校验。LFS 接入需要协议适配与实测，不能只往 Git 写一个看似 LFS 的指针就宣称标准客户端兼容。完整交付发布前，引用的必需对象须已持久化并可在授权范围内取得。

**第三层：按需物化与空间管理。** 清单记录远端可用、下载中、本地可用、固定离线等状态。Agent 工具先申请所需文件物化，成功后再启动依赖普通文件路径的命令。初期只在 Lily 文件树实现在线清单，不在真实文件夹制造空白假文件；系统级 Finder/File Explorer 占位需要平台扩展，另行验收。

**第四层：文件内部内容块复用。** 对大而频繁变化的适合类型，加入块清单与缺失块传输。Syncthing BEP 是可借鉴的成熟块交换设计，包含逐块哈希、缺失块请求与增量索引；不必因此将其全套文件同步行为作为 Lily 的产品语义。[19 · Syncthing BEP](https://docs.syncthing.net/specs/bep-v1.html)

压缩容器、重新编码视频和重排数据可能导致大量块变化，因此“改一个单元格只传几字节”不能作为普遍承诺。是否使用内容定义分块，应通过代表性文件的带宽、CPU 和磁盘收益决定，不能为了技术完整性先建复杂分块系统。

Git partial clone 减少预先获取的对象，sparse-checkout 缩小本地检出范围；二者分别作用于传输与工作树，均不构成读取权限。[20 · partial-clone](https://git-scm.com/docs/partial-clone)、[21 · sparse-checkout](https://git-scm.com/docs/git-sparse-checkout)

缓存与去重限定在相同授权域内。不能使用公开的全局内容哈希接口，让另一租户探测别人是否持有某份敏感文件。沿用现有经过审计的加密设计，明确服务器能看到的内容与元数据；如升级端到端加密，应作为独立密钥协议工程，不能凭“客户端加密上传”就宣称已经实现。

## 10. 实时协同的适用边界

Figma 的多人协作实现随数据类型演进；其 Code Layers 工程文章指出，短字段上的最后写入覆盖策略不适合多人和 AI 同时编辑较长源码。[22 · Figma Code Layers](https://www.figma.com/blog/building-figmas-code-layers/)

Peritext（CSCW 2022）面向富文本格式与异步副本合并，说明即使是粗体、链接这样的属性也需要专门的意图模型。它不提供任意 Word/Excel 文件的无损合并，更不能消除业务判断冲突。[23 · Peritext](https://www.inkandswitch.com/peritext/)

Patchwork 将分支、历史、差异与自动化实验放进日常创作环境，是值得参考的研究方向；它是研究原型，不能视为已经证明大规模通用工作台交付能力。[24 · Patchwork](https://www.inkandswitch.com/patchwork/notebook/2024-version-control/)

建议先将实时协同限定为原生任务说明、共享笔记或编辑器内受控文档。每类内容只能有一个权威模型：若原生笔记由 CRDT 驱动，Git 中保存的是带版本的导出检查点，不能同时让外部文件和 CRDT 双向无规则覆盖。外部编辑应以显式导入形成新的操作或版本。

协作在场信息、正在编辑哪个文件属于提示，不是锁。光标同步并不意味着文件内容语义正确，也不意味着有权限写入主项目。

## 11. 同一张任务卡片如何成立

服务端 task 是状态权威，聊天中的 task_ref 只是稳定锚点。任务引用与创建回执一次性持久化，后续进度更新投影，不不断追加新的气泡。任务卡片不能依赖是否打开过独立任务列表才出现。

共享部分包括目标、贡献者、固定交付版本与共享整合状态；本机部分包括绑定位置、排队、下载和落盘状态。双方看到的是同一个任务，但“已写入本机”只能由各自设备的实际回执决定，不能因为对方成功就显示本机成功。

普通进度不反复制造未读；新任务、需要业务输入、新交付和可操作失败才产生注意事件。初始卡片按创建时间固定排序，变化提示按 revision 更新，不因反复刷状态跳动聊天位置。卡片正文按参与者授权读取，群聊非参与者不能经标题、附件 URL、搜索或通知预览获得任务隐私。

移动到其他会话、切换账号、撤销成员权限时，旧异步回调不能把内容放到新会话。离线、失败、正在确认分别呈现；传输百分比来自真实字节，未知总量时显示阶段而非虚假百分比。辅助技术读取状态变化，但不逐 token 打断屏幕阅读器。

## 12. 与现有代码的实施映射

| 模块 | 保留的基础 | 必要改造 |
|---|---|---|
| collaboration-remote-tasks / timeline | 现有任务动作和本地化 | 抽出共用任务投影，接入稳定 task_ref，移除独立面板依赖 |
| task-workflow / task-records | 账号隔离、加密记录、幂等与恢复 | 加 sharedWorkspace 与设备绑定；保留旧 task 兼容记录 |
| task-bundle | 严格路径、完整性、旧包读取 | 新交付不再整包；ZIP 仅用于旧任务与离线交换 |
| workspace-git / version-service | Git 发现、运行时包、版本恢复 | 建共享仓库适配层；不把私有 vault 直接变成远端 |
| transfer-manager / encrypted-container | 流式传输、分片、密文与明文验证 | 文件对象、缺失对象查询、配额协商；后续分块复用 |
| turn-orchestrator / turn-queue-options | 持久化入队身份、队列来源、前台串行 | 类型化 integration 输入、绑定会话事件、工作空间级协调 |
| long-task 与 TaskCore | 已有任务连续性与恢复语义 | 映射整合运行与证据，避免建立第二套不可观测的任务循环 |
| task-application | 文件 journal、冲突检查、恢复 | 承接已验证候选的本地物化与条件撤销 |
| 服务端 tasks / task-packages | 事务命令、对象授权、事件 | 新交付身份、共享版本、整合资格与发布对账 |

建议按可验收的纵向切片推进，而不是一轮把 Git、CRDT、Office 编辑器和系统文件扩展全部重做。

| 阶段 | 可交付能力 | 进入下一阶段的证据 |
|---|---|---|
| A：身份与交互闭环 | 共享项目、长期绑定、聊天稳定卡片；旧文件包仍可工作 | 两台完整客户端重启后不重复项目/卡片，任务 ACL 不泄漏 |
| B：Git 任务增量 | 任务基线、隔离变更、固定交付、缺失对象传输 | 同目录多任务不夹带修改；断网重传不重复提交；历史可还原 |
| C：自动整合与恢复 | 原会话触发、Git/AI 合并、验证、条件发布、本地落盘 | 重复事件、多设备、目标前移、进程中断、外部编辑均受控 |
| D：Office 与大文件规模化 | 文档适配、按需物化、缓存、流式大对象 | 真实 Office 往返保真与大目录资源测试；支持矩阵明确 |
| E：局部实时协同 | 原生笔记 CRDT、协作在场与有价值的块复用 | 不破坏文件权威，跨设备离线汇合有证据 |

阶段 D 应在 B/C 开发期间并行验证技术可行性，但不提前对用户承诺任意 Office 无损合并。协议先定义可扩展的内容引用，使全文件对象到分块对象的升级不改变任务交付身份。

## 13. 验收标准与质量指标

首要指标为错误自动合入率、任务意图保留率、原文件可恢复性与用户被迫介入次数，而不是“冲突标记消失比例”。公开代码基准可以作为回归集的一部分，还需要合法授权的真实 Office 双分支样本和合成的边界场景。

最低验收场景：

1. 分享后双方卡片可见；重连、搜索、历史分页和多窗口不会重复。
2. 同一共享项目多个任务复用工作空间；同名不同项目不混淆。
3. 工作区有其他会话的未发布修改，本任务提交不夹带内容。
4. 远端已有 20 GB 基线，本次仅改小文本；网络记录显示未重传不变大文件。
5. 文件未下载、被忽略、暂时锁定或扫描失败均不被解释成删除。
6. Git 无文本冲突但改变调用约定，验证能发现关联行为问题。
7. 双方编辑 Excel 同一公式、插入行、修改图表引用，分别检验内容和结构。
8. Word 双方改不同段落及同一表格，逐页比较并核对批注、编号和页眉。
9. 合并期间本机继续编辑；最终不能覆盖检查之后的新内容。
10. 三人连续交付，后一个候选针对前一个已合入结果重新验证。
11. 同账号两台设备收到同一事件，最多一个有效发布者，各自落盘独立记录。
12. 上传、共享 ref 更新、数据库回执、逐文件写入的每个边界注入进程退出；重启后可对账或恢复。
13. 撤权后不能新读写远端；本机已授权的原文件恢复能力仍存在。
14. 无模型、无网络、Git 准备失败时仍可普通本地工作，完整交付候选被保留，不假报成功。

建议性能实验配置为 16 GB 内存的普通笔记本、100 GB/100,000 文件混合目录、10 GB 单文件与弱网中断。**这是目标测试规模，不是已经支持的规格。** 记录索引峰值内存、首屏时间、上传/下载字节、哈希时间、缓存命中与磁盘放大。传输内存应随块大小和并发受界限约束，不能随完整项目大小增长。

本地任务意图落库后卡片出现的建议 p95 目标为 200 ms，测量不包含网络 ACK；网络可用性和材料就绪另计。AI 质量目标应从实测基线建立，不预先承诺 99% 自动合并。上述目标都需要规定设备、样本和测量方法后验收。

## 14. 证据范围与结论限制

已核对当前源码与项目产品约束。前序本地验证运行了 `test-remote-task-bundle.mjs`、`test-remote-task-workflow.mjs`、`test-remote-task-session.mjs`、`test-remote-task-application.mjs`，均通过；其中工作流测试使用真实 SQLite/ZIP/文件和受控网络、对象服务。这证明现有路径的部分机制，不证明新方案已实现或真实双机体验已达标。

本研究未运行商业产品登录后的完整用户测试，交互分析基于其官方文档与公开工程说明；未对论文模型做本地复现，未将不同数据集的准确率横向排名；未测试真实 GB 文件的 Git/LFS/分块收益。最大的不确定性是复杂 Office 的保真整合及 AI 业务意图保留，需要专门的数据集和真实用户评估。

交互演示中的人物、文件、大小和状态是说明方案的虚构场景，不能作为测量或运行证据。

## 参考资料

1. Martin Kleppmann 等，Ink & Switch，2019，[Local-first software: You own your data, in spite of the cloud](https://www.inkandswitch.com/essay/local-first/)。用于本地优先与离线协作原则。
2. Linear，持续维护文档，[Developing the Agent Interaction](https://linear.app/developers/agent-interaction)。用于会话、活动与可见状态。
3. Figma，持续维护文档，[Merge branch into main file](https://help.figma.com/hc/en-us/articles/5691189138839-Merge-branch-into-main-file)。用于对象级对比与版本恢复。
4. GitHub，持续维护文档，[Managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)。用于最新目标组合验证。
5. Dropbox，持续维护文档，[Make files online-only](https://help.dropbox.com/sync/make-files-online-only)。用于按需文件交互。
6. Microsoft，持续维护文档，[Compare and merge two versions of a document](https://support.microsoft.com/en-us/word/compare-and-merge-two-versions-of-a-document)。用于文档审阅与合并呈现。
7. Scott Chacon、Ben Straub，Pro Git 第二版，[What is Git?](https://git-scm.com/book/en/v2/Getting-Started-What-is-Git%3F)。用于逻辑快照模型。
8. Git 项目，官方手册，[git-worktree](https://git-scm.com/docs/git-worktree)。用于同仓库多工作副本。
9. Git 项目，官方手册，[gitnamespaces](https://git-scm.com/docs/gitnamespaces)。用于读权限隔离边界。
10. Git 项目，官方手册，[git-merge-tree](https://git-scm.com/docs/git-merge-tree)。用于不改工作树的初步合并。
11. Git 项目，官方手册，[git-update-ref](https://git-scm.com/docs/git-update-ref)。用于旧值比较和引用事务。
12. Marcelo Sousa、Isil Dillig、Shuvendu Lahiri，2018，[Verifying Semantic Conflict-Freedom in Three-Way Program Merges](https://arxiv.org/abs/1802.06551)。用于语义与文本无冲突的区别。
13. Alexey Svyatkovskiy 等，FSE 2022，[Program Merge Conflict Resolution via Neural Transformers](https://www.microsoft.com/en-us/research/wp-content/uploads/2022/09/mergebert-fse22-camera-ready.pdf)。使用正式论文版本，不混用早期摘要数字。
14. Benedikt Schesch、Michael D. Ernst，2026-05-25，预印本 v1，[Merge-Bench](https://arxiv.org/html/2605.25890v1)。用于公开冲突基准与评测边界。
15. Bowen Shen，2026-07-30，预印本 v1，[Can Large Language Models Resolve Real Java Merge Conflicts?](https://arxiv.org/html/2607.27674v1)。用于生成—验证—重试与多维评测。
16. Léuson Da Silva 等，2023 预印本及关联 2024 JSS 发表，[Detecting Semantic Conflicts with Unit Tests](https://arxiv.org/abs/2310.02395)。用于测试作为局部行为规格。
17. Microsoft Learn，持续维护文档，[Structure of a SpreadsheetML document](https://learn.microsoft.com/en-us/office/open-xml/spreadsheet/structure-of-a-spreadsheetml-document)。用于 Excel 容器结构。
18. Git LFS 项目，持续维护规范，[Git LFS Specification](https://raw.githubusercontent.com/git-lfs/git-lfs/main/docs/spec.md)。用于指针、对象和物化模型。
19. Syncthing，持续维护规范，[Block Exchange Protocol v1](https://docs.syncthing.net/specs/bep-v1.html)。用于内容块与增量索引。
20. Git 项目，官方手册，[partial-clone](https://git-scm.com/docs/partial-clone)。用于按需获取对象。
21. Git 项目，官方手册，[git-sparse-checkout](https://git-scm.com/docs/git-sparse-checkout)。用于缩小本地检出范围。
22. Figma，2025 工程文章，[Canvas, Meet Code: Building Figma’s Code Layers](https://www.figma.com/blog/building-figmas-code-layers/)。用于不同数据类型的协同模型取舍。
23. Geoffrey Litt、Sarah Lim、Martin Kleppmann、Peter van Hardenberg，CSCW 2022，[Peritext: A CRDT for Collaborative Rich Text Editing](https://www.inkandswitch.com/peritext/)。网页 2021 初稿链接到正式 2022 论文；用于富文本意图与收敛边界。
24. Ink & Switch，2024 研究笔记，[Patchwork: Version control for everything](https://www.inkandswitch.com/patchwork/notebook/2024-version-control/)。用于版本控制进入普通创作工具的设计方向。
