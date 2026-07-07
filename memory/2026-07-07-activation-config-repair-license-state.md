# Activation Config Repair License State

## Symptom

After a valid account/license activation, Windows clients could show a mixed state:

- Toast: `授权已激活，Lily 正在准备托管模型配置，首次发送会自动重试。`
- Account settings: `授权不可用：授权校验失败`

The affected device still had an active server license binding, a registered public key, and a valid global config profile on the production server.

## Root Cause

The activation handler refreshed managed model config immediately after activation. That repair path also refreshed the server license. If the device key/signature handshake was still being repaired, `refreshServerLicense()` could persist `serverLicenseInvalid`, so a successful activation was locally poisoned by a repairable config/bootstrap condition.

Device signature/key registration errors are not proof that the license is invalid. They are repairable service-state errors and should not invalidate an existing stored server license.

## Fix

- Activation-time model-config repair refreshes bootstrap, device registration, and remote config without refreshing/persisting server license state.
- Device key/signature errors are treated as transient server-license errors, keeping the stored license valid while the repair path retries.
- The activation toast now includes the model-config refresh failure reason instead of only saying the config is pending.

## Guard Tests

- `scripts/test-send-preflight-env.mjs` covers activation repair with `refreshLicense: false`.
- `scripts/test-license-update.mjs` covers existing stored server licenses surviving repairable device signature/key errors.
