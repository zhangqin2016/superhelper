# 网站学习能力 · 顶级改造方案

Date: 2026-06-19
Status: Phase 1 已落地；Phase 2–4 待办

目标：用户学到一个 web/OA/ERP/CRM 系统的**全部功能 + API + 数据结构**，生成的技能
**确实落盘存下来**、且**运行时 AI 用得明白**，从而能快速准确地通过平台直接操作该系统。

核心范式转变：从「正则静态扫描器 + 转录式生成器 + 单薄执行器」→「**模型驱动的智能探索 +
确定性深度捕获 + 可验证的编译式技能**」。让 Claude 当探索者/理解者，成熟工具当
记录仪/校验器/执行器。全程零付费依赖（Playwright、@playwright/mcp 均 Apache-2.0 免费开源）。

## 站在巨人肩膀上（成熟方案映射）

| 土办法 | 巨人 | 解决 |
|---|---|---|
| 正则爬 DOM | 可访问性树 / ARIA snapshot | 语义化、ref 稳定、模型可读 |
| 自研 scan/execute 脚本 | **@playwright/mcp**（微软官方，免费） | 官方维护的 a11y 浏览器工具，模型直接驱动 |
| 被动 requestfinished + 截断 | **CDP Network / HAR 全量录制** | 抓全请求（含 ws）+ 完整请求响应 |
| 自创 shape 推断 | **JSON Schema 推断 + OpenAPI 3.1** | 真实类型/枚举/必填 |
| 关键词路由 | **embedding 语义路由** | NL→能力 准确直达 |
| 一次性 trace | **Playwright Trace + codegen** | 录制即重放、可审计、可编译成确定性代码 |

最高层认知：**优先消费系统自己公布的契约（authoritative），逆向（DOM/HAR）只补其未覆盖部分。**

## 目标管线（6 段）

1. **范围与鉴权**：域名白名单、交互登录、生产只读（保留现有安全模型）。持久化 storageState。
2. **L1 契约发现**（authoritative）：探测 OpenAPI/Swagger/GraphQL（OData/WSDL 待加），拿权威 API + 数据结构。
3. **L2 智能探索**：Claude 经 @playwright/mcp 走 a11y 树，覆盖率评审 loop-until-dry；生产只读，测试环境受控写。
4. **L3 确定性捕获**：CDP/HAR 录全量网络（补 L1 未覆盖、学写路径 API），脱敏后落盘。
5. **编译 + 自验证**：合并成 OpenAPI 3.1 + capability-map + playbook；重放只读探针 + schema 校验，给覆盖率/置信度；未过=草稿。
6. **执行**：有契约走 schema 校验 HTTP（api-first）；缺失/失效**真回退** @playwright/mcp 浏览器；
   编译成确定性脚本、偏差时模型自愈；持久审计（trace + 追加日志）；写操作回滚钩子；契约注册表 + 重学 diff。

## 产物契约（硬性，回应两个顾虑）

- **「别学到了没存下来」**：学到的一切（OpenAPI 契约、数据 schema、capability-map、选择器、
  playbook、覆盖率/置信度）全部落盘成稳定文件进技能包；每次写 change-log + health，可 diff。
- **「用的时候 AI 用不明白」**：SKILL.md 是给模型的运行手册（渐进披露：先查 capability-map →
  命中走 API 并校验输入 → 缺失回退浏览器 → 失败自愈）；动作是结构化可执行步骤；参数带 schema
  校验；结果带 resultSchema；路由有语义索引；未过自验证标草稿。

## 阶段进度

### Phase 1 — L1 契约发现 + 落盘 + 接入生成器 ✅（本次）

- 新增 `scripts/discover_contracts.cjs`：探测并规范化 **OpenAPI 3.x / Swagger 2.0 / GraphQL
  introspection** → 带真实 JSON Schema（类型/枚举/必填）+ 可复用 dataSchemas 的权威契约
  `api-contracts.json`。$ref 解析、密钥脱敏、域名白名单、storageState 复用会话、只读探测、dry-run。
- `create_web_system_skill.cjs` 接入 `--contracts`：权威契约**优先于**推断契约（按 endpoint+method
  去重）；`resultSchema` 用契约响应 schema 填；枚举参数从契约 enum 生成；`api-contracts.json`
  **落盘进技能包**；api-map.json 带 schema + dataSchemas + 来源；discover_contracts.cjs 随技能分发。
- SKILL.md 学习流程改为「契约发现先行」。
- 测试：`scripts/test-web-system-contract-discovery.cjs`（33，规范化纯函数）+
  `scripts/test-web-system-contract-integration.mjs`（15，端到端：学到→存下来→AI 用得明白）。

价值：任何带 Swagger/GraphQL 的系统，一条 introspection / 一个 swagger.json 即可直接拿到**全量
API + 数据结构**，立刻逼近「学到所有 API/数据结构」目标，且权威优先、不被样本推断污染。

### Phase 2 — 执行器兑现契约 ✅（本次）

`execute_web_playbook.cjs` 关闭审计发现的执行器缺口（重构出 `executeOperation` /
`runOperationList` 复用执行）：

- **真 API→浏览器回退**：`plan.fallbackOperations`（浏览器路径）在主路径（通常 API）失败/
  stale 时自动执行（401/403/404/状态不符/定位失败），不再硬停。
- **回滚**：`plan.rollbackOperations` 在写操作已改动状态后失败时 best-effort 执行补偿。
- **stale 主动检测**：API 返回 401/403/404 即判 stale；失败结果带 `stale`/`staleSignal`/
  `relearnRecommended`，驱动重学而非盲目重试。
- **持久审计**：`--audit-log` 把每步追加成脱敏 JSONL（含验证、回退、回滚阶段）。
- 三条执行路径（主/回退/回滚）共用同一套风险上限 + 域名白名单校验。

测试：`scripts/test-web-system-executor-contract.mjs`（9，dry-run 校验契约面 + 审计）。
注：真浏览器回退/回滚的执行路径需真实浏览器，属手工集成验证（套件用 dry-run）。

注：完整改用 @playwright/mcp（a11y 工具集）是更大的运行时/配置迁移（需在 CLI 注册 MCP
server + 打包），作为后续独立项；本阶段先让现有执行器兑现契约。

### Phase 2b — @playwright/mcp：可用即用（本次，MCP-ready）✅／全量打包（不建议，按需）

诚实判断：把 @playwright/mcp **强行打包进生产 app + 改全局 MCP 配置**，在 Phase 2（执行器硬化）
+ 4c（编译确定性脚本）之后**没有用户可感知的新能力**，却引入全应用风险、且套件无法测——
不符合"最顶级"。最顶级恰恰包括"不为零收益加风险"。

本次落地为 **MCP-ready**：SKILL.md 新增「Browser Engine」——若会话已注册 @playwright/mcp，
则探索/即席操作优先用其 a11y 工具，验证过的可重复流程仍走确定性执行器/编译脚本；未注册则
全部照常走确定性路径（增强项，非必需）。零新增依赖、零 app 配置改动、零风险。

**决策更新（内置）**：改为**完全内置**浏览器运行时（node + playwright + @playwright/mcp +
Chromium），不按需下载——用户机器可能没有 Chrome。app 侧接线已实现并门控（`mcp-config.js` /
`bundle-locator.bundleRuntimeDir` / `_spawn` 加 `--mcp-config` / `spawn-env` 注入
NODE_PATH+PLAYWRIGHT_BROWSERS_PATH），**bundle 未到位时全部 no-op、对现有构建零影响**
（`test-mcp-config.mjs`，16）。构建侧（把 node/playwright/mcp/chromium 真正打进 bundle，
每平台 +150–300MB）是发布工程，规格见 `docs/playwright-builtin-plan.md`，由构建机执行验证。

### Phase 3a — 探索/覆盖率协议 ✅（本次，SKILL.md，模型驱动）

SKILL.md 新增「Coverage Completeness」：像 QA 工程师系统遍历（菜单/标签/列表/筛选/详情/
对话框/分页），每轮自问「还有什么没看到」并再跑前台扫描，连续无新增才停；权威契约定 API/
数据结构上限，UI 扫描补 UI-only 流程；health.json 诚实记录覆盖与缺口（有缺口=草稿）。

### Phase 3b — 从真实流量学 API（含写路径）✅（本次，核心可测）

补 Phase 1 的另一半：**没公布契约的系统**和**写路径 API**。

- 新增 `har_to_contracts.cjs`：解析 Playwright HAR，按 method+endpoint 分组，从样本**合并推断
  JSON Schema**（类型/枚举/必填/可空）、脱敏、allowlist；与 `api-contracts.json` 合并时
  **权威契约永不被覆盖**，HAR 只填空。推断核心是纯函数、完全可测
  （`test-web-system-har-contracts.mjs`，20）。
- `scan_web_system.py` 加 `--har-path`：用 Playwright `record_har_path`+`record_har_content`
  录全量流量（含 body）。这一步是浏览器代码（手工集成验证）。
- SKILL.md 流程加 HAR 学习步骤；写路径只在确认的测试环境里 exercise 才会被捕获。
- a11y snapshot 推迟到 4c（自愈）——那里才有消费者，现在加是过度设计。

### Phase 4a — 契约注册表 + 重学 diff ✅（本次）

新增 `diff_contracts.cjs`：比对新旧 `api-contracts.json`，报告 added/removed/changed 的
endpoint 与 dataSchema，标记 `breaking`（删除/风险升级/必填字段丢失）→ 依赖能力需重验。
纯 cjs、完全可测（`test-web-system-contract-diff.mjs`，15）。随技能分发；SKILL.md 加重学 diff 步骤。

### Phase 4b — 路由协议（模型即路由器）✅（本次，SKILL.md）

**不引入 embedding 基础设施**——Claude CLI 本就在回路里、读 capability-map 即可按语义精准
路由，比余弦相似更灵活。SKILL.md 新增「Natural-Language Routing」：读 capability-map 按意图
匹配、歧义时定向追问、缺必填参数先问、无匹配则提议重学不臆造。embedding 检索预筛仅在
「能力多到塞不进上下文」时作为规模优化，带明确触发条件，现在不做。

### Phase 5 — 浏览器免启的 API 执行（本次）✅ + 持久登录（待办）

修正用户实测痛点"问个问题开好多次浏览器"。根因：执行器**无条件 `chromium.launch()`**、
连 API 也走浏览器上下文；且**没有"登录一次持久复用"机制**。

- ✅ `execute_web_playbook.cjs`：**全 API 的计划走纯 HTTP（node fetch）+ 复用会话 cookie，
  零浏览器**（`planNeedsBrowser`/`runApiOnly`/`execApiRequestHttp`/`cookieHeaderFor`）；只有含
  浏览器动作、或 API 失败且声明了浏览器 fallback 时才开浏览器。顺带修掉"没装 playwright 时
  API 动作也失败"。测试 `test-web-system-api-execution.mjs`（8，对真实本地 server，验证零浏览器
  + 404→relearn）。
- ⏳ **持久登录（待办，需登录捕获 UI）**：开一次 headful 浏览器让用户登录 → 抓 storageState 存到
  按系统区分的固定位置（如 `userData/web-sessions/<systemId>.json`）→ 之后 scan/discover/execute
  全部 `--storage-state` 复用，只有 401/403 过期才重登。执行器/发现器已支持传入 storageState 复用；
  缺的是"捕获并持久化"那一步（浏览器+应用 UI）。

### Phase 4c — 编译成确定性代码 + 定位韧性 ✅（本次，codegen 可测）

- 新增 `compile_playbook.cjs`：把已验证的 plan **codegen 成独立的确定性 Playwright 脚本**——
  重放零模型、快、稳、可复现，且把域名白名单 + 禁凭据头**内联**进生成脚本。codegen 是纯函数、
  完全可测（`test-web-system-compile-playbook.mjs`，13；含生成脚本语法有效性校验）。随技能分发。
- 定位韧性：执行器本就多候选定位（selector→testId→role→label→placeholder→text），即一种自愈；
  硬失败报 `relearnRecommended`。**真·a11y 自动自愈（运行中无模型重定位）** 需 a11y 捕获 + 模型，
  属浏览器项，留作后续；当前由"多候选定位 + 重学循环（Phase 2/4a）"覆盖大部分场景。

## 诚实的硬墙

1. 没公布契约 + 纯 SPA + 大量写操作的系统，仍靠探索+测试环境受控写，覆盖是概率性的。
2. 鉴权时效（SSO 过期、每请求 CSRF）是 operate 阶段真正的运维墙，需会话保活/刷新，无银弹。
3. HAR 推断永远是样本级——L1 契约发现能拿到多少，直接决定上限。
