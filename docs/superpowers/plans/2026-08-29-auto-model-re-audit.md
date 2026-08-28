# Auto / 手动模型选择：再次全链路审查

日期：2026-08-29

后续实施记录：`2026-08-29-auto-model-hardening.md`。本文保留修复前审查证据，
不代表下列问题仍全部待修；修复状态、最终测试及剩余发布边界以实施记录为准。

## 结论

上一轮七项修复的回归仍然通过，但不能据此认定产品完全闭环。本轮针对目录
生命周期、模型身份变化、任务续跑和异步交互发现了新的可复现问题。

汇总：13 项待修问题，3 项 P1、10 项 P2；包含新功能暴露出来的旧缺陷，
不等于这 13 项都由上一轮修改引入。均有源码依据或受控执行证据，但不声称
已经在客户安装包上复现。

本轮是审查，不修改产品实现、不提交、不推送、不部署。下列复现均使用真实
源码和受控边界替身，不调用付费模型，不接触客户会话。

## 已确认问题

### 1. P1：附件插话可能进入下一轮任务

位置：`src/main/turn-steer-runtime.js:30-55`。

- 触发：任务 A 正在运行，用户携带附件插话；图片识别或文档解析等待期间，
  A 结束，任务 B 使用同一会话状态和 runner 启动。
- 原因：归属快照在两次预处理 await 之后才捕获，读取的已是 B 的 turnId；
  识别证据也在确认归属之前写入当前 ledger。
- 结果：原本给 A 的补充内容、附件及证据进入 B，并作为 B 的成功插话入库。
- 方向：在第一个 await 前冻结任务归属，每次 await 后、证据写入和发送前
  验证同一 turnId/generation/runner；旧操作不得注入新任务。
- 验收：分别阻塞图片、文档预处理，期间结束 A 并启动 B；B 的输入、证据和
  历史保持不变，原插话按明确的失效/排队策略处理。

### 2. P1：目录过期时，手动选择提前失败，绕过自动配置修复

位置：`src/main/turn-orchestrator.js:738-755`；
`src/main/model-selection-catalog.js:49-64`。

- 触发：已保存手动模型 B，B 不是全局默认；签名配置或网关令牌过期。
- 原因：remote catalog 返回 null，缓存 public presets 仍可存在；B 因缺少
  raw env 被剔除。模型选择返回失败后直接退出，尚未进入配置刷新分支。
- 复现：返回 `INVALID_MODEL_SELECTION`，诊断调用次数 0，刷新调用次数 0。
- 影响：原本可自动续期的连接被误报成模型不可用，需用户手动打开/刷新目录。
- 方向：显式区分目录陈旧和模型撤销；陈旧时先去重刷新，再以原选择重试一次。
  刷新失败不能擅自换成别的模型。

### 3. P1：服务端改变默认模型，会改变已保存模型 ID 的含义

位置：`server/src/services/client-config.js:306-351`。

- 触发：同一供应商开放 A、B，用户手动保存 A；管理员把供应商默认改为 B。
- 原因：默认模型使用不含模型身份的裸 preset ID，其他模型才带后缀。
- 复现：同一个 `lily-managed:review-fixture:gateway` 原先指 A，之后指 B。
- 影响：下一轮手动选择可能静默变成 B；原 B 的带后缀 ID 又可能失效。
- 方向：模型 ID 始终包含稳定供应商身份与无损模型身份；默认仅是独立指针。
  旧裸 ID 需按原模型迁移，不能直接跟随新的默认。
- 相关风险：当前 `modelSlug` 会把不同的 `/`、`:` 等字符折成同一个 `_`，
  新身份方案也应避免这类碰撞。

### 4. P2：客户端全局默认切换，会让相同模型的恢复回执失效

位置：`src/main/model-selection-catalog.js:65-67`；
`src/main/turn-model-runtime.js:31-33`。

- 触发：原轮使用非默认 B，之后全局默认改为 B，再恢复原轮。
- 原因：非默认模型使用哈希 providerID，默认模型使用 `lily`/`anthropic`。
- 复现：同一 B、同一 endpoint，providerID 从 `lily-model-df7e70e5021544f4`
  变成 `lily`，恢复返回 `MODEL_SNAPSHOT_UNAVAILABLE`。
- 方向：供应商/连接标识不受默认状态影响；对已有回执提供可验证迁移。
  不能简单删除供应商校验，否则会失去防止真实连接替换的保护。

### 5. P2：后台任务完成后的续跑没有继承原轮模型

位置：`src/main/long-task/session-wakeup.js:31-45`。

- 触发：B 启动允许自动唤醒的后台任务；完成前会话模型偏好改为 A。
- 原因：唤醒提示文本包含 job.turnId，但发送参数没有 `sourceTurnId`；
  原轮模型回执无法参与选择。
- 复现：原轮 B，唤醒续跑选 A，发送参数 sourceTurnId 为空。
- 方向：后台续跑和普通恢复统一使用原任务的不可变执行来源，验证同一会话、
  所有者和原轮身份。新建的独立用户任务仍按最新偏好选择。
- 边界：默认禁止自动唤醒的任务不会触发此问题；本条针对允许唤醒的任务。

### 6. P2：明确停用全部模型后，推荐 Auto 仍走旧引擎回退

位置：`src/main/model-selection-catalog.js:122-124`。

- 触发：有效目录存在，但其中全部模型被明确标记 `enabled:false`。
- 原因：过滤后空集合与“目录获取不到”都被归为 `NO_MODEL_AVAILABLE`。
- 复现：公开模型数 0，路由却返回 `ok:true, model:null, reason:catalog_unavailable`，
  后续使用全局旧配置。是否最终被供应商拒绝取决于服务端授权，客户端未阻止。
- 方向：网络不可用的兼容回退，与明确停用/无授权的禁止执行必须分开。
  不应通过隐藏菜单项来代替执行层校验。

### 7. P2：异步发送失败会覆盖另一个会话的草稿

位置：`src/renderer/modules/composer.js:323-342`。

- 触发：A 等待模型加载/保存或发送响应，用户切到 B 输入草稿，随后 A 失败。
- 原因：两个错误分支直接恢复到全局 promptInput/pendingFiles，不检查活动会话。
- 结果：B 的草稿和附件被 A 的内容覆盖，可能造成误发。这是旧恢复逻辑缺陷，
  新增的选模 await 扩大了触发窗口。
- 方向：草稿、附件和角色创作标记均归属 session；只有目标仍在前台时更新 DOM，
  后台失败只恢复对应会话的草稿。
- 验收：覆盖异常拒绝和 `{ok:false}` 两个分支，确认 B 不变，A 可独立恢复。

### 8. P2：同一种目录故障，切换会话后从安全回退变成取消发送

位置：`src/renderer/modules/model-picker.js:202-213`。

- 触发：A 的模型快照读取尚未结束时切到 B，随后 A 的目录请求失败。
- 原因：当前会话分支返回已确认偏好或 null，后台会话分支则直接 throw。
- 结果：同一推荐 Auto 请求，留在 A 可以交给主进程处理，切到 B 却取消发送。
- 方向：统一快照读取失败契约，主进程依然是持久化偏好和执行校验的权威；
  显式手动/自选池仍不得被扩大或静默替换。

### 9. P2：后台压缩尚未完成时，旧引擎可能被回收

位置：`src/main/opencode-agent-session.js:647-657`；
`src/main/runtime/opencode-shared-server.js:514-521`。

- 原因：compactContext 的等待不占用 busy 或独立工作租约；引擎回收只看
  attached views，没有追踪尚未完成的 summarize。
- 受控复现：挂起 A 的 summarize，切换模型并释放 A 的 view，获取 B 时 A
  被终止，但 summarize 仍未完成。
- 影响：可能丢失本次压缩结果、浪费已发出的模型请求；不能据此断言所有
  Lily 独立管理的后台进程都会被杀，它们使用不同的生命周期。
- 方向：把前台 view 引用与实际工作租约分开；压缩、原生子任务完成或明确
  取消后才能释放对应执行配置。

### 10. P2：子代理和空闲压缩用量没有进入统一上报

位置：`src/main/opencode-agent-session.js:798-803`；
`src/main/opencode-subagent-runtime.js:170-195`。

- 原因：空闲事件在处理前被丢弃，子会话事件被分流到展示投影，不经过主轮的
  usage-reporter 调用。
- 受控复现：注入 120 input tokens 的压缩事件或子会话事件，上报均为 0；
  子会话的展示投影内可以看到 120。
- 影响：上一轮修好的“主轮按模型归属”不等于所有模型调用都已纳入统计。
  此处是客户端统计遗漏，不断言服务端网关计费也遗漏。
- 方向：用量核算独立于聊天气泡是否活动，绑定执行身份并按事件去重。

### 11. P2：同名模型的供应商维度在上报时丢失

位置：`src/main/usage-reporter.js:45-63`。

- 原因：pending Map 的 key 包含 providerID，但 record 没有保存 providerID，
  本地持久化和上报只剩 model 字符串。
- 受控复现：vendor_A/shared-name 和 vendor_B/shared-name 产生相同用量后，
  flush 输出两条无法区分来源的记录。
- 方向：供应商/连接身份需贯穿客户端记录、服务端契约和存储，而不只用于
  内存 Map 分桶；兼容旧客户端并明确历史未知供应商的统计口径。

### 12. P2：真实会话环境变量会抵消引擎共享

位置：`src/main/runtime/opencode-shared-server.js:492-505`；
`src/main/spawn-env.js:160-161`。

- 原因：完整 env 参与共享签名，但打包环境为每个会话设置不同的
  CLAUDE_CONFIG_DIR。相同模型配置也无法复用同一个签名。
- 受控复现：三个会话选择 A/B/A，携带各自真实形态的配置目录，得到三个
  server 对象，而不是两个；现有 A/B/A 测试没有包含目录差异。
- 影响：会话增多时启动更多引擎/MCP，不能声称已验证真实桌面上的跨会话复用。
- 方向：明确哪些环境属于进程配置，哪些属于会话请求。不能盲目忽略所有
  env 差异，否则又会混用密钥、代理或权限配置。

### 13. P2：正常模型切换产生未处理的启动 Promise 拒绝

位置：`src/main/opencode-agent-session.js:258-272,343-345`；
`src/main/turn-orchestrator.js:372-379`。

- 触发：已绑定 orchestrator 的空闲 runner，从模型 A 切换到 B。
- 原因：配置变化同步发出 invalidated 事件；监听器终止旧 runner 并清空
  spawnOptions。旧 ensureProcess 返回前仍调用 `void this._ensureStarted()`，
  产生未被接住的 `RUNNER_TERMINATED` 拒绝。
- 真实 host 调用链的受控复现捕获该 unhandledRejection；IPC 的后续恢复分支
  可以重建 B 并保留旧 resume ID，但不能消除已经发生的 Promise 拒绝。
- 影响：错误冒出启动生命周期之外；不同发行运行环境如何处理拒绝需安装包
  实测，不能只凭 Node 测试宣称客户端一定崩溃。
- 方向：配置切换应有明确的 runner 替换结果和统一 await/cancel 所有权，
  已撤销实例不再启动；不能仅靠全局吞掉 unhandledRejection 掩盖状态竞争。

## 非缺陷与实施边界

- 运行中改选 B 对下一轮生效；插话继续当前 A 是现有明确语义，不应为满足
  按钮显示而在已有工具副作用之后静默切换模型。
- 当前 Auto 是基于发布评级、工具能力、上下文估算的确定性路由，不是语义
  难度分类器。不能声称已经验证“所有简单问题自动省钱、复杂问题自动变强”。
- 真实供应商多轮调用、实际费用、发布安装包、重启恢复仍需独立验收。
- 模型连接恢复中的全局 live-env patch 当前对 OpenCode 返回 false，不会
  直接覆盖其他正在执行的会话模型；本轮没有把它误报成跨会话换模。
- 没有复现 SQLite 数据损坏或锁冲突，不将共享数据库本身判为缺陷。
- 已排除“正常切模型一定丢历史”：底层独立 runner 的确会清 resume，但真实
  `ensureSessionRunner + bindRunner + spawn:true` 恢复链保留了此前捕获的 ID。
  受控测试 A→B 后历史哨兵存在、SDK 新建会话次数为 0。此疑点不列入缺陷数，
  仅将同时发现的未处理拒绝单独记录为第 13 项。
- 启动中的 A 被并发 ensure(B) 替换可能产生配置错位，但尚未证明正常准入会
  允许该重叠，也不列入已确认缺陷数。

## 验证记录

- 本轮重新运行 `test-model-selection.mjs`、`test-model-execution.mjs`、
  `test-long-task-session-wakeup.mjs`、`test-model-picker-state.mjs`、
  `test-model-selection-ipc.mjs`、`test-usage-reporter-models.mjs`、
  `test-opencode-shared-server.mjs`、`test-model-execution-runner.mjs`，均通过。
- 这些现有测试通过的同时，新增受控复现仍能触发上述边界，说明覆盖矩阵有缺口。
- 模型身份、过期修复、停用回退和后台唤醒的复现入口：
  `/private/tmp/lily-auto-review-20260829.cjs`。脚本断言当前缺陷确实存在，
  返回成功不代表产品修复成功。
- 插话归属和草稿覆盖的独立复现入口：
  `/private/tmp/lily-model-review-repros.cjs`，已重跑图片/文档等待和两种发送失败
  共四个场景。脚本输出源码哈希与目标 turn/session，便于对照后续修复。
- 引擎生命周期复现入口：`/private/tmp/lily-runtime-review-repro.cjs`，已重跑真实
  host ensure/bind/env/event 链，验证历史保留、未处理拒绝、跨会话共享失效、
  压缩被回收和用量漏报；进程、SDK 传输和存储使用离线替身。
- 上一轮 `650/650` 是上一轮的全量回归结果，不冒充本轮重新执行的结果。

## 建议的修复顺序

1. 先收紧异步操作归属，避免跨任务注入和跨会话草稿覆盖。
2. 建立稳定模型身份及旧回执迁移，再统一普通发送、重试和后台唤醒的执行来源。
3. 明确目录的有效、过期、停用、无授权状态，修复刷新与回退顺序。
4. 加入上述交叉场景回归，再做真实供应商和安装包验收。
