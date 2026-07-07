# Managed Gateway Token Invalid

## Symptom

A client can reach the direct upstream provider with its own API key, but Lily managed gateway returns:

`401 MODEL_GATEWAY_TOKEN_INVALID`

The device/license can still be valid and the production gateway can still work for freshly issued tokens.

## Root Cause

Lily model gateway tokens are HMAC-signed and cached inside the signed remote config. Production was issuing long-lived gateway tokens (`MODEL_GATEWAY_TOKEN_TTL_SECONDS=2592000`, 30 days). If a client cached a placeholder/malformed/old gateway token, or a token that the current gateway no longer accepts, the client only checked the embedded expiration timestamp. It did not verify token usability and therefore kept sending the stale token until the gateway rejected it.

Fresh tokens signed by the current `lily-api` container verify and successfully call `/llm/deepseek/v1/chat/completions`, so a `MODEL_GATEWAY_TOKEN_INVALID` report is not proof that DeepSeek or the device authorization is invalid. It is a managed-config token refresh failure.

## Fix

- Treat `MODEL_GATEWAY_TOKEN_INVALID` / `MODEL_GATEWAY_TOKEN_EXPIRED` as a managed model config refresh condition, not as a user BYOK API-key error.
- When a Lily gateway route using a gateway token gets 401/403/auth text, force-refresh remote config, rebuild the runner's model env, restart the OpenCode serve, and replay the current prompt once.
- Local cache preflight now rejects `$LILY_GATEWAY_TOKEN` placeholders and malformed `lilygw.*` values before sending.

## Guard Tests

- `scripts/test-opencode-agent-session.mjs` covers hidden refresh/retry for a stale managed gateway token.
- `scripts/test-turn-error-classify.mjs` covers exact gateway-token auth classification and preserves generic BYOK 401 behavior.
- `scripts/test-remote-config-gateway-token-expiry.mjs` covers expired, placeholder, and malformed gateway tokens forcing config refresh.
