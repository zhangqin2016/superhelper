# 服务端、管理后台与官网设计文档

> 状态：第一版设计稿  
> 产品：Lily Workbench / 智能工作台  
> 目标：用轻量服务端支撑 License 颁发、设备激活、使用量统计、版本更新、插件管理、管理后台和官网推广。  

## 0. 第一版实现对照

截至当前实现，第一版按下面状态收敛：

| 模块 | 文档要求 | 当前状态 |
| --- | --- | --- |
| License 颁发 | 新建、hash 入库、一次性明文 key | 已实现 |
| License 激活 | 设备绑定、过期、禁用、seat 限制 | 已实现 |
| License 管理动作 | 禁用、恢复 | 已实现 |
| License 详情编辑 | 客户名、套餐、席位、过期、功能、状态 | 已实现 |
| 设备管理 | 注册、最后活跃、绑定 License | 已实现 |
| 设备管理动作 | 禁用/恢复绑定、解绑 | 已实现 |
| 使用统计 | 聚合消息、图片、工具、插件、token | 已实现 |
| 使用统计筛选 | days、license、device、model | 已实现 |
| Dashboard | License、设备、今日消息、token、模型、趋势 | 已实现 |
| Release 管理 | 新增版本、启用/禁用、强制更新、size、下载元数据 | 已实现 |
| Plugin 管理 | 新增插件、启用/禁用、manifest 下发 | 已实现 |
| 客户端插件安装 | 服务端 registry、客户端检查/安装/启用 | 已实现：skill 类型闭环 |
| 官网 | 首页、下载、价格、文档、动态更新日志、联系页、移动导航 | 已实现 |
| 下载页 | 从 Release API 读取真实下载元数据 | 已实现 |
| 后台登录 | Token 登录、HttpOnly cookie、API 验证 | 已实现 |
| 客户端接服务端 | 服务端激活、设备码、用量上报、更新检查、插件 registry | 已实现 |
| 安全收口 | API 限流、管理动作审计日志、隐私最小化 | 已实现 |
| 自动化验证 | Web build、主单测、Server smoke、PG 集成测试、CI workflow | 已实现 |

第一版刻意未做：

- 多管理员账号和角色权限。
- 支付、订单、发票。
- 聊天内容、截图内容、文件内容采集。
- 复杂灰度发布。
- MCP/Tool 类型的运行时安装。当前完整安装闭环先支持 `type=skill` 的插件包。
  MCP/Tool 类型当前作为市场目录元数据展示，待运行时安装器独立设计后再开放自动安装。

## 1. 目标

第一版只做必要能力：

- License 颁发、激活、设备绑定。
- 按设备统计使用量、模型使用量和功能调用量。
- 管理版本更新信息，安装包继续放七牛云。
- 管理插件市场列表，插件包继续放七牛云。
- 提供管理后台页面，方便查看和操作。
- 提供官网页面，方便产品推广和下载安装。

第一版不做：

- 用户系统和复杂组织架构。
- 支付、发票、订单。
- 聊天内容留存。
- 文件、截图、完整本地路径采集。
- 复杂灰度发布和复杂权限矩阵。

## 2. 技术选型

### 2.1 后端

| 模块 | 选型 | 原因 |
| --- | --- | --- |
| Runtime | Node.js 20+ | 与桌面客户端、现有发布脚本同生态 |
| Web Server | Fastify | 轻量、性能好、插件成熟 |
| Database | PostgreSQL | 已有 PG，可靠且便于统计 |
| SQL | Kysely | 类型友好，SQL 可控，不引入重型 ORM |
| Validation | Zod | 请求响应校验清晰 |
| Auth | Admin Token + Session Cookie | 第一版足够简单 |
| Deploy | Docker 或 PM2 | 都能低成本部署 |

### 2.2 管理后台和官网

推荐：

```text
Next.js + shadcn/ui + Tailwind CSS + TanStack Table + Recharts
```

原因：

- `shadcn/ui` 是当前最流行的 React UI 方案之一，适合做高级感管理后台。
- `Tailwind CSS` 开发速度快，和 shadcn/ui 配合成熟。
- `TanStack Table` 适合 License、设备、使用统计等表格。
- `Recharts` 足够完成第一版趋势图、柱状图、饼图。
- `Next.js` 可以同时承载官网和管理后台。

第一版页面结构：

```text
web/
  app/
    (site)/              # 官网
    admin/               # 管理后台
  components/
  lib/
server/
  src/
```

也可以先放在一个服务里：

```text
/api/*       Fastify API
/admin/*     管理后台
/            官网
```

如果希望后续扩展更清晰，建议前后端分开：

```text
server/      Fastify API
web/         Next.js 官网 + 管理后台
```

### 2.3 第一版后台登录

第一版不做完整账号体系，采用轻量管理入口：

- Fastify API 通过 `ADMIN_TOKEN` 保护 `/api/admin/*`。
- Next 管理后台优先读取服务端环境变量 `ADMIN_TOKEN` 调用 API。
- 如果 Web 进程没有配置 `ADMIN_TOKEN`，管理员可以访问 `/admin/login` 输入 API token。
- 登录页会先调用 `/api/admin/summary` 验证 token，验证成功后写入 HttpOnly cookie。
- 第一版已经记录管理动作审计日志；后续如果需要多人协作，再扩展为管理员账号和角色权限。

## 3. 总体架构

```mermaid
flowchart LR
  Client["桌面客户端"] --> API["Fastify API"]
  Admin["管理后台 Next.js"] --> API
  Site["官网 Next.js"] --> API
  API --> PG["PostgreSQL"]
  API --> Qiniu["七牛云 CDN / 对象存储"]

  API --> License["License 管理"]
  API --> Device["设备管理"]
  API --> Usage["使用统计"]
  API --> Release["版本更新"]
  API --> Plugin["插件管理"]
```

## 4. 隐私原则

不采集：

- 用户问题内容。
- AI 回复内容。
- 文件内容。
- 截图内容。
- 完整本地路径。
- 系统用户名。
- 硬件序列号明文。

允许采集：

- `device_id`
- `license_id`
- `platform`
- `arch`
- `app_version`
- `model`
- 消息次数
- 图片次数
- 工具调用次数
- 插件调用次数
- 输入 token 数
- 输出 token 数
- 最后活跃时间
- 错误码和状态码

设备指纹只保存 hash，不保存原始值。

## 5. 核心业务对象

### 5.1 License

License 是授权主体。

字段：

- license id
- license key hash
- 客户名称
- 套餐
- seats 数
- 过期时间
- 状态
- 功能列表

License key 不明文入库，只保存 hash。

### 5.2 Device

Device 是客户端设备。

字段：

- device id
- fingerprint hash
- platform
- arch
- app version
- first seen
- last seen

客户端首次启动生成 `device_id` 并本地保存。

### 5.3 License Device

License 和设备绑定关系。

用途：

- 控制 seats。
- 查看某个 license 激活了哪些设备。
- 单独禁用某台设备。

### 5.4 Usage

Usage 只保存聚合统计，不保存内容。

聚合维度：

```text
date + license_id + device_id + model
```

统计项：

- message count
- image count
- tool call count
- plugin call count
- input tokens
- output tokens

### 5.5 Release

版本更新记录。

安装包仍放七牛云，服务端只保存元数据：

- version
- platform
- url
- sha256
- notes
- force update
- enabled

### 5.6 Plugin

插件市场记录。

插件包仍放七牛云，服务端只保存：

- plugin id
- name
- version
- type
- description
- manifest url
- sha256
- enabled

## 6. 数据库设计

### 6.1 licenses

```sql
create table licenses (
  id text primary key,
  license_key_hash text not null unique,
  customer_name text,
  plan text not null default 'pro',
  seats integer not null default 1,
  expires_at timestamptz not null,
  status text not null default 'active',
  features jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

### 6.2 devices

```sql
create table devices (
  id text primary key,
  fingerprint_hash text,
  platform text,
  arch text,
  app_version text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
```

### 6.3 license_devices

```sql
create table license_devices (
  id text primary key,
  license_id text not null references licenses(id),
  device_id text not null references devices(id),
  activated_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  status text not null default 'active',
  unique (license_id, device_id)
);
```

### 6.4 usage_daily

```sql
create table usage_daily (
  id bigserial primary key,
  usage_date date not null,
  license_id text,
  device_id text not null references devices(id),
  model text not null,
  message_count integer not null default 0,
  image_count integer not null default 0,
  tool_call_count integer not null default 0,
  plugin_call_count integer not null default 0,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (usage_date, device_id, model)
);
```

### 6.5 releases

```sql
create table releases (
  id text primary key,
  version text not null,
  platform text not null,
  url text not null,
  sha256 text not null,
  notes text,
  force_update boolean not null default false,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique (version, platform)
);
```

### 6.6 plugins

```sql
create table plugins (
  id text primary key,
  name text not null,
  version text not null,
  type text not null,
  description text,
  manifest_url text not null,
  sha256 text,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

### 6.7 admin_users

第一版可以只做一个管理员账号。

```sql
create table admin_users (
  id text primary key,
  email text not null unique,
  password_hash text not null,
  role text not null default 'admin',
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);
```

如果想更轻，也可以先不用账号密码，只用 `ADMIN_TOKEN`。但既然第一版要有页面，建议做管理员登录。

## 7. API 设计

### 7.1 设备注册

```http
POST /api/devices/register
```

请求：

```json
{
  "deviceId": "dev_xxx",
  "fingerprintHash": "hash_xxx",
  "platform": "darwin",
  "arch": "arm64",
  "appVersion": "0.1.5"
}
```

响应：

```json
{
  "ok": true
}
```

### 7.2 License 激活

```http
POST /api/licenses/activate
```

请求：

```json
{
  "licenseKey": "LILY-XXXX-XXXX-XXXX",
  "deviceId": "dev_xxx",
  "fingerprintHash": "hash_xxx",
  "platform": "darwin",
  "arch": "arm64",
  "appVersion": "0.1.5"
}
```

响应：

```json
{
  "ok": true,
  "license": {
    "licenseId": "lic_xxx",
    "deviceId": "dev_xxx",
    "plan": "pro",
    "features": ["updates", "plugins"],
    "expiresAt": "2027-06-02T00:00:00Z",
    "signature": "base64_signature"
  }
}
```

错误码：

```text
LICENSE_NOT_FOUND
LICENSE_EXPIRED
LICENSE_DISABLED
SEAT_LIMIT_REACHED
DEVICE_DISABLED
```

### 7.3 使用量上报

```http
POST /api/usage/report
```

请求：

```json
{
  "deviceId": "dev_xxx",
  "licenseId": "lic_xxx",
  "date": "2026-06-02",
  "model": "claude-sonnet-4",
  "messageCount": 12,
  "imageCount": 2,
  "toolCallCount": 5,
  "pluginCallCount": 1,
  "inputTokens": 10000,
  "outputTokens": 3000
}
```

响应：

```json
{
  "ok": true
}
```

### 7.4 查询最新版本

```http
GET /api/releases/latest?platform=darwin-arm64&version=0.1.4
```

响应：

```json
{
  "hasUpdate": true,
  "version": "0.1.5",
  "platform": "darwin-arm64",
  "url": "https://qny.lanrensoft.cn/app/updates/...",
  "sha256": "...",
  "notes": "修复图片识别和更新检查",
  "force": false
}
```

### 7.5 插件列表

```http
GET /api/plugins
```

### 7.6 技能插件 Registry

```http
GET /api/plugins/registry
```

该接口输出桌面客户端现有技能安装器可消费的 registry 协议：

```json
{
  "schemaVersion": 1,
  "publisher": "Lily Workbench",
  "skills": [
    {
      "id": "weather",
      "name": "Weather",
      "latestVersion": "1.0.0",
      "sourceType": "zip",
      "downloadUrl": "https://qny.lanrensoft.cn/plugins/weather/weather-1.0.0.skillpack.zip",
      "sha256": "..."
    }
  ]
}
```

第一版安装闭环：

```text
管理后台新增 type=skill 插件
  -> 填写 skillpack zip URL 和 SHA256
  -> /api/plugins/registry 输出 registry
  -> 客户端技能中心保存 registry URL
  -> 检查更新
  -> 安装 / 更新
  -> 启用技能
  -> 新会话自动注入技能说明
```

安全约束沿用客户端现有技能安装器：

- 下载包大小限制。
- SHA256 校验。
- zip slip 防护。
- 禁止包内包含 `node_modules`。
- 校验 `skill.manifest.json` 的 id 和 version。

响应：

```json
{
  "plugins": [
    {
      "id": "weather",
      "name": "Weather",
      "version": "1.0.0",
      "type": "mcp",
      "description": "天气查询",
      "manifestUrl": "https://qny.lanrensoft.cn/plugins/weather/manifest.json",
      "sha256": "...",
      "enabled": true
    }
  ]
}
```

## 8. 管理后台设计

### 8.1 页面结构

```text
/admin/login
/admin
/admin/licenses
/admin/licenses/new
/admin/licenses/[id]
/admin/devices
/admin/usage
/admin/releases
/admin/releases/new
/admin/plugins
/admin/plugins/new
/admin/settings
```

### 8.2 登录页

功能：

- 管理员邮箱和密码登录。
- 登录后写 HttpOnly session cookie。
- 第一版不做多角色。

### 8.3 Dashboard

指标卡：

- 总 License 数。
- 有效 License 数。
- 激活设备数。
- 今日活跃设备数。
- 今日消息数。
- 今日 token 数。

图表：

- 最近 30 天消息趋势。
- 最近 30 天活跃设备趋势。
- 模型使用占比。

### 8.4 License 管理

列表字段：

- 客户名称。
- License ID。
- Plan。
- Seats 使用量。
- 过期时间。
- 状态。
- 创建时间。

操作：

- 新建 License。
- 禁用 License。
- 延长有效期。
- 调整 seats。
- 查看绑定设备。

新建 License 表单：

- 客户名称。
- Plan。
- Seats。
- 过期时间。
- Features。

提交后显示一次性 license key。服务端不保存明文 key。

### 8.5 设备管理

列表字段：

- Device ID。
- License。
- Platform。
- Arch。
- App version。
- First seen。
- Last seen。
- 状态。

操作：

- 禁用设备。
- 解除 License 绑定。
- 查看设备使用统计。

### 8.6 使用统计

筛选：

- 日期范围。
- License。
- Device。
- Model。

展示：

- 消息数。
- 图片数。
- 工具调用数。
- 插件调用数。
- 输入 token。
- 输出 token。
- 模型占比。

不展示用户对话内容。

### 8.7 版本更新管理

列表字段：

- Version。
- Platform。
- URL。
- SHA256。
- Enabled。
- Force update。
- Created at。

操作：

- 新增版本。
- 启用/禁用版本。
- 设置强制更新。

平台枚举：

```text
darwin-arm64
win32-x64
```

第一版 Mac 只发 `darwin-arm64`。

### 8.8 插件管理

列表字段：

- Plugin ID。
- Name。
- Version。
- Type。
- Manifest URL。
- Enabled。

操作：

- 新增插件。
- 启用/禁用插件。
- 更新版本和 manifest URL。

插件类型：

```text
mcp
skill
tool
```

第一版支持 `skill` 类型插件从服务端 registry 安装、更新和启用。
`mcp` / `tool` 类型第一版先做元数据下发，运行时安装和权限审批后续扩展。

## 9. 官网设计

官网目标不是简单介绍产品，而是让访问者第一眼感到这是一个成熟、可信、面向团队交付的 AI 工作平台。

设计关键词：

```text
Enterprise AI
Developer Workbench
Operational Control
Polished Desktop Product
```

视觉感受：

- 像 Linear、Raycast、Vercel、Notion Calendar 这类成熟工具一样克制、锋利、可信。
- 不做低质 AI 感渐变大字报。
- 不做花哨营销页堆卡片。
- 必须展示真实产品界面，产品本身是第一视觉主角。
- 文案短、硬、专业，避免“让工作更简单”这类泛泛表达。

### 9.1 页面结构

```text
/
/download
/pricing
/docs
/changelog
/contact
```

### 9.2 视觉系统

#### 9.2.1 色彩

主色不要大面积紫蓝渐变，避免常见 AI 模板感。推荐使用冷静的企业科技色：

```text
Background dark:    #080A0D
Surface dark:       #11161C
Surface elevated:   #171D25
Text primary:       #F5F7FA
Text secondary:     #9AA4B2
Border:             #26313D
Brand teal:         #1F7A8C
Brand cyan:         #4CC9F0
Success:            #4ADE80
Warning:            #F59E0B
Danger:             #EF4444
Light background:   #F7F9FC
Light surface:      #FFFFFF
```

使用比例：

```text
70% 深色中性背景
20% 白色/浅色内容区域
7% 品牌青蓝
3% 状态色
```

官网首页首屏建议使用深色，但下载、文档、价格页可以使用浅色，避免全站单一暗黑。

#### 9.2.2 字体

推荐：

```text
英文: Inter 或 Geist Sans
中文: system-ui, PingFang SC, Microsoft YaHei
代码/数字: JetBrains Mono 或 Geist Mono
```

字号：

```text
Hero H1: 64px desktop / 40px mobile
Section H2: 40px desktop / 30px mobile
Card title: 18px
Body: 16px
Caption: 13px
```

要求：

- 不使用负 letter-spacing。
- 英文和数字指标可以用 mono，增强专业感。
- 中文正文保持清晰，不要过细。

#### 9.2.3 圆角和阴影

```text
Large panel radius: 16px
Card radius: 10px
Button radius: 8px
Input radius: 8px
```

阴影要轻：

```text
0 24px 80px rgba(0, 0, 0, 0.28)
0 1px 0 rgba(255,255,255,0.06) inset
```

不要使用漂浮光球、bokeh、随机渐变 blob。

#### 9.2.4 图标

使用：

```text
lucide-react
```

图标风格：

- 线性。
- 统一 18px / 20px / 24px。
- 不混用填充风格图标。

### 9.3 首页

#### 9.3.1 首屏 Hero

目标：第一屏就让用户知道这是一个“企业级 AI 桌面工作台”，并看到真实产品能力。

布局：

```text
Top nav
Hero copy
Primary CTA
Product screenshot stage
Trust / metrics strip
Next section peeking below fold
```

首屏必须使用真实产品截图或高保真产品 mock，不使用抽象插画。

推荐首屏结构：

```text
┌─────────────────────────────────────────────┐
│ Logo     Product  Plugins  Pricing  Docs    │
│                                  Download   │
├─────────────────────────────────────────────┤
│                                             │
│  AI workbench for teams that ship software. │
│  一个面向团队的 AI 桌面工作台。              │
│                                             │
│  [Download for Mac] [View demo]             │
│                                             │
│  ┌───────────────────────────────────────┐  │
│  │        真实应用截图 / 桌面窗口          │  │
│  │  工作区 + AI 会话 + 插件 + 更新状态     │  │
│  └───────────────────────────────────────┘  │
│                                             │
│  License control · Plugin marketplace ·     │
│  Device usage analytics · Secure updates    │
└─────────────────────────────────────────────┘
```

Hero 文案建议：

```text
H1:
Lily Workbench

Subtitle:
An AI desktop workbench for teams, plugins, releases, and licensed deployment.

中文辅助:
把 AI 会话、工作区、插件、版本更新和授权管理放进一个可控的桌面客户端。
```

按钮：

```text
Primary: Download for Mac
Secondary: View admin console
```

首屏底部指标：

```text
Local workspaces
Signed licenses
Plugin-ready
Mac / Windows
```

注意：

- H1 直接用产品名，不写空泛 slogan。
- 副标题承担价值说明。
- 首屏截图要足够大，桌面端宽度 960-1160px。
- 截图下方露出下一节 80-120px，页面不显得单薄。

#### 9.3.2 产品能力区

不要做一堆等宽营销卡片。采用“左侧能力导航 + 右侧产品截图/状态面板”的结构。

能力分组：

```text
Workspaces
Agent Chat
Plugin System
Release Control
License & Devices
Usage Analytics
```

每个能力点击切换右侧截图：

```text
左侧:
Workspace memory
每个工作区保存独立会话、目录和上下文。

右侧:
展示应用左侧工作区列表和聊天界面。
```

视觉：

- 左侧是紧凑列表，不用大卡片。
- 右侧是一个产品窗口，带轻微边框和真实截图。
- 当前能力用品牌青蓝竖条或浅色背景标识。

#### 9.3.3 管理后台展示区

官网需要展示“我们不仅是客户端，还有可管理能力”。

模块标题：

```text
Control deployment from one console.
```

展示内容：

- License 列表。
- 设备激活数。
- 使用模型统计。
- Release 配置。
- Plugin 开关。

布局：

```text
大图：后台 dashboard 截图
右侧：三个数字指标
  Active devices
  Messages today
  Model usage
```

这块要体现平台感，是“高大上”的关键。

#### 9.3.4 安全和隐私区

标题：

```text
Usage analytics without collecting conversations.
```

展示：

```text
Collected:
- device_id
- model
- message count
- token count

Never collected:
- prompt content
- response content
- screenshots
- files
```

视觉：

- 两列对比。
- 左列使用中性色。
- 右列使用绿色 check。
- 不要恐吓式安全文案。

#### 9.3.5 下载 CTA 区

底部 CTA 不要再堆大渐变。

结构：

```text
Ready to deploy your AI desktop workbench?
[Download Mac] [Contact for Team License]
```

背景可以用浅色，和首屏深色形成节奏。

### 9.4 官网导航

导航项：

```text
Product
Plugins
Admin
Pricing
Docs
Changelog
```

右侧按钮：

```text
Download
```

行为：

- 顶部透明，滚动后变半透明磨砂。
- 高度 72px desktop / 60px mobile。
- 移动端使用 Sheet 菜单。

### 9.5 下载页

展示：

- Mac Apple Silicon 下载。
- Windows x64 下载。
- 当前版本。
- 文件大小。
- SHA256。
- 更新日志入口。

下载地址从 `/api/releases/latest` 获取。

UI 细节：

```text
┌────────────────────────────┐
│ macOS Apple Silicon         │
│ Version 0.1.x · arm64       │
│ [Download .dmg]             │
│ SHA256 ...                  │
└────────────────────────────┘

┌────────────────────────────┐
│ Windows x64                 │
│ Version 0.1.x · x64         │
│ [Download .exe]             │
│ SHA256 ...                  │
└────────────────────────────┘
```

下载页可以更实用，不需要过多营销。

### 9.6 定价页

第一版不需要在线支付，只展示：

- Personal。
- Team。
- Enterprise。

按钮：

- 联系购买。
- 获取试用 License。

UI 细节：

- 三列价格表。
- Team 作为推荐项。
- Enterprise 不写价格，写 Contact us。
- 每个 plan 展示 seats、插件、更新、统计能力。

### 9.7 文档页

内容：

- 安装。
- 激活。
- 添加工作区。
- 插件管理。
- 常见问题。

UI 细节：

- 左侧文档导航。
- 右侧正文。
- 代码块使用深色背景。
- 页面宽度不要过宽，正文最大 860px。

### 9.8 更新日志

展示 release notes。

来源：

- 服务端 `releases` 表。

UI 细节：

- 时间线结构。
- 每个版本展示平台、下载链接、修复项。
- 支持筛选 `macOS` / `Windows`。

### 9.9 官网组件清单

使用 shadcn/ui 组件：

```text
Button
Card
Badge
Tabs
Table
Dialog
Sheet
DropdownMenu
Tooltip
Separator
```

自定义组件：

```text
ProductWindow
FeatureRail
MetricStrip
ReleaseDownloadCard
ModelUsageChart
PrivacyComparison
AdminConsolePreview
```

### 9.10 高级感验收标准

官网完成后必须满足：

- 第一屏能看到产品名和真实产品界面。
- 5 秒内能理解这是 AI 桌面工作台，不是普通聊天工具。
- 10 秒内能理解有 License、设备、更新、插件管理能力。
- 页面不能像通用 SaaS 模板。
- 不能使用抽象 AI 插画作为主视觉。
- 不能用大面积紫蓝渐变和漂浮光球。
- 所有 CTA 文案具体，不写“立即体验”这种空泛按钮。
- 移动端首屏不遮挡截图，标题和按钮不重叠。
- 首页 Lighthouse Performance 目标 90+。

## 10. License 签名

服务端持有私钥，客户端内置公钥。

签名 payload：

```json
{
  "licenseId": "lic_xxx",
  "deviceId": "dev_xxx",
  "plan": "pro",
  "features": ["updates", "plugins"],
  "expiresAt": "2027-06-02T00:00:00Z"
}
```

推荐算法：

```text
Ed25519
```

客户端校验：

- signature 有效。
- device id 一致。
- license 未过期。

## 11. 客户端接入

第一版客户端需要新增：

1. 首次启动生成并保存 `device_id`。
2. 启动时调用 `/api/devices/register`。
3. 激活时调用 `/api/licenses/activate`。
4. 保存服务端返回的 signed license。
5. 每小时或每天上报 `/api/usage/report`。
6. 更新检查从静态 latest.json 逐步切换到 `/api/releases/latest`。
7. 插件列表从本地配置逐步切换到 `/api/plugins`。

## 12. 安全策略

- License key 只存 hash。
- 服务端私钥只放环境变量或密钥管理系统。
- 管理后台使用 HTTPS。
- 管理登录使用 HttpOnly cookie。
- 接口限流。
- 服务端日志不打印 license key 明文。
- Usage 只收聚合计数。
- 不上传对话内容、文件内容、截图内容。

## 13. 部署配置

环境变量：

```env
PORT=3000
DATABASE_URL=postgres://user:pass@host:5432/lily
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=change-me
SESSION_SECRET=change-me
LICENSE_PRIVATE_KEY=...
LICENSE_PUBLIC_KEY=...
QINIU_PUBLIC_BASE_URL=https://qny.lanrensoft.cn
```

部署方式：

```text
Docker Compose
```

或：

```text
PM2 + Nginx + PostgreSQL
```

## 14. 第一版实施顺序

### 阶段 1：服务端基础

- Fastify 项目骨架。
- PostgreSQL 连接。
- Migration。
- Health check。

### 阶段 2：License 和设备

- 管理员登录。
- 新建 License 页面。
- License 激活 API。
- 设备注册 API。
- License 详情和设备列表。

### 阶段 3：使用统计

- Usage report API。
- Dashboard 指标卡。
- Usage 列表和图表。

### 阶段 4：版本更新

- Release 管理页面。
- Latest release API。
- 官网下载页接入。
- 客户端更新检查逐步切换到 API。

### 阶段 5：插件管理

- Plugin 管理页面。
- Plugin list API。
- 客户端插件市场逐步接入。

### 阶段 6：官网

- 首页。
- 下载页。
- 定价页。
- 文档页。
- 更新日志页。

## 15. 第一版成功标准

- 能通过页面创建 License。
- 客户端能用 License 激活。
- 后台能看到设备列表。
- 后台能看到设备和模型维度的使用量。
- 后台能配置最新版安装包。
- 官网能展示产品并提供下载。
- 全程不记录用户对话内容、文件内容、截图内容。
