# Dynamic Config and Secret Security Design

## Goal

Lily Workbench must not depend on hard-coded model, tool, plugin, or policy choices inside the installer. The installer should only contain enough bootstrap material to start safely:

- service base URL
- public signing key
- packaged fallback config
- local runtime

The server owns the effective product configuration. The client pulls a signed config, verifies it, applies it, and caches it locally for offline startup.

## Core Boundary

Model endpoint routing and model credential secrecy are separate concerns.

The server can send either a vendor URL or a Lily relay URL:

```text
DeepSeek direct: https://api.deepseek.com/anthropic
Lily relay:      https://lily.lanrensoft.cn/llm/deepseek
Private deploy:  https://customer.example.com/llm
```

The client should not care which one it is. It only applies the signed `baseUrl`, model IDs, tool policy, and plugin registry.

If a shared LLM API key is used by the desktop client directly, that key will exist on the user's machine at runtime. Encryption and obfuscation reduce casual leakage, but they cannot make a local runtime secret impossible to extract. To truly hide provider credentials, requests must go through a server-side relay.

## Config Resolution

The server resolves config in this order:

```text
device profile
> license profile
> global profile
> packaged client fallback
```

The client receives only the resolved effective config.

## Effective Config Shape

```json
{
  "schemaVersion": 1,
  "models": {
    "activePresetId": "server-default",
    "presets": [
      {
        "id": "server-default",
        "label": "Default",
        "description": "Managed by Lily",
        "env": {
          "LILY_API_BASE_URL": "https://lily.lanrensoft.cn/llm/deepseek",
          "LILY_API_KEY": "$LILY_GATEWAY_TOKEN",
          "LILY_GATEWAY_PROVIDER": "deepseek",
          "LILY_MODEL": "deepseek-v4-pro[1m]",
          "LILY_MODEL_HAIKU": "deepseek-v4-flash",
          "LILY_MODEL_SONNET": "deepseek-v4-pro[1m]",
          "LILY_MODEL_OPUS": "deepseek-v4-pro[1m]",
          "LILY_SUBAGENT_MODEL": "deepseek-v4-flash"
        }
      }
    ]
  },
  "tools": {
    "pluginRegistryUrl": "https://lily.lanrensoft.cn/api/plugins/registry",
    "enabledPluginIds": ["websearch", "webfetch"]
  },
  "policy": {
    "permissionMode": "daily",
    "networkAllowlist": ["lily.lanrensoft.cn"],
    "minAppVersion": "0.1.21"
  }
}
```

## Server Signature

The server signs this payload:

```json
{
  "schemaVersion": 1,
  "configVersion": "2026-06-06T10:00:00.000Z",
  "expiresAt": "2026-06-07T10:00:00.000Z",
  "effectiveConfig": {}
}
```

The response includes:

```json
{
  "ok": true,
  "schemaVersion": 1,
  "configVersion": "...",
  "expiresAt": "...",
  "effectiveConfig": {},
  "signature": "..."
}
```

The client verifies the signature with the packaged public key before applying the config.

## Device Request Security

The mature request strategy is device-signed requests.

On first launch:

```text
client generates an Ed25519/ECDSA keypair
private key stays in macOS Keychain / Windows Credential Manager
public key is registered with the device
```

Every sensitive request includes:

```text
X-Lily-Device-Id
X-Lily-Timestamp
X-Lily-Nonce
X-Lily-Body-Sha256
X-Lily-Signature
```

The server verifies:

- device exists
- license/trial is valid
- timestamp is within a short skew window
- nonce was not used before
- signature matches the registered public key
- device/app version is allowed by policy

This means knowing the API path is not enough to call the API.

## Secret Storage

Client:

- use Electron `safeStorage` for local config and licenses
- move API keys out of plain `model-settings.json`
- keep plaintext only in memory while launching the runtime

Server:

- store provider credentials encrypted at rest
- never return full secrets from admin APIs
- audit create, rotate, disable, and decrypt operations
- prefer envelope encryption with a master key outside the database

## Rollout Model

Every config edit creates a revision.

```text
draft -> validate -> publish -> device pull -> audit -> rollback if needed
```

Admin operations should support:

- global default model
- license/customer model profile
- device-specific model profile
- tool/plugin enablement
- permission policy
- min app version
- kill switch

## Implemented First Cut

The first cut provides the product control plane without pretending local secrets are impossible to extract:

1. server config profiles and signed `/api/client/config`
2. client remote config pull, signature verification, encrypted cache
3. model catalog override from remote config
4. plugin registry URL override from remote config
5. admin APIs for listing and upserting profiles
6. local model/API gateway keys encrypted with Electron `safeStorage`
7. device keypair generation and signed `/api/client/config` requests
8. nonce replay protection for device-state APIs
9. signed request enforcement for client config, license verification, usage,
   usage summary, plugin events, runtime diagnostics, and device key rotation
10. admin UI for global/license/device config profiles
11. integration tests for config resolution, request signing, and unsigned
   request rejection
12. device key rotation with old-key proof; old keys stop working after
   rotation and the new key continues the signed request chain
13. stable rollout percentage per profile; 0% profiles are skipped, 100%
    profiles apply to all matching devices, and partial rollout uses a stable
    device/profile bucket
14. config profile revisions and one-step rollback to the previous snapshot

Next security hardening:

1. server secret vault for provider key rotation and encrypted-at-rest storage
2. regional relay nodes if gateway latency becomes visible for overseas users

## Provider Strategy

The product should distinguish model capability from protocol compatibility:

- DeepSeek, Alibaba Cloud Model Studio, Kimi/Moonshot, and Z.AI/GLM can be
  configured as Anthropic-compatible providers when their Claude Code compatible
  endpoint is used.
- Self-hosted open-source models do not need to be "Claude models", but the
  endpoint in front of them should expose Anthropic-compatible messages and tool
  semantics if the desktop runtime is Claude Code based.
- If a self-hosted model only exposes OpenAI-compatible `/v1/chat/completions`,
  Lily can adapt basic chat and stream responses through `type: "openai"`, but
  this is a compatibility fallback. It should not be treated as full Claude Code
  equivalence.

The four-stage deployment model is:

1. Lily remains the control plane: device authorization, signed config,
   short-lived model gateway tokens, usage reporting, and audit trails.
2. LiteLLM or another mature gateway handles protocol adaptation for providers
   that are not natively Anthropic-compatible.
3. DeepSeek, DashScope, Kimi/Moonshot, and Z.AI/GLM use direct
   Anthropic-compatible passthrough when their official endpoint supports it.
4. Self-hosted models use either a customer Anthropic-compatible gateway or
   `vLLM/SGLang/Ollama -> LiteLLM -> Lily`.

Recommended self-hosted provider config:

```json
{
  "local": {
    "type": "anthropic",
    "baseUrl": "https://models.example.com/anthropic",
    "apiKey": "server-side-secret",
    "models": ["local-qwen"]
  },
  "litellm": {
    "type": "anthropic",
    "baseUrl": "http://litellm:4000",
    "apiKey": "litellm-master-key",
    "models": ["local-qwen", "local-qwen-fast", "local-qwen-strong"]
  }
}
```

Fallback only when the runtime cannot expose Anthropic-compatible APIs:

```json
{
  "local-openai-compatible": {
    "type": "openai",
    "baseUrl": "https://models.example.com/v1",
    "apiKey": "server-side-secret"
  }
}
```
