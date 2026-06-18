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

### Phase 2 — 执行器接 @playwright/mcp（待办）

真 API→浏览器回退、a11y 健壮定位、trace 审计；退役自研 ops。

### Phase 3 — 智能探索 + 覆盖率评审（待办）

Claude 经 MCP 走 a11y 树系统遍历，loop-until-dry；测试环境受控写学真实写 API（配 CDP/HAR 捕获）。

### Phase 4 — 编译成确定性代码 + 自愈 + 语义路由 + 注册表 diff（待办）

codegen 确定性脚本、偏差时模型自愈；embedding 语义路由；契约注册表 + 重学 diff 检测漂移。

## 诚实的硬墙

1. 没公布契约 + 纯 SPA + 大量写操作的系统，仍靠探索+测试环境受控写，覆盖是概率性的。
2. 鉴权时效（SSO 过期、每请求 CSRF）是 operate 阶段真正的运维墙，需会话保活/刷新，无银弹。
3. HAR 推断永远是样本级——L1 契约发现能拿到多少，直接决定上限。
