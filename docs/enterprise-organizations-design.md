# 企业组织（Enterprise Organizations）设计

> 状态：**草稿待评审**
> 作者：首席架构师
> 日期：2026-08-03
> 关联：`server/migrations/022_account_wallet.sql`、`services/wallet.js`、`services/account-auth.js`、`memory/config-delivery-scopes.md`

## 1. 背景与目标

平台目前有：个人账号体系（手机号 SMS 登录）、个人钱包/计量体系（`wallet_grants` + `usage_events`）、平台管理后台（`admin_users` + admin 路由）、配置分发体系（global/group/license/device 四层）。

业务诉求：**把能力卖给企业。企业可以管理自己的账户和用户，配置 token 使用量。**

目标（可验收）：
1. 企业（组织）作为一级实体存在，有管理员能自助管理。
2. 企业管理员可以添加/移除/停用成员，设置成员角色。
3. 企业管理员可以配置 token 额度：组织池 + 成员配额。
4. 成员的模型消耗：先扣个人额度，个人不足时扣企业池；企业池按请求实时强制（消费入口通过 `x-lily-organization-id` 传递组织上下文，见 §6 第 5 点）。
5. 企业管理员可以查看本企业用量（按成员、按模型）。

非目标（本期不做，避免范围膨胀）：
- 企业级 SSO/SCIM、审计报表导出、企业专属模型配置下发（`config profile` 的 `organization` scope）——留到二期。
- 桌面客户端"企业工作台"——桌面端本期只做"当前组织选择/切换"最小交互（§8.1），完整管理页面走 web 版（§7.2）。

## 2. 现状盘点（证据）

| 资产 | 位置 | 可复用度 |
|---|---|---|
| 用户账号 + 三套 token | `migrations/022`、`services/account-auth.js` | ✅ 企业管理员登录直接复用 |
| 个人钱包 grant/计量 | `services/wallet.js`、`usage_events` | ✅ 扩展出组织维度 |
| 定价/限额规则 | `feature_pricing_rules`、`services/billing.js` | ✅ 不动 |
| 席位概念 | `licenses.seats` | ⚠️ 本期不启用，二期接套餐 |
| 配置档位组 | `config_groups` + `config-delivery-scopes` | ⚠️ 二期把企业绑定到 group |

关键现状结论：**系统是按"个人用户"设计的，缺"组织"实体、缺"用户↔组织"归属、缺"组织级额度"、缺"企业管理员 API"四块。**

## 3. 对标参考：Claude Code 顶级做法

来源：`https://code.claude.com/docs/zh-CN/costs`（官方，2026-08 核实）。

顶级方案 = 三种计费模型 + 三层控制面 + **请求路径实时强制**：

1. **座位/额度分等级**：Standard/Premium 席位，额度在滚动 5 小时 + 每周窗口重置。
2. **三层支出限制**：组织级 → 组级 → 个人成员级；gateway 用 Admin API 设"每开发者按天/周/月上限"，**每次请求实时执行**。
3. **管理员可观测**：每用户+每模型支出报告（CSV 导出）、DAU/会话分析、Analytics API。
4. **成员角色**（国内对标阿里云百炼 Token Plan）：所有者 → 管理员 → 成员。
5. **超额可续**：额度不够不是硬截止，而是可购买"使用额度"续用。

本项目对齐：1 采用组织池（对应组织额度）；2 采用"组织池 + 成员配额"两层（组级本期不做，schema 预留）；3 复用 `usage_events` 加 `organization_id`；4 采用 owner/admin/member 三角色；5 复用 `products`/`orders` 充值链路（本期只做接口，不做支付）。

## 4. 设计决策（含默认值与理由）

| # | 决策点 | 默认值 | 理由 | 可逆性 |
|---|---|---|---|---|
| D1 | 用户可否属于多个企业 | **可以**（独立成员表） | 现实中一人多企业；表设计多企业不加列，单企业是子集 | 高可逆 |
| D2 | 额度模型 | **组织池 + 成员配额** | 组织管理员充池（先到先得），可对成员设上限；比"按人头分配"灵活 | 高可逆 |
| D3 | 消耗顺序 | **先个人、后组织池** | 不破坏现有个人 grant 语义；组织池是兜底 | 高可逆 |
| D4 | 企业管理员认证 | **复用 web session（SMS 登录 + cookie）** | 与现有账号体系一致，零新增认证面 | 高可逆 |
| D5 | 企业模型配置下发 | 二期（绑定 config group） | 本期聚焦账户+配额闭环 | 低可逆，故不做 |

## 5. 数据模型（Migration 028）

```sql
-- 企业组织
create table if not exists organizations (
  id text primary key,
  name text not null,
  status text not null default 'active',          -- active | disabled
  plan text not null default 'standard',          -- 预留套餐位（对齐 entitlements 等级）
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 成员关系（多对多；允许一人多企业）
create table if not exists organization_members (
  organization_id text not null references organizations(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  role text not null default 'member',            -- owner | admin | member
  status text not null default 'active',          -- active | disabled
  quota integer,                                  -- 成员配额上限（单位=unit，null=不限）
  joined_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);
create index if not exists organization_members_user_idx on organization_members (user_id);

-- 组织级额度池（复用个人 grant 结构；organization_id 为空 = 个人 grant）
alter table wallet_grants add column if not exists organization_id text;
create index if not exists wallet_grants_org_idx on wallet_grants (organization_id, status, expires_at);

-- 用量归属组织（计量查询维度）
alter table usage_events add column if not exists organization_id text;
create index if not exists usage_events_org_idx on usage_events (organization_id, created_at desc);
```

要点：
- **不破坏现有行**：所有新列可空，个人 grant 的 `organization_id IS NULL` 语义不变。
- **user_id 约束约定**：`wallet_grants.user_id` 是 `not null`（022:123），组织 grant 行必须填值——约定 **组织 grant 的 `user_id` = 组织创建者(owner) id，`organization_id` = 组织 id**；`wallet_ledger.user_id` 仍填**实际消费成员 id**（ledger 语义是"谁消费了"）。
- **fetchUserGrants 必须过滤组织 grant**：现有 `fetchUserGrants(userId)` 按 `user_id` 查（wallet.js:198-206），若不过滤会把组织 grant 混入个人消耗——**改查询加 `organization_id IS NULL`**。旧行无此列、可空默认 null，因此现有个体用户查询结果逐字节不变（Phase 1 回归测试锁死）。
- **成员配额**：`organization_members.quota`（成员维度，单位=unit，null=不限）——表示该成员从组织池消耗的上限，与 API 层 `PATCH members {memberQuota?}` 一致（见 §6 第 3 点、§7、§8）。
- 组织不直接外键到 license，避免迁移期 license 数据问题；二期通过 `licenses.group_id` / 组织绑定打通套餐。

## 6. 消耗链路扩展（不翻车原则）

现有 `consumeEntitlement(userId, …)` 内部：`fetchUserGrants(userId)` → `selectGrantsForConsumption(个人 grants)` → 扣个人 grant。

扩展策略（保持现有调用完全不变）：

1. **`selectGrantsForConsumption` 纯函数不动**（含失败返回形状：失败只返回 `availableUnits`，不返回部分 debits——见 wallet.js:148-156）。
2. `consumeEntitlement` 增加可选参数 `organizationId`：
   - 先按现有逻辑选个人 grant；成功则照旧（不触碰组织池）。
   - 若 `ok:false / ENTITLEMENT_INSUFFICIENT` 且有 `organizationId`，**整单转组织池**：查组织 grant（`organization_id = orgId AND status='active' AND 有效期`）按 `selectGrantsForConsumption` 同一逻辑重新选择。**不做"个人扣一半+组织补一半"**——因为纯函数失败时不返回部分 debits，混合扣减需要改纯函数签名，违反原则 1。
   - 组织 grant 查询必须同时校验：**`organizations.status='active'` 且 `organization_members.status='active'`**（企业停用/成员停用即不可消耗，不依赖停用时批量改 grant 状态，避免同步窗口）。
   - 组织和个人的扣减都写 `wallet_ledger`，`source_type='usage'`，`usage_events.organization_id` 一并记录。
3. **成员配额**（`organization_members.quota`，可选，单位=unit，null=不限）：成员从组织池消耗时，**单次扣减不得超过该成员配额**（超额返回 `ENTITLEMENT_INSUFFICIENT`；配额不跨请求累计，二期再按窗口累计）。个人 grant 不受影响。配额是**成员维度**（同一组织池内不同成员可有不同上限），与数据模型 §5、API 层 §7 `PATCH members {memberQuota?}` 一致。
4. 无 `organizationId` 的调用方（现有个体用户路径）行为与今天**逐字节一致**。
5. **组织上下文传递机制（消费入口 = `model-gateway.js` / `media-gateway.js`，本环节是"企业池实时强制"能否落地的关键）**：
   - 消费入口只有两个 gateway，它们调用 `consumeEntitlement` 时不带组织参数；token 里也没有组织字段（`usage.js:65 gatewayAccountRequired` 只认 `licenseId`/`userId`/`trialEndsAt`）。
   - 因此新增可选请求头 **`x-lily-organization-id`**（与现有 `x-lily-idempotency-key` 同构，见 `model-gateway.js:150`）：客户端在 `/llm/*` 及 media 请求带上当前组织 id；gateway 读取后透传给 `consumeEntitlement({ organizationId })`。
   - 服务端校验（在 gateway 内、调用 `consumeEntitlement` 前）：header 有值时，`userId` 必须是该组织的 **active 成员**（`organization_members.status='active'`）且组织 **active**（`organizations.status='active'`）——不是则返回 `403 ORG_FORBIDDEN`（**不静默回退个人**，否则企业额度被绕过）；header 无值时走个人路径，行为与今天一致。
   - 客户端侧：桌面端（Electron）登录后调 `GET /api/enterprise/organizations` 取组织列表，用户选择"当前组织"（可切换/可清空=回到个人），本地持久化后随模型请求带上 `x-lily-organization-id`。
   - 该机制保证：**不传组织 = 今天行为（fail-open）；传了无效组织 = 明确 403（fail-close），防止绕过企业额度。**

这条链路是"钱"的路径，必须先有单元测试锁定（见 §9）。

## 7. API 契约（企业管理员 API）

认证：复用 `requireWebAccount`（`lily_user_session` cookie）+ 新辅助函数 `requireOrgRole(organizationId, role)`：
- `owner` 可：全部操作（含角色变更、移除）。
- `admin` 可：成员添加/移除、配额配置、用量查看（不可改 owner 角色、不可移除 owner）。
- `member` 可：查看自己的组织与用量。
- 角色校验失败返回 `403 ORG_FORBIDDEN`；非成员返回 `403 ORG_MEMBER_REQUIRED`；组织不存在 `404 ORG_NOT_FOUND`。

消费侧 header（非本组 API，供 gateway 使用，见 §6 第 5 点）：`x-lily-organization-id` —— 桌面客户端 `/llm/*` 及 media 请求可选携带，gateway 校验成员身份后透传给 `consumeEntitlement`。无该 header 的请求行为与今天完全一致。

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/enterprise/organizations` | 登录用户 | 我所在的组织列表 |
| POST | `/api/enterprise/organizations` | 登录用户 | 创建组织，创建者为 owner |
| GET | `/api/enterprise/organizations/:id` | 成员 | 组织详情（含额度汇总） |
| PATCH | `/api/enterprise/organizations/:id` | owner/admin | 改名/停用 |
| GET | `/api/enterprise/organizations/:id/members` | 成员 | 成员列表（含角色/状态/用量） |
| POST | `/api/enterprise/organizations/:id/members` | owner/admin | 添加成员 `{userId 或 phoneE164, role}` |
| PATCH | `/api/enterprise/organizations/:id/members/:userId` | owner/admin | 改角色 / 停用 / 启用 / 设成员配额 `{role?, status?, memberQuota?}` |
| DELETE | `/api/enterprise/organizations/:id/members/:userId` | owner/admin | 移除成员（owner 不可移除自己） |
| GET | `/api/enterprise/organizations/:id/grants` | owner/admin | 组织额度池列表（含调拨记录） |
| POST | `/api/enterprise/organizations/:id/grants` | owner/admin | 给组织充值 `{resourceType, unitTotal, expiresDays}` —— **二期**（本期充值走平台 admin 调拨，§7.1/§10 定论 2） |
| GET | `/api/enterprise/organizations/:id/usage` | owner/admin | 组织用量：按成员 / 按模型汇总（`usage_events`） |

新模块：`server/src/routes/enterprise.js`，在 `public.js` 注册（走用户 web session 认证，不进 admin 的 `assertAdmin`）。OpenAPI tag：`public:enterprise`。

## 7.1 平台 admin 企业治理 API（admin 可以管理企业）

认证：走现有 admin 认证（`assertAdmin` + `lily_admin_session`），与 `routes/admin/*` 一致。职责边界：**平台 admin 只管"开关、额度、审计"三件事；企业内的角色与成员增删仍归企业 owner/admin**（admin 不改成员、不替企业充值到个人）。

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/admin/enterprise/organizations` | admin | 企业列表（含额度汇总、成员数、状态） |
| GET | `/api/admin/enterprise/organizations/:id` | admin | 企业详情（含额度池明细） |
| PATCH | `/api/admin/enterprise/organizations/:id` | admin | 停用/启用企业（停用即全员不可消耗组织池，成员个人 grant 不受影响） |
| POST | `/api/admin/enterprise/organizations/:id/grants` | admin | 平台侧调拨额度 `{resourceType, unitTotal, expiresDays}`（解决开放问题 2 的"内部调拨"） |
| GET | `/api/admin/enterprise/organizations/:id/usage` | admin | 跨企业用量审计（按企业/成员/模型汇总 `usage_events`） |

边界与安全：
- 平台 admin **不**能直接操作 `organization_members`（不改角色、不删成员）——防止 admin 越权进入企业内政。
- admin 停用企业 ≠ 删除：`organizations.status='disabled'` 后组织 grant 消耗被过滤（与成员停用同机制），数据保留可回溯。
- 调拨写 `wallet_ledger`，`source_type='admin_adjustment'`（与个人钱包 admin 调拨同语义），并写 `audit_logs`（actor=adminId, action=enterprise_grant_adjust）。
- 新增 `server/src/routes/admin/enterprise.js`，在 `admin.js` 注册；OpenAPI tag：`admin:enterprise`。

## 7.2 企业管理工作台（web 版）页面设计

企业管理员（owner/admin）的**管理入口**：web 站点 `/account/enterprise/*`，复用现有账号区（`web/app/account/`）登录态（`lily_user_session` cookie）+ `lib/user-api.js` 封装（与 `account/billing` 同模式）。**不做**独立的登录体系——企业管理员就是平台的 web 用户，登录后进入组织管理。

页面结构（owner/admin 可见，member 无管理页面、仅见只读组织页）：

| 路由 | 页面 | 数据来源（§7 API） | 可操作 |
|---|---|---|---|
| `/account/enterprise` | 组织列表 | `GET /organizations` | 创建组织、进入详情 |
| `/account/enterprise/[id]` | 组织概览 | `GET /organizations/:id` + `GET /usage` | 额度汇总、本月用量趋势 |
| `/account/enterprise/[id]/members` | 成员管理 | `GET /members` | 添加/移除成员、改角色、停用/启用、设成员配额（owner/admin） |
| `/account/enterprise/[id]/grants` | 额度配置 | `GET /grants` | 查看组织池、展示管理员调拨记录（调拨本身在 admin 端 §7.1） |
| `/account/enterprise/[id]/usage` | 用量报表 | `GET /usage` | 按成员、按模型汇总；表格 + 简单图表 |

页面设计要点（复用现有 web 模式，不引入新框架）：
- **路由与布局**：`web/app/account/enterprise/` 下新建页面，`layout.js` 复用账号区顶部导航（增加"企业"入口，owner/admin 登录后显示）；样式沿用 `slate` 配色与 `table-card` 卡片（对齐 `account/*`、`admin/usage` 现有组件）。
- **服务端组件直连 API**：每个页面为 Next.js 服务端组件，用 `userApiGet(path, fallback)` 拉数据（对齐 `account/billing/page.js` 模式）；写操作用 `userApiPost/Patch/Delete`（对齐 `lib/user-api.js`）。
- **权限分级渲染**：页面内按 `requireOrgRole` 语义控制按钮——owner 可改角色/移除 owner；admin 不可改 owner；member 看不到管理按钮。服务端 API 仍是唯一强制点，前端仅控制可见性。
- **空态与错误态**：非成员访问 → 提示"无权访问本组织"；组织停用 → 提示"组织已停用，联系平台"；空组织列表 → 引导创建。
- **与桌面客户端的关系**：web 页面是管理入口；桌面端只消费（选组织 + 用额度）。两者共用同一套 §7 API 与 `x-lily-organization-id` 语义，无重复逻辑。
- **平台 admin 治理页面**（`web/app/admin/enterprise/`，对应 §7.1）：企业列表、停用/启用、调拨额度、用量审计——复用 `admin/usage` 的 `AdminShell` + `safeApiGet` 模式，与现有 admin 后台同风格。

## 8. 权限与安全边界

- 所有 `/api/enterprise/*` 请求先过 `requireWebAccount`，再按组织成员身份二次校验——**不能**只凭登录就算数。
- 成员只能看/操作自己的组织；跨组织访问一律 403。
- 添加成员时 `userId` 和 `phoneE164` 都校验：`phoneE164` 不存在则创建用户（复用 `registerPublicAuthRoutes` 的建号路径语义），避免"幽灵成员"。
- 停用成员 ≠ 删除用户：成员 `status=disabled` 后，其消耗链路不再命中组织池（`consumeEntitlement` 里按成员状态过滤）。
- 成员配额（`memberQuota`）只影响该成员从组织池消耗的上限，**不影响其个人 grant**；`memberQuota=null` 表示不设限。
- 审计：写 `audit_logs`（actor=userId, action=enterprise_*），与 admin 审计同表。
- 消费侧边界：`x-lily-organization-id` 只由 gateway 读取，**不得**接受客户端自报身份之外的越权——gateway 必须用 token 里的 `userId` 校验成员身份，header 只是"选哪个组织"的指示，不是身份凭证。
- 平台 admin 走 `assertAdmin`，只经 `/api/admin/enterprise/*` 治理端点（§7.1），**不**进入 `/api/enterprise/*` 成员语义；企业内角色变更、成员增删归企业 owner/admin。

## 8.1 客户端（Electron）改动设计

客户端（桌面应用）是"企业池实时强制"链路的起点：用户选组织 → 请求带 `x-lily-organization-id` → gateway 校验并扣组织池。本期客户端只做**最小改动**（不加企业工作台页面——完整管理页面在 web 版 §7.2）：

| 改动点 | 位置 | 内容 |
|---|---|---|
| 组织列表获取 | `src/main/service-client.js` | 新增 `fetchOrganizations(accessToken)` → `GET /api/enterprise/organizations`（复用现有服务 API 客户端封装，同 `fetchAccountEntitlements` 模式） |
| 当前组织持久化 | `src/main/account-manager.js` | 状态里新增 `currentOrganizationId`（可空）：登录后拉组织列表；用户选择后写入 `statePath()` 持久化；登出/切换账号时清空（`clearAccount`） |
| 模型请求注入 | `src/main/runtime/opencode-model-config.js` | 模型请求头构造处（`options.headers`，第 185 行附近）读取 `currentOrganizationId`，非空则注入 `x-lily-organization-id` header；为空则不注入（行为与今天一致） |
| 设置 UI | `src/renderer/modules/account-settings.js`（及 `account-menu.js`） | 账号设置区新增"当前组织"下拉：选项 = 组织列表 + "不使用企业额度（个人）"；切换即持久化；未登录/无组织时隐藏或置灰 |
| i18n | `src/renderer/i18n/` | 新增组织选择相关文案（跟随现有 locale 文件结构） |

客户端行为约定：
- **默认个人**：登录后不强制选组织；未选/清空 = 走个人路径，与今天逐字节一致（fail-open，不误伤）。
- **切换即生效**：`currentOrganizationId` 变更后，下一次模型请求立即生效（无需重启）。
- **无组织场景**：用户不属于任何组织时，下拉为空或隐藏，客户端不带 header。
- **组织停用/成员被移除**：服务端返回 `403 ORG_FORBIDDEN` → 客户端收到后提示"企业额度不可用"，并**自动清空** `currentOrganizationId` 回退个人路径（避免持续报错）。
- 客户端改动不触碰聊天/会话/技能等主流程，风险面小。

## 9. 实施计划（分阶段，每阶段有验证门）

**Phase 1 — 数据 + 纯逻辑（不依赖 DB 运行即可验证）**
- [ ] `server/migrations/028_enterprise_organizations.sql`
- [ ] `services/enterprise.js`：角色常量、成员状态机、`requireOrgRole` 判定纯函数
- [ ] `services/wallet.js`：
  - [ ] `fetchUserGrants` 加 `organization_id IS NULL` 过滤（回归：现有个体查询逐字节不变）
  - [ ] `consumeEntitlement` 组织池补充（可选的 `organizationId`：个人不足整单转组织池；组织/成员状态过滤；成员配额 `organization_members.quota` 单次上限）
- 验证门：`scripts/test-enterprise-orgs.mjs` —— 纯函数单测（成员状态机、配额选择逻辑、组织池补充、**fetchUserGrants 过滤回归**、成员配额、现有个人路径回归）。

**Phase 2 — API 层**
- [ ] `routes/enterprise.js` + `public.js` 注册 + OpenAPI tag
- [ ] `routes/admin/enterprise.js` + `admin.js` 注册（§7.1 治理端点）
- [ ] `db.js` 相关查询（组织/成员/用量汇总）
- [ ] `services/model-gateway.js` / `services/media-gateway.js`：读取 `x-lily-organization-id`，校验成员+组织 active（`403 ORG_FORBIDDEN`），透传 `consumeEntitlement({ organizationId })`；无 header 走原路径（回归）
- [ ] `services/wallet.js`：新增 `resolveOrgForConsumption(userId, organizationId)` 查询辅助（成员+组织状态校验纯逻辑）
- 验证门：server 起本地 Postgres（`server/scripts/integration.mjs` 模式）跑接口冒烟；无 DB 时至少 `node --check` + OpenAPI 枚举测试（`registerRoutes` 不需要 DB 的 `buildDocApp` 路径）。gateway 改动用单测覆盖"有 header 无效组织 403 / 无 header 原路径"。

**Phase 3 — 客户端（Electron）接入**
- [ ] `src/main/service-client.js`：`fetchOrganizations`
- [ ] `src/main/account-manager.js`：`currentOrganizationId` 状态 + 持久化 + 登出清空
- [ ] `src/main/runtime/opencode-model-config.js`：请求头注入 `x-lily-organization-id`（空则不带，回归：无组织行为与今天一致）
- [ ] `src/renderer/modules/account-settings.js`：组织下拉 UI + 403 自动清空回退
- 验证门：`npm run test:unit`（客户端套件不回退）；手工验证——登录→选组织→请求带 header→改组织→清空→回个人；无组织用户看不到下拉。

**Phase 4 — web 企业管理工作台（§7.2）**
- [ ] `web/app/account/enterprise/`：组织列表 + 概览 + 成员管理 + 额度配置 + 用量报表页面（`lib/user-api.js` 模式）
- [ ] `web/app/account/layout.js`：导航加"企业"入口（owner/admin 登录后显示）
- [ ] `web/app/admin/enterprise/`：平台 admin 治理页面（`AdminShell` + `safeApiGet` 模式）
- [ ] i18n 文案（`web/lib/i18n.mjs` 现有结构）
- 验证门：`npm run web:dev` 起站 + 浏览器实测——owner/admin 登录后进入管理页、成员增删改、配额查看、用量报表；member 看不到管理按钮；非成员 403 提示。

**Phase 5 — 回归 + 交付**
- [ ] `npm run test:unit`（客户端套件不回退）
- [ ] migration 在 `deploy/baota` 部署路径执行（`server/scripts/migrate.mjs`）
- [ ] 客户端 + 服务端 + web 联调：选组织→扣企业池全链路 + 管理页操作闭环
- 验证门：全部测试通过；文档更新 `memory/`（新笔记：enterprise-organizations）。

## 10. 风险与开放问题

| 风险 | 影响 | 缓解 |
|---|---|---|
| `consumeEntitlement` 改动波及现有扣费 | 个人用户余额扣错 | 纯函数先行 + 回归测试锁死；无 orgId 路径不改一行逻辑 |
| `fetchUserGrants` 不过滤组织 grant | 组织池 grant 被误当个人 grant 消耗 | 查询加 `organization_id IS NULL` + 回归测试（§5） |
| 组织池并发扣减 | 超扣/负余额 | 沿用现有 `unit_remaining >= units` 条件更新（原子），与个人 grant 同机制 |
| 成员配额误伤个人 grant | 成员额度扣错 | 配额只作用于组织池消耗路径；个人 grant 路径零改动（§6 第 3 点） |
| 多企业归属下"先扣哪个企业池" | 用户同时在多组织 | 客户端显式传 `x-lily-organization-id`（用户选当前组织，可切换）；gateway 校验成员身份，杜绝串池 |
| 企业成员伪造/误传组织 header | 越权消耗别家额度 | gateway 校验 `organization_members.status='active'` + `organizations.status='active'`，无效即 `403 ORG_FORBIDDEN`（fail-close） |
| 客户端忘传组织 header | 企业池永不消耗（目标 4 落空） | 客户端登录后默认拉起组织选择；服务端无 header 走个人（fail-open，不误伤现有用户）；运营侧靠用量审计发现"企业成员却个人消耗"的异常 |
| 组织停用/成员被移除后客户端残留组织选择 | 持续 403，用户困惑 | 客户端收到 `403 ORG_FORBIDDEN` 自动清空 `currentOrganizationId` 回退个人（§8.1） |
| 客户端改 header 注入点破坏现有模型请求 | 所有用户模型请求异常 | 注入逻辑"空值不带 header"默认分支 + `npm run test:unit` 回归；header 与 `x-lily-idempotency-key` 同构，风险模式已知 |
| 企业管理员身份冒充 | 越权 | `requireWebAccount` + `requireOrgRole` 双层校验 + 审计日志 |
| web 管理页权限只做前端隐藏 | 越权操作 | 前端隐藏只是体验层，**服务端 API 的 `requireOrgRole` 是唯一强制点**（§8）；页面开发不得依赖前端过滤替代服务端校验 |
| 迁移在存量库执行 | 现有 grant 不受影响 | 全部 `add column if not exists` 可空列，幂等 |

已定论事项（不再作为开放问题）：
1. **组织池成员可见性**：组织池额度只对 owner/admin 可见；member 只见自己的用量与成员配额。
2. **充值路径**：本期只做内部调拨——由 §7.1 平台 admin 调拨端点承担（`source_type='admin_adjustment'`）；真实支付（`products/orders` 对组织开放）二期。

## 附：已核实的事实来源

- Claude Code 官方成本/团队管理：https://code.claude.com/docs/zh-CN/costs
- Claude Code 文档索引（gateway spend limits）：https://code.claude.com/docs/llms.txt
- 阿里云百炼 Token Plan 团队管理（角色模型对标）：https://help.aliyun.com/document_detail/3029021.html
