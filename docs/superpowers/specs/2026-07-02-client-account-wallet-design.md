# Electron 客户端账号与充值权益设计

## 背景

Lily Workbench 现在的客户端授权以激活码为核心：用户在 Electron 设置页粘贴激活码，客户端把设备信息和激活码发给服务端，服务端验证 `licenses` 并写入 `license_devices`。这套模型适合企业授权、离线授权和席位管理，但不适合个人用户的充值购买、免费额度、token 包和按周期使用。

本方案新增一套个人账号与权益钱包模型：用户用阿里云短信验证码登录 Electron 客户端，充值后权益自动生效；免费额度、日卡、周卡、月卡、token 包、AI 图片次数、AI 视频次数统一进入服务端账本。现有激活码授权继续保留，作为企业或离线场景的兼容路径。

## 目标

1. 用户可以在 Electron 客户端用手机号验证码登录。
2. 新用户有一定免费额度，登录后自动可用。
3. 用户可以购买日卡、周卡、月卡、token 包、AI 图片生成包和 AI 视频生成包。
4. 支付成功后服务端自动发放权益，客户端刷新后立即可用。
5. 模型、图片、视频调用前服务端能判断是否可用，调用后按实际消耗扣减对应权益。
6. 现有激活码和企业 license 流程不被破坏。
7. 所有充值、赠送、消耗、退款都有可审计流水。
8. 官网、客户端、管理后台三端 UI 都有完整闭环，用户能从登录、购买、到账、使用、扣费、查看订单一路走通。

## 非目标

1. 第一版不实现复杂营销活动、优惠券、分销、团队账户和发票。
2. 第一版不把现有 `licenses` 表迁移成个人账号表。
3. 第一版不支持客户端离线消费 token；消费型权益必须在线校验。
4. 第一版不让客户端决定 token 消耗量，最终扣费以服务端网关统计为准。

## 核心判断

消费型计费必须由服务端掌握模型、图片、视频调用链路。只要客户端直接把真实供应商密钥拿去调用上游，服务端就无法可靠知道真实消耗，也无法防止篡改余额。因此个人充值体系应优先走现有/扩展后的 model gateway 和 media gateway：客户端向 Lily 服务端请求能力，服务端调用上游，拿到 usage 或生成结果后写入扣费流水。

现有 `licenses` 继续服务企业授权。个人用户的新入口不直接生成 license key，而是通过 `users`、`wallet_grants`、`wallet_ledger` 和 `user_sessions` 控制可用性。对客户端而言，`requireValidLicense()` 后续应演进为更通用的 `requireEntitlement()`：企业 license 有效或个人账号权益有效，任一满足即可放行。

## 产品规则

### 完整闭环定义

本项目的“完成”不是只把账号或支付 API 做出来，而是用户、运营和客服都能完成自己的闭环。

用户闭环：

1. 用户在官网或客户端输入手机号。
2. 用户收到阿里云短信验证码并完成登录。
3. 新用户自动获得免费 token、图片次数和视频次数。
4. 用户在客户端看到当前权益。
5. 用户点击客户端“购买/充值”，打开官网购买页。
6. 官网识别同一个账号，展示商品、价格、权益和支付方式。
7. 用户用支付宝或微信支付。
8. 服务端验签支付回调，核对金额，发放权益，写入账本。
9. 官网订单页显示支付成功和到账权益。
10. 客户端刷新后看到新权益。
11. 用户发起文本、图片或视频任务。
12. 服务端 gateway 在调用上游前校验权益和限额。
13. 调用成功后服务端扣减对应权益，写 usage event 和 ledger。
14. 客户端和官网权益页都能看到余额变化。
15. 权益不足时，客户端给出购买入口，不调用上游产生无法回收的成本。

运营闭环：

1. 管理员在后台配置日卡、周卡、月卡、token 包、图片包、视频包。
2. 管理员配置图片/视频按模型和规格的免费次数、单次价格、每日上限和并发上限。
3. 官网和客户端不发版即可读取最新商品和计价规则。
4. 管理员可以下架商品、调整价格、查看订单和支付回调。
5. 管理员可以查看账本流水，确认每一笔赠送、购买、消耗、退款。

客服/风控闭环：

1. 客服可以按手机号、订单号、设备 ID 查询用户。
2. 客服可以看到订单状态、权益到账、消耗流水和异常原因。
3. 管理员可以禁用用户、撤销 session、手工补偿权益。
4. 短信、支付、模型、图片和视频异常都有明确错误码和审计记录。

### 账号

手机号是第一版唯一登录身份。登录流程是发送验证码、校验验证码、签发会话。客户端主进程保存会话 token，renderer 只触发登录动作和展示状态，不直接持有敏感凭据。

同一个手机号可以登录多台设备。设备仍使用现有 `deviceId` 和设备签名能力，服务端记录 `user_devices` 关系，用于风控、用量分析和后续设备限制。

账号在官网和 Electron 客户端共用。用户可以在官网用短信验证码登录、购买商品；也可以在客户端用同一个手机号登录并自动同步权益。官网是购买和订单管理主入口，客户端是使用和权益展示入口。

### 官网购买与客户端同步

支付流程优先放在官网完成，类似 Codex 和 Claude Code 的账号订阅模式。Electron 客户端不直接嵌入支付宝或微信支付 SDK，而是打开官网购买页。

推荐交互：

1. 用户在 Electron 客户端打开“账号与授权”。
2. 未登录时，客户端展示手机号验证码登录。
3. 登录后，客户端展示当前 token 余额、图片剩余次数、视频剩余次数、会员状态和“购买/充值”按钮。
4. 用户点击“购买/充值”，客户端用系统浏览器打开官网 `/account/billing` 或带一次性登录跳转参数的购买页。
5. 用户在官网短信登录或通过已登录 Web session 进入购买页。
6. 用户选择日卡、周卡、月卡、token 包、图片包或视频包，用支付宝或微信支付。
7. 支付成功后，服务端写入订单、权益 grant 和账本流水。
8. 客户端通过轮询、手动刷新或服务端推送刷新权益，购买结果自动生效。

客户端不负责支付结果判定。客户端只相信服务端 `/api/account/entitlements` 返回的权益状态。

官网购买页需要支持：

- 手机号短信登录。
- 商品列表和价格展示。
- 支付宝支付。
- 微信支付。
- 订单状态页。
- 支付成功后的权益明细。
- 订单历史和发票/售后入口的预留位置。

客户端同步策略：

- 客户端启动时刷新权益。
- 客户端登录成功后刷新权益。
- 用户从购买页回到客户端时刷新权益。
- 用户点击“刷新权益”时刷新权益。
- 客户端收到余额不足时刷新权益后再决定是否提示购买。
- 支付后可以短轮询 2 分钟，每 3 秒查一次权益；超过 2 分钟仍未到账则提示用户在官网查看订单。

为了减少用户在官网重复登录，可以支持一次性购买跳转 token：

1. 客户端已登录时，向服务端请求 `POST /api/account/billing-link`。
2. 服务端签发 5 分钟有效、一次性使用的 `billingLinkToken`。
3. 客户端打开 `https://lily.lanrensoft.cn/account/billing?token=...`。
4. 官网校验 token 后创建 Web 登录态，并让 token 立即失效。

`billingLinkToken` 只能用于进入官网购买页，不能调用 API、不能支付、不能刷新客户端 token。支付仍然依赖官网 Web session 和服务端订单校验。

### 免费额度

新用户首次完成手机号登录后，服务端自动发放免费权益 grant。例如：

- grant 类型：`free_tokens`
- 数量：配置项控制，如 100000 tokens
- 有效期：配置项控制，如注册后 7 天
- 消耗顺序：先于购买 token 包消耗
- grant 类型：`free_image_generations`
- 数量：配置项控制，如 3 次图片生成
- grant 类型：`free_video_generations`
- 数量：配置项控制，如 1 次低规格视频生成

免费额度只发一次。服务端以用户维度记录，不以设备维度记录，避免换设备重复领取。

### 周期会员

日卡、周卡、月卡是时间权益，不是 token 余额。它们决定用户在有效期内可使用哪些能力，以及是否享有某些模型、技能或更高并发。

推荐第一版规则：

- 日卡：支付成功后从当前时间起有效 1 天。
- 周卡：支付成功后从当前时间起有效 7 天。
- 月卡：支付成功后从当前时间起有效 30 天。
- 同类周期权益可叠加延期。
- 周期会员到期不清空 token 包余额。

是否“会员期间不限量”不建议第一版支持。更稳妥的做法是会员只解锁使用资格或折扣，模型调用仍消耗 token 包或会员附赠额度，避免成本失控。

### Token 包

Token 包是可扣减余额。支付成功后生成一个购买 grant：

- grant 类型：`paid_tokens`
- 数量：商品配置决定
- 有效期：商品配置决定，可以是永久或 365 天
- 消耗顺序：按过期时间从近到远扣减

扣减必须幂等。每次模型调用需要有唯一 `usage_event_id`，重复上报或重试不得重复扣款。

### AI 图片和 AI 视频

AI 图片、AI 视频不建议折算成普通文本 token。它们成本更高、上游计价方式不同、滥用风险也更大，应按能力独立计量。

第一版规则：

- AI 图片按“张数”或“任务次数”扣减，具体规格由后台配置。
- AI 视频按“秒数、任务次数或规格档位”扣减，第一版建议按任务档位扣减，避免复杂计量。
- 每个用户有独立免费次数，免费次数用完后必须购买对应权益或按次付费。
- 图片和视频请求必须走服务端 media gateway，客户端不能直连上游供应商。
- 图片和视频需要单独设置每日上限、并发上限、失败退款策略和内容安全策略。

后台可配置示例：

- 免费图片生成：每人 3 次，有效期 7 天。
- 免费视频生成：每人 1 次，仅限低规格，有效期 7 天。
- 图片生成单次价格：按模型和规格配置，如普通图 1 次权益，高清图 2 次权益。
- 视频生成单次价格：按模型、时长和分辨率配置，如 5 秒低清 1 次权益，10 秒高清 4 次权益。

### 可用性判断

用户可使用的条件：

1. 企业激活码授权有效；或
2. 个人账号有有效周期会员；或
3. 个人账号还有当前能力对应的购买权益；或
4. 个人账号还有当前能力对应的未过期免费额度。

如果个人账号无余额且无有效会员，客户端展示充值入口或提示充值，不应让模型、图片、视频调用继续进入上游。不同能力分别判断：文本余额不能自动抵扣视频，除非后台明确配置了跨资源兑换规则。

### 扣费顺序

扣费顺序固定为：

1. 即将过期的免费 token
2. 即将过期的购买 token
3. 会员附赠 token（如果后续商品需要）

图片和视频也按同样原则先扣即将过期的免费权益，再扣购买权益。每次扣费写入 `wallet_ledger`，并关联 `usage_events`。如果调用失败且上游没有产生有效 usage 或生成结果，不扣费；如果上游已产生实际成本但响应中断，服务端仍以实际 usage 记账，并把结果标记为可追踪状态。

## 数据模型

### users

个人用户主表。

- `id`
- `phone_e164`
- `status`
- `created_at`
- `last_login_at`

`phone_e164` 唯一。手机号入库前统一标准化。

### sms_codes

短信验证码表。

- `id`
- `phone_e164`
- `code_hash`
- `purpose`
- `expires_at`
- `attempt_count`
- `consumed_at`
- `ip`
- `user_agent`
- `device_id`
- `risk_level`
- `risk_reason`
- `send_provider`
- `send_status`
- `created_at`

验证码只存 hash，不存明文。发送和验证都要限流。验证码表既服务登录，也服务风控审计：同一个手机号、IP、设备、IP 段、ASN 或异常地区在短时间内的发送记录都要能查到，避免短信成本被刷爆。

### sms_rate_limits

短信限流状态表。也可以第一版先用 Redis，但必须有等价的持久化审计能力。

- `bucket_key`: `phone:+86138...`、`ip:1.2.3.4`、`device:dev_xxx`、`prefix:+86138`
- `purpose`
- `window_started_at`
- `request_count`
- `blocked_until`
- `last_request_at`

限流不能只按手机号做。攻击者可以换手机号刷同一个 IP，也可以换 IP 刷同一个手机号，还可以用大量不存在的手机号制造短信成本。

### user_sessions

客户端登录态。

- `id`
- `user_id`
- `device_id`
- `refresh_token_hash`
- `refresh_token_version`
- `expires_at`
- `revoked_at`
- `revoked_reason`
- `created_at`
- `last_seen_at`

客户端保存明文 refresh token，服务端只存 hash。退出登录、风控封禁、用户改绑手机号或管理员撤销时，服务端写 `revoked_at` 使 refresh token 失效。

### access_tokens

短期服务接口 token 不落库，使用服务端 HMAC/JWT 签名即可。token payload 包含：

- `typ`: 固定为 `access`
- `sub`: 用户 ID
- `sid`: `user_sessions.id`
- `did`: 设备 ID
- `iat`
- `exp`
- `scope`: `account`、`billing`、`model_gateway`、`media_gateway`

access token 有效期建议 15 分钟。服务端校验签名、过期时间、session 是否撤销、设备 ID 是否匹配。access token 只用于请求服务接口，不作为长期登录凭据。

### user_devices

用户和设备关系。

- `user_id`
- `device_id`
- `first_seen_at`
- `last_seen_at`
- `status`

设备表 `devices` 继续作为设备身份基础，避免重复造轮子。

### products

可售商品表。

- `id`
- `kind`: `day_pass`、`week_pass`、`month_pass`、`token_pack`、`image_pack`、`video_pack`、`single_use`
- `name`
- `description`
- `price_cents`
- `currency`
- `resource_type`: `token`、`image_generation`、`video_generation`、`membership`
- `unit_amount`
- `duration_seconds`
- `grant_expires_days`
- `metadata`
- `status`
- `sort_order`
- `created_at`
- `updated_at`

日卡、周卡、月卡使用 `duration_seconds`；token 包使用 `resource_type = token` 和 `unit_amount`；图片包使用 `resource_type = image_generation`；视频包使用 `resource_type = video_generation`。所有商品档位、价格、有效期、排序和上下架状态都由管理后台调整，客户端只展示服务端返回的可售商品。

### feature_pricing_rules

能力计价规则表。它决定一次图片、视频或模型能力调用要扣多少权益。

- `id`
- `feature`: `chat_model`、`image_generation`、`video_generation`
- `provider`
- `model`
- `spec_key`: 如 `image.standard`、`image.hd`、`video.5s.sd`、`video.10s.hd`
- `resource_type`
- `unit_cost`
- `free_daily_limit`
- `paid_daily_limit`
- `concurrency_limit`
- `enabled`
- `metadata`
- `created_at`
- `updated_at`

价格和限制必须服务端生效。客户端可以展示这些规则，但不能用客户端传来的价格作为扣费依据。

### orders

支付订单表。

- `id`
- `user_id`
- `product_id`
- `provider`: `alipay`、`wechat`
- `provider_order_id`
- `amount_cents`
- `currency`
- `status`: `pending`、`paid`、`closed`、`refunded`
- `paid_at`
- `created_at`
- `updated_at`

支付回调必须幂等。`provider_order_id` 需要唯一约束。

### wallet_grants

权益发放表。每次免费赠送、购买、补偿都生成一条 grant。

- `id`
- `user_id`
- `source_type`: `free_signup`、`order`、`admin_adjustment`、`refund_reversal`
- `source_id`
- `grant_type`: `free_tokens`、`paid_tokens`、`free_image_generations`、`paid_image_generations`、`free_video_generations`、`paid_video_generations`、`membership`
- `resource_type`: `token`、`image_generation`、`video_generation`、`membership`
- `token_total`
- `token_remaining`
- `unit_total`
- `unit_remaining`
- `starts_at`
- `expires_at`
- `status`
- `metadata`
- `created_at`

会员也可以用 grant 表表达：`grant_type = membership`，`starts_at/expires_at` 表示有效期，`metadata.plan` 表示 day/week/month 或后续档位。`token_total/token_remaining` 保留给 token 查询兼容；新能力统一使用 `resource_type + unit_total/unit_remaining`。

### wallet_ledger

不可变账本流水。

- `id`
- `user_id`
- `grant_id`
- `event_type`: `grant`、`consume`、`refund`、`expire`、`adjust`
- `resource_type`
- `token_delta`
- `unit_delta`
- `money_delta_cents`
- `source_type`
- `source_id`
- `idempotency_key`
- `created_at`
- `metadata`

`wallet_grants.token_remaining` 和 `unit_remaining` 是查询优化字段；真正审计以 ledger 为准。

### usage_events

模型调用消耗事件。

- `id`
- `user_id`
- `device_id`
- `license_id`
- `model`
- `provider`
- `feature`: `chat_model`、`image_generation`、`video_generation`
- `spec_key`
- `input_tokens`
- `output_tokens`
- `billable_tokens`
- `resource_type`
- `billable_units`
- `unit_cost`
- `status`
- `idempotency_key`
- `created_at`
- `metadata`

`license_id` 可为空。企业授权路径可以先只记录 usage，不扣个人钱包。

## API 设计

### 发送短信验证码

`POST /api/auth/sms/send`

请求：

```json
{
  "phone": "+8613800000000",
  "purpose": "login",
  "deviceId": "dev_xxx"
}
```

响应：

```json
{
  "ok": true,
  "cooldownSeconds": 60
}
```

发送规则：

1. 先校验手机号格式和国家/地区白名单，不合法号码不调用短信服务商。
2. 先执行限流和风险判断，再调用阿里云短信。
3. 同一手机号 60 秒内只能发送一次。
4. 同一手机号每小时最多 5 次，每天最多 10 次。
5. 同一 IP 每小时最多 30 次；同一设备每小时最多 10 次。
6. 同一手机号验证码未过期时，重复点击不生成新验证码，只返回剩余 cooldown。
7. 中风险请求要求图形验证码或行为验证通过后才能发短信。
8. 高风险请求直接拒绝，不调用短信服务商。

失败码包括 `SMS_RATE_LIMITED`、`SMS_RISK_BLOCKED`、`CAPTCHA_REQUIRED`、`INVALID_PHONE`、`SMS_PROVIDER_FAILED`。

阿里云短信配置项：

- `ALIYUN_SMS_ACCESS_KEY_ID`
- `ALIYUN_SMS_ACCESS_KEY_SECRET`
- `ALIYUN_SMS_SIGN_NAME`
- `ALIYUN_SMS_TEMPLATE_LOGIN`
- `ALIYUN_SMS_REGION`

短信服务商密钥只存在服务端。客户端和管理后台都不能读取密钥明文。

### 验证短信并登录

`POST /api/auth/sms/login`

请求包含手机号、验证码和现有设备注册 payload。服务端校验验证码，必要时创建用户，绑定设备，签发 session。

响应：

```json
{
  "ok": true,
  "accessToken": "lily_access_xxx",
  "refreshToken": "lily_refresh_xxx",
  "expiresIn": 900,
  "user": {
    "id": "usr_xxx",
    "phoneMasked": "138****0000"
  },
  "entitlements": {
    "usable": true,
    "tokenBalance": 100000,
    "membershipExpiresAt": "",
    "freeGrantExpiresAt": "2026-07-09T00:00:00.000Z"
  }
}
```

### 刷新服务接口 token

`POST /api/auth/session/refresh`

请求需要 refresh token 和设备签名。服务端校验 refresh token hash、session 状态、设备 ID 和设备签名后，签发新的 access token。

响应：

```json
{
  "ok": true,
  "accessToken": "lily_access_xxx",
  "expiresIn": 900
}
```

第一版 refresh token 可以固定到期，例如 30 天；后续可以做 refresh token rotation。刷新失败返回 `SESSION_EXPIRED`、`SESSION_REVOKED` 或 `DEVICE_MISMATCH`，客户端清理账号登录态。

### 退出登录

`POST /api/auth/session/logout`

请求需要 access token 或 refresh token。服务端撤销当前 `user_sessions` 记录。客户端删除本地 token，但不删除企业激活码 license。

### 查询当前权益

`POST /api/account/entitlements`

需要用户 session 和设备签名。返回当前可用性、余额、会员到期时间、即将过期额度。

### 创建订单

`POST /api/billing/orders`

请求：

```json
{
  "productId": "token_100k",
  "payProvider": "wechat"
}
```

`payProvider` 支持 `alipay` 和 `wechat`。响应返回支付参数或二维码 URL。服务端按 `products` 当前价格创建订单，客户端传入的金额一律忽略。

该接口主要由官网调用。Electron 客户端第一版不直接创建支付订单，只打开官网购买页。除非后续确定要做桌面端内嵌购买，否则客户端不处理支付宝/微信支付页面、扫码状态和支付回跳。

### 创建官网购买跳转链接

`POST /api/account/billing-link`

请求需要客户端 access token 和设备签名。响应：

```json
{
  "ok": true,
  "url": "https://lily.lanrensoft.cn/account/billing?token=one_time_xxx",
  "expiresIn": 300
}
```

服务端创建一次性 `billing_link_tokens` 记录，用于把已登录客户端安全带到官网购买页。

安全规则：

1. token 5 分钟过期。
2. token 只能使用一次。
3. token 绑定 `user_id + device_id + session_id`。
4. 官网消费 token 后只创建 Web 登录态，不返回客户端 refresh token。
5. token 不能用于支付回调、权益扣费或其他 API。

### 支付回调

`POST /api/billing/webhooks/:provider`

支付宝和微信支付渠道调用。服务端验证签名，核对订单号、金额、币种和订单状态，更新订单为 paid，创建 `wallet_grants` 和 `wallet_ledger`。该接口必须按 `provider_order_id` 幂等。任何验签失败、金额不匹配、重复支付或订单状态异常都不能发放权益。

### 模型调用预检

`POST /api/account/usage/preflight`

模型调用前检查用户是否可用。第一版也可以把这个检查内聚在 model gateway 内部，不暴露给客户端。

### 模型调用扣费

由 model gateway 在调用上游模型后内部执行：

1. 读取上游 usage。
2. 计算 billable tokens。
3. 创建 `usage_events`。
4. 按扣费顺序更新 `wallet_grants`。
5. 写入 `wallet_ledger`。

### 图片和视频调用扣费

由 media gateway 在调用上游前后内部执行：

1. 根据请求的 `feature + provider + model + spec_key` 读取 `feature_pricing_rules`。
2. 检查用户免费次数、购买权益、每日上限和并发上限。
3. 余额或次数不足时，在调用上游前拒绝。
4. 调用上游成功后创建 `usage_events`。
5. 按 `resource_type` 扣减 `wallet_grants.unit_remaining`。
6. 写入 `wallet_ledger`。
7. 上游失败且未产生成本时不扣费；已产生成本但结果需要异步回收时，状态标记为 `pending_settlement`，由后台任务补记或退款。

## Electron 客户端改动

### 主进程

新增 `account-manager.js`，负责：

- 保存和读取用户 session。
- 调用短信发送、短信登录、权益查询、退出登录。
- 提供 `requireEntitlement()`，聚合企业 license 和个人权益。
- 在 session 过期或服务端拒绝时清理登录态并返回明确错误。

扩展 `service-client.js`：

- `sendSmsCode(phone)`
- `loginWithSms(phone, code)`
- `fetchAccountEntitlements()`
- `createBillingLink()`
- `listProducts()`

现有 `license-manager.js` 保持可用。第一阶段不删除 `requireValidLicense()`，而是在使用入口逐步换成 `requireEntitlement()`。

### IPC / preload

新增 IPC：

- `account:status`
- `account:sms-send`
- `account:sms-login`
- `account:refresh-token`
- `account:logout`
- `account:entitlements`
- `account:billing-link`
- `billing:products`
- `billing:create-order`

Renderer 只拿到脱敏手机号、余额、会员时间和支付状态，不接触服务端签名密钥或支付回调细节。

### Renderer

设置页“授权”改成“账号与授权”，保留激活码入口，并新增：

- 手机号输入
- 验证码输入
- 发送验证码按钮
- 登录/退出按钮
- 免费额度和 token 余额展示
- 会员到期时间展示
- 商品摘要入口
- 打开官网购买按钮
- 支付后刷新权益按钮

第一版 UI 以功能完整和清晰为主，不增加复杂营销页。

客户端购买交互不做内嵌支付表单。点击购买后打开系统浏览器，避免在 Electron 内处理支付宝/微信支付页面、扫码状态、回跳和安全边界。

## UI 规范

UI 的核心原则是：购买发生在官网，使用发生在客户端；客户端不做复杂商城，只给用户清楚地看到“我是谁、还能用多少、怎么去购买、购买后是否到账”。

### 顶级信息架构

三端职责必须清晰，不互相抢职责。

Electron 客户端：

- `设置 > 账号与授权`：登录、退出、权益展示、刷新权益、打开官网购买页、企业激活码入口。
- `任务执行入口`：文本、图片、视频任务开始前展示权益不足提示。
- `任务结果区`：生成成功后不展示复杂账单，只在需要时提示“已扣减对应权益”。

官网用户区：

- `/account/login`：普通用户手机号登录。
- `/account/billing`：购买入口，展示会员、Token 包、AI 图片、AI 视频。
- `/account/orders`：订单列表和支付状态。
- `/account/entitlements`：权益明细和最近消耗。
- `/account/settings`：手机号、登录设备、退出登录。

管理后台：

- `商品档位`：配置商品、价格、权益数量、有效期、上下架。
- `能力计价`：配置文本、图片、视频能力的扣费和限额。
- `用户`：用户状态、设备、session、免费额度发放状态。
- `订单`：支付状态、回调状态、金额核验。
- `账本`：grant、consume、refund、adjust 全流水。
- `风控`：短信发送、验证码失败、支付异常、异常消耗。

### 顶级视觉方向

客户端是工作台，不做商城感：

- 紧凑、安静、工具型。
- 第一屏优先显示账号状态和剩余额度。
- 购买入口是明确按钮，不铺满商品卡。
- 企业 license 和个人账号并列展示，但要明确当前优先使用哪一个。

官网是购买和账户中心：

- 第一屏直接展示账号状态、当前权益和商品，不做空泛营销 hero。
- 商品分组清晰：会员、Token、图片、视频。
- 支付状态必须比装饰更醒目。
- 移动端优先保证支付二维码/跳转、金额、订单状态不重叠。

管理后台是运营工具：

- 高密度表格和表单。
- 所有危险操作有二次确认。
- 所有金额、权益、限额改动有审计记录。
- 密钥只显示配置状态，不显示明文。

### Electron 客户端账号页

入口放在现有设置里的“账号与授权”。这个页面不做营销型布局，保持工具型、信息密度适中。

页面结构：

1. 顶部账号状态区
   - 未登录：显示手机号输入、验证码输入、发送验证码、登录按钮。
   - 已登录：显示脱敏手机号、登录设备状态、退出登录按钮。
   - 企业授权有效时：显示“企业授权已启用”，并说明个人余额不会优先扣减。

2. 当前权益区
   - Token 余额。
   - 图片剩余次数。
   - 视频剩余次数。
   - 会员有效期。
   - 即将过期的免费额度提醒。

3. 操作区
   - “购买/充值”主按钮：打开官网购买页。
   - “刷新权益”次按钮：重新拉取服务端权益。
   - “粘贴激活码”保留为企业/离线授权入口。

4. 订单同步提示区
   - 支付后短轮询期间显示“正在同步购买结果”。
   - 到账后显示“权益已更新”。
   - 超过 2 分钟未到账，显示“请在官网订单页查看支付状态”。

客户端状态文案：

- 未登录：`登录后可同步官网购买的会员、Token 包、图片和视频权益。`
- 余额不足：`当前权益不足，请购买后再继续使用。`
- 同步中：`正在同步官网购买结果...`
- 同步失败：`暂时无法同步权益，请稍后刷新或前往官网查看订单。`
- 企业授权优先：`当前设备已启用企业授权，本次使用不会扣减个人余额。`

交互约束：

- 发送验证码按钮必须显示服务端返回的 cooldown。
- 登录失败只显示通用错误，不暴露手机号是否注册。
- 购买按钮只能打开官网，不在客户端内嵌支付页。
- 客户端价格展示只能来自服务端，不允许写死。
- 权益数值必须标明资源类型，避免把 token、图片次数、视频次数混在一起。

### 官网账号页

官网用户区和 admin 后台视觉上要明显区分，避免用户误入管理后台。官网用户区应该是普通消费者购买体验：清晰、可信、少步骤。

推荐页面：

1. `/account/login`
   - 手机号验证码登录。
   - 登录后回到购买页或账号首页。
   - 不展示 admin 入口。

2. `/account/billing`
   - 商品分组：会员、Token 包、AI 图片、AI 视频。
   - 每个商品展示名称、价格、权益数量、有效期、适用说明。
   - 支付方式选择：支付宝、微信。
   - 下单前显示实际支付金额。

3. `/account/orders`
   - 展示订单号、商品、金额、支付方式、状态、创建时间。
   - 未支付订单可以继续支付或关闭。
   - 支付异常订单提示联系客服或刷新状态。

4. `/account/entitlements`
   - 展示当前余额、免费额度、购买权益、会员有效期。
   - 展示即将过期权益。
   - 展示最近消耗记录摘要。

官网商品卡规范：

- 日卡、周卡、月卡突出有效期和可用能力。
- Token 包突出 token 数量、有效期和适用模型。
- 图片包突出可生成张数/任务数、支持规格。
- 视频包突出可生成次数、时长/清晰度规格。
- 免费额度单独标注为“赠送额度”，不能和付费权益混淆。

支付流程规范：

1. 用户选择商品。
2. 选择支付宝或微信。
3. 服务端创建订单。
4. 页面展示二维码或跳转支付。
5. 前端轮询订单状态。
6. 支付成功后跳到成功页，展示到账权益。
7. 引导用户回到客户端并刷新权益。

支付状态文案：

- 待支付：`请在支付页面完成付款。`
- 支付确认中：`已收到支付通知，正在发放权益。`
- 支付成功：`权益已到账，可回到客户端继续使用。`
- 支付失败：`支付未完成，未扣款的订单不会发放权益。`
- 金额异常：`订单校验异常，请联系客服处理。`

### 管理后台 UI

管理后台新增配置入口，但不和普通用户购买页混在一起。

后台页面：

- 商品档位管理：配置日卡、周卡、月卡、token 包、图片包、视频包。
- 能力计价管理：配置模型、图片、视频的单次价格、免费次数、每日上限、并发上限。
- 用户管理：查询用户、禁用用户、撤销 session。
- 订单管理：查询订单、支付状态、异常回调。
- 账本流水：查询赠送、购买、消耗、退款和手工调整。

后台表单必须有二次确认的操作：

- 下架商品。
- 修改已上线商品价格。
- 手工赠送权益。
- 手工扣减权益。
- 禁用用户。
- 撤销所有登录态。

后台不能展示短信、支付、模型供应商密钥明文，只显示“已配置/未配置”和健康检查结果。

### 视觉与组件规范

- 客户端设置页保持现有桌面应用风格，不做大面积营销视觉。
- 官网购买页可以更像 SaaS 订阅页，但第一屏必须直接是商品和当前账号状态，不做空泛 hero。
- 商品卡半径不超过 8px，避免过度装饰。
- 价格、权益数量、有效期是商品卡的最高优先级信息。
- 使用图标辅助区分 token、图片、视频、会员，但不能只靠图标表达。
- 错误提示必须说明下一步动作，例如“刷新”“重新登录”“去官网订单页”。
- 所有金额显示人民币符号和两位小数。
- 所有权益数量使用千分位格式。
- 移动端官网购买页必须单列展示商品，支付二维码区域不能挤压金额和订单状态。
- 客户端按钮文字要短：`登录`、`发送验证码`、`购买/充值`、`刷新权益`、`退出登录`。

### 安全提示规范

安全文案要简短，不制造恐慌：

- 验证码发送：`验证码 5 分钟内有效，请勿转发给他人。`
- 官网支付：`支付由支付宝/微信完成，Lily 不保存你的支付密码。`
- 设备登录：`此账号已绑定当前设备，用于同步购买权益。`
- 异常风控：`请求过于频繁，请稍后再试。`
- 订单异常：`订单正在核验，请不要重复付款。`

## 官网改动

官网新增用户账号区，不放在 admin 后台里：

- `/account/login`：手机号短信登录。
- `/account/billing`：商品和购买页。
- `/account/orders`：订单历史。
- `/account/entitlements`：当前权益明细。
- `/account/logout`：退出官网登录。

官网用户登录态和 admin 登录态必须完全隔离：

- 用户 cookie 使用 `lily_user_session`。
- Admin cookie 继续使用 `lily_admin_session`。
- 用户 API 不接受 admin token。
- Admin API 不接受用户 token。

官网购买页展示服务端返回的商品，不写死价格。商品来自 `products`，能力单价来自 `feature_pricing_rules`。运营在管理后台调整档位后，官网和客户端下次刷新自动看到新价格。

## 服务端改动

新增 public routes：

- `routes/public/auth.js`
- `routes/public/account.js`
- `routes/public/billing.js`

新增 services：

- `sms-provider-aliyun.js`
- `account-auth.js`
- `wallet.js`
- `billing-provider.js`
- `billing-provider-alipay.js`
- `billing-provider-wechat.js`
- `feature-pricing.js`

`wallet.js` 是账本唯一写入口。业务代码不能直接改 `wallet_grants.token_remaining`，必须通过 wallet service 完成扣减、发放和退款。

Model gateway 和 media gateway 需要接入账号权益检查和扣费。企业 license 设备可以继续按现有策略放行；个人账号请求必须携带 user session，服务端根据 session 找到 user 后扣个人钱包。

新增 web 用户侧页面和 server actions 时，不能复用 admin auth。官网用户登录、购买和订单查询是普通用户边界；管理后台商品配置、订单审计和用户封禁是 admin 边界。

## 安全与风控

### 短信防盗刷

短信发送必须先风控、后调用服务商。服务端需要在本地挡住异常请求，不能依赖短信服务商的失败回调来控制成本。

基础限流：

1. 手机号维度：60 秒 1 次，1 小时 5 次，1 天 10 次。
2. IP 维度：1 小时 30 次，1 天 100 次。
3. 设备维度：1 小时 10 次，1 天 30 次。
4. IP 段维度：同一 `/24` IPv4 或相近 IPv6 前缀出现异常集中请求时降额。
5. 手机号前缀维度：同一号段短时间大量请求时降额。

风险升级：

1. 新设备、新 IP、异地、代理机房 IP、短时间多手机号请求，标记为中风险。
2. 中风险请求要求图形验证码或行为验证。
3. 高风险请求直接返回 `SMS_RISK_BLOCKED`，不调用短信服务商。
4. 服务商返回号码异常、黑名单或发送失败时，记录到 `sms_codes.risk_reason`，短期内提高该手机号和 IP 的风险等级。
5. 达到全站短信预算阈值时，自动切到保护模式：只允许低风险请求发短信。

验证码规则：

1. 验证码 6 位数字，有效期 5 分钟。
2. 验证码只存带 pepper 的 hash，pepper 来自服务端环境变量。
3. 同一验证码最多尝试 5 次，超过后立即作废。
4. 登录成功后立刻写 `consumed_at`，验证码不可复用。
5. 同一手机号存在未过期验证码时，重复发送不生成新验证码，避免用户连续点击造成多条短信成本。
6. 校验接口也要限流，防止验证码爆破。

客户端配合：

1. 发送按钮本地显示 cooldown，但服务端 cooldown 才是可信来源。
2. 客户端不得根据本地状态判断“已经发送成功”；必须以服务端响应为准。
3. 登录失败只显示通用错误，不暴露“手机号存在/不存在”等可枚举信息。

### 账号与支付安全

1. access token 短期有效，只用于请求服务接口。
2. refresh token 长期有效，服务端只存 hash，客户端用系统安全存储保存。
3. access token 必须绑定 `user_id + session_id + device_id`，不能跨设备复用。
4. 账号接口同时校验 access token 和设备签名，高价值接口不接受裸 token。
5. 退出登录、风控封禁、管理员撤销都要使 refresh token 失效。
6. 支付回调必须验签，且幂等。
7. 扣费操作使用数据库事务，避免并发调用把余额扣成负数。
8. 余额不足时 model gateway 在调用上游前拒绝，避免产生无法收回的成本。
9. 赠送额度按用户发放，不按设备发放，避免刷设备薅免费额度。
10. 管理后台后续需要能禁用用户、撤销 session、查看账本流水。
11. 商品价格、权益数量和功能单价只信服务端数据库，不信客户端请求。
12. 支付宝和微信回调必须分别验签，并核对订单金额、商户号、应用 ID 和订单状态。
13. 图片和视频必须设置每日免费上限、付费上限和并发上限，避免单用户快速打爆上游成本。

## 服务接口 Token 设计

登录后客户端请求服务接口使用两类 token：

1. `accessToken`：短期 token，放在 `Authorization: Bearer <token>` 请求头里，有效期 15 分钟。
2. `refreshToken`：长期 token，只用于刷新 access token，有效期 30 天，保存在 Electron 主进程的安全存储中。

access token 采用服务端签名的紧凑格式，可以是 JWT，也可以沿用项目里已有 HMAC token 风格。推荐 payload：

```json
{
  "typ": "access",
  "sub": "usr_xxx",
  "sid": "sess_xxx",
  "did": "dev_xxx",
  "scope": ["account", "billing", "model_gateway", "media_gateway"],
  "iat": 1783000000,
  "exp": 1783000900
}
```

服务端校验顺序：

1. 校验 token 签名和 `typ`。
2. 校验 `exp` 未过期。
3. 按 `sid` 查询 `user_sessions`，确认未撤销且未过期。
4. 校验 `sub` 与 session 的 `user_id` 一致。
5. 校验 `did` 与请求体或设备签名头里的 `deviceId` 一致。
6. 高价值接口继续校验现有 `X-Lily-*` 设备签名，确保请求来自持有本机私钥的设备。

请求头约定：

```http
Authorization: Bearer lily_access_xxx
X-Lily-Device-Id: dev_xxx
X-Lily-Timestamp: 2026-07-02T00:00:00.000Z
X-Lily-Nonce: ...
X-Lily-Body-Sha256: ...
X-Lily-Signature: ...
```

refresh token 设计：

1. 明文只返回给客户端一次。
2. 服务端存 `sha256(refresh_token + server_pepper)`。
3. refresh token 与 `user_id`、`session_id`、`device_id` 绑定。
4. 刷新 access token 时必须带设备签名。
5. refresh token 泄露但没有设备私钥时，不能单独调用高价值接口。

客户端存储：

1. refresh token 只在 Electron 主进程保存，优先用 `safeStorage` 加密。
2. renderer 不直接持有 refresh token。
3. access token 可以只保存在主进程内存里，需要请求时由主进程代发或注入。
4. 应用重启后，主进程用 refresh token 换新的 access token。
5. 退出登录时删除本地 refresh token 和 access token，并调用服务端撤销 session。

为什么不只用一个永久 token：

1. 永久 token 泄露后难以及时止损。
2. 无法优雅支持退出登录、风控撤销和设备解绑。
3. 长期 token 放在每个接口请求里，暴露面太大。
4. access + refresh 分离后，普通请求只暴露短期 token，高价值请求还要设备签名，风险更可控。

## 兼容策略

企业激活码路径继续存在：

- 已激活 license 的用户不需要登录手机号也能继续使用。
- 如果用户同时有企业 license 和个人账号，优先使用企业 license 放行；个人 token 不扣减，除非调用的是企业 license 不覆盖的付费能力。
- 客户端清除 license 不影响个人账号；退出账号不影响 license。

这样可以保证新计费系统上线失败时，企业授权用户不受影响。

## 分阶段落地

### 第一阶段：账号和免费额度

1. 新增用户、短信、session、grant、ledger 表。
2. 接阿里云短信。
3. Electron 支持手机号验证码登录。
4. 新用户自动发免费 token、图片和视频 grant。
5. 客户端展示账号、token 余额、图片剩余次数和视频剩余次数。

验收标准：新手机号能登录，免费额度只发一次，换设备不会重复领取。

### 第二阶段：充值商品和支付

1. 新增 products 和 orders。
2. 官网新增用户短信登录、商品页和订单页。
3. 接支付宝和微信支付。
4. 支付成功后按商品配置发放 token、图片、视频或会员 grant。
5. 客户端打开官网购买页，支付后刷新余额。
6. 支付回调验签、金额核对和幂等测试覆盖。

验收标准：购买任一商品后对应权益增加，重复回调不重复发放，金额不匹配不发放。

### 第三阶段：model gateway 扣费

1. model gateway 调用前检查账号权益。
2. 调用后根据 usage 创建 usage event。
3. wallet service 扣减 token，并写 ledger。
4. 并发扣费事务测试覆盖。

验收标准：余额不足不调用上游；余额充足调用后按 usage 扣减；重复 usage event 不重复扣费。

### 第四阶段：media gateway 图片/视频扣费

1. media gateway 调用前读取 `feature_pricing_rules`。
2. 图片生成按免费次数、购买次数或单次价格扣减。
3. 视频生成按规格档位扣减。
4. 每日上限和并发上限生效。
5. 上游失败、异步成功、取消和退款路径有明确状态。

验收标准：免费次数用完后不能继续免费生成；付费权益充足时可生成；余额不足时不调用上游；失败不乱扣费。

### 第五阶段：日卡、周卡、月卡

1. 商品支持 membership grant。
2. 查询权益返回会员有效期。
3. 会员有效时解锁对应能力。
4. 到期后自动失效，不影响 token 包。

验收标准：购买日/周/月卡后立即可用；到期后能力关闭；token 包余额不受影响。

### 第六阶段：后台管理

1. 用户列表、订单列表、账本流水。
2. 用户禁用、session 撤销。
3. 手工补偿 grant。
4. 风控和异常订单查询。
5. 商品档位管理：日卡、周卡、月卡、token 包、图片包、视频包。
6. 能力计价管理：AI 图片、AI 视频按模型和规格配置免费次数、单次价格、每日上限、并发上限。
7. 支付渠道配置状态：支付宝、微信的启用状态和回调健康检查。

验收标准：客服和管理员能查清每一笔充值、赠送和消耗；运营能不发版调整商品档位、图片/视频免费次数和单次价格。

## 测试计划

### 服务端单元测试

- 手机号标准化和验证码 hash。
- 验证码过期、错误次数、重复使用。
- 手机号、IP、设备、号段限流。
- 中风险请求要求图形验证码或行为验证。
- 高风险请求不调用短信服务商。
- 未过期验证码重复发送不生成新验证码。
- 新用户首次登录发放免费额度。
- 老用户再次登录不重复发放。
- wallet grant 发放和扣减顺序。
- 并发扣减不会出现负余额。
- usage event 幂等。
- 支付回调幂等。
- 支付宝回调验签、金额不匹配拒绝发放。
- 微信支付回调验签、重复通知不重复发放。
- 图片免费次数用完后拒绝免费调用。
- 视频免费次数用完后拒绝免费调用。
- 图片和视频按 `feature_pricing_rules` 扣减对应单位。
- 图片和视频每日上限、并发上限生效。

### Electron 主进程测试

- account session 保存、读取、清除。
- session 过期后返回明确错误。
- license 有效时 `requireEntitlement()` 放行。
- 账号权益有效时 `requireEntitlement()` 放行。
- 两者都无效时返回 `ENTITLEMENT_REQUIRED`。
- 创建官网购买跳转链接需要 access token 和设备签名。
- 购买跳转链接过期或重复使用后不可再登录官网。

### Renderer 测试

- 发送验证码按钮 cooldown。
- 登录成功后展示脱敏手机号和余额。
- 退出登录后清空账号展示但不清除 license。
- 激活码入口仍可用。
- 点击购买打开官网购买页。
- 支付后刷新权益能同步官网购买结果。

### 官网测试

- 官网用户短信登录不影响 admin 登录。
- 用户 cookie 不能访问 admin API。
- Admin cookie 不能冒充普通用户购买。
- 官网商品价格来自服务端配置。
- 支付成功页和订单页展示到账权益。

### 回归测试

- 现有激活码激活流程不变。
- 现有 license verify 不变。
- 企业 license 用户不因账号服务失败被阻断。

## 开放决策

1. 短信服务商确定为阿里云短信。
2. 支付渠道确定支持支付宝和微信支付。
3. 免费额度、token 包价格、会员价格、图片生成价格、视频生成价格放在 `products` 和 `feature_pricing_rules`，不写死在客户端。
4. 会员是否包含赠送 token、图片次数或视频次数可以作为商品配置，不作为硬编码规则。
5. 图片和视频的具体规格档位由管理后台配置，客户端只展示服务端返回的可售项和可用次数。
