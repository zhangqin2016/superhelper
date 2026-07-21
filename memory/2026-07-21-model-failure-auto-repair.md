# 模型故障自动修复（2026-07-21）

用户裁决："我们要自动修复任何问题。授权正常、大模型 API 能用，就不应该出现各种问题。"
与 evidence-gate model-first 同源：分类只信机械信号，文案只说事实，瞬时故障平台自己吸收。

## 病灶（为什么授权正常也会看到报错）

1. **连接类故障无编排层救援**：`MODEL_CONNECTION_FAILED` / `ENGINE_UNAVAILABLE` /
   `MODEL_OVERLOADED` / `RATE_LIMITED` 到达编排层直接 `turn.failed` 摊牌，文案还让用户
   "check your network and API settings"——绝大多数是上游瞬时抖动，与用户网络无关。
2. **误分类**：`AUTH_FAILED` 含裸 token `401|403|api.?key` 且排在 `QUOTA_EXCEEDED` 前，
   "403 usage limit for this billing cycle"（配额尽）被标成"请检查 API key"。
   `PERMISSION_DENIED` 匹配裸 `not permitted` 散文且 `retryable:false`，堵死自动恢复。
3. **一次就停的天花板**：rescue 每 code 一次（wasRescueAttempt 短路 + 5s debounce），
   网关重启循环这类持续 10-30s 的抖动扛不过去。

## 方案

- `agent-runner.js`：`QUOTA_EXCEEDED` 提到 `AUTH_FAILED` 前（402 机械=支付；403 必须带
  billing 语境才算配额）；`AUTH_FAILED` 收紧为显式鉴权语境；`PERMISSION_DENIED` 只认
  errno 级信号（EACCES/EPERM/permission denied/operation not permitted），`retryable:true`；
  `MODEL_CONNECTION_FAILED` 文案去推锅（事实型：平台自动重试，持续失败=服务暂不可用）。
- `tool-call-rescue.js`：新增 `model_connection_retry` 策略族（5 个 code，recycleEngine +
  delayMs 递增 + `maxAttempts` 2-3，kill switch `LILY_MODEL_CONNECTION_RETRY=0`）。
  `shouldAttemptRescue/markRescueAttempt` 计数化：同一 episode（10 分钟窗口）内按
  maxAttempts 放行，窗口后重置（新 episode 重新获得静默尝试）。新增 `rescueAttemptCount`。
- `turn-recovery-runtime.js`：`wasRescueAttempt` 短路只对单次策略生效，多次策略按预算链接；
  `model_connection_retry` 重试前热刷新模型 env（`runner-live-config.buildLiveEngineEnvPatch`，
  fail-open）；debounce 缩放为 delayMs/2（否则 5s 默认 debounce 会吞掉快速失败后的第 2 次
  尝试——改之前集成测试抓到过）；`LILY_RESCUE_DELAY_MS` 覆盖策略延迟（测试/运维）。
- `turn-orchestrator.js`：终态提示走 `turnRecoveryRuntime.rescueRetryNotice`（架构边界：
  orchestrator 不得 require tool-call-rescue），次数感知、零指责：
  "平台已自动修复重试 N 次仍未恢复，判定为持续性故障。服务恢复后可随时继续。"
  orchestrator 行数棘轮 1968 守住了（净 -3）。

## 守卫（未放松）

- 重放仍受 `isSideEffectFreeToolRun` 硬门：有写文件/发邮件等副作用的轮不自动重放。
- `QUOTA_EXCEEDED`/`AUTH_FAILED` 仍 `retryable:false`——余额尽/key 真无效时 API 确实
  不可用，如实告知是唯一诚实行为（此时用户行动才有意义）。

## 测试

- `test-turn-error-classify.mjs`：403+billing→QUOTA、401 invalid key→AUTH、WAF 403≠AUTH、
  EACCES→PERMISSION(retryable)、散文 not permitted≠PERMISSION、连接文案无 "check your"。
- `test-tool-call-rescue.mjs`：策略族/maxAttempts/计数窗口/kill switch 单元断言 +
  编排层集成链（502 连续失败 → 3 次静默救援 → 第 4 次摊牌，文案含真实次数且无指责）。
- 回归基线 465/468（3 个预存无关失败不变）。
