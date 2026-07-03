# 2026-07-03 Account SMS Login IPC Contract

Symptom: Electron account login showed "登录失败，请检查手机号和验证码。" even when the user received and entered the SMS code.

Root cause: `src/renderer/modules/account-settings.js` called `window.assistantClient.loginAccountWithSms({ phone, code })`, but `src/preload.js` exposed `loginAccountWithSms(phone, code)`. The preload bridge wrapped the object as the `phone` field and left `code` undefined, so the main process sent malformed login input to the server.

Fix: `src/preload.js` now accepts both object payloads and the older two-argument form, preserving the renderer's `{ phone, code }` call shape.

Regression guard: `scripts/test-renderer-import.cjs` invokes `window.assistantClient.loginAccountWithSms({ phone, code })` from the renderer and asserts the main-process IPC payload is unchanged.
