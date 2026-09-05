# IM attachments Qiniu enablement

Status: production attachment flag enabled and storage verified, 2026-09-05 00:09 UTC. User authorized use of the existing Qiniu account and subsequently approved uploading the dedicated certificate/private key to Qiniu. DNS is managed in Aliyun.

## Production configuration

- Existing public distribution bucket/domain remain unchanged. Dedicated bucket `lanrensoft-im-private` is in z0, verified `Private=1`.
- Source domain `https://im-files.lanrensoft.cn` is bound to the private bucket. Aliyun CNAME `im-files` points to `iovip-z0.qiniuio.com`, TTL 10 minutes.
- Dedicated certificate `lily-im-files-20260905`, ID `6a9b5a418efcc9881d4743d1`, uploaded to Qiniu and bound successfully. The console repeatedly reported request failures; the documented public Certd source-domain adapter supplied the binding protocol (`POST /cert/bind`), which returned HTTP 200. TLS validation then passed.
- Dedicated `COLLAB_QINIU_*` settings and object KEK were staged and validated using the existing production API image. Secret values are not stored in this repository.
- Production flags: collaboration=true, attachments=true, workspaceShares=false. Client baseline policy also reports attachments=true.
- Recreated only the existing `lily-api` image. Container is running/healthy. Local API, domestic `lilych.lilywb.cn`, and overseas `lilyxinjiapo.lilywb.cn` health endpoints returned HTTP 200.

## Verification evidence

- 25 targeted transfer, attachment-send, object-config and metadata tests passed; Electron attachment UI test passed earlier in this task.
- Used application `encryptFile` / `decryptFile` and `createPrivateQiniuObjectStore` against real Qiniu with synthetic PNG, repository PDF fixture, and synthetic ZIP. All three passed exact-size upload, unsigned HEAD denial (401), signed HEAD/hash query, signed download, ciphertext equality and decrypted plaintext equality.
- Ciphertext sizes: PNG 394 bytes, PDF 21,663 bytes, ZIP 500 bytes. Each uploaded test object has one-day expiry; local plaintext/ciphertext test directories were removed.
- Cross-border local probe exceeded the production 5-second timeout on an initial attempt. The temporary local acceptance harness used a 20-second network timeout; production code was unchanged. Separately, the original 5-second probe from the production server passed against the real 400-byte encrypted synthetic object, returning matching size and SHA-256.
- Browser opening the bare download domain returns `download token not specified`; this is expected private-bucket protection.
- This is real storage acceptance plus existing UI/service tests, not a live two-account desktop conversation acceptance. No message was sent to real contacts. Account-specific profile overrides and already-running clients were not individually verified; clients need refreshed configuration to see the enabled policy.

## Deployment and rollback

Production directory: `/www/wwwroot/lily-workbench/deploy/baota`.
Compose file: `docker-compose.images-app-only.yml`; service: `api`.

Server-only environment backups (mode 0600):

- `.env.before-im-20260905075608`: before dedicated storage settings.
- `.env.before-im-enable-20260905`: dedicated settings present, attachment flag still false.

To disable the feature without losing the configured KEK, set `COLLABORATION_ATTACHMENTS_ENABLED=false` and recreate only `api` with the existing image. Preserve KEK material once attachments are stored; losing it prevents decryption of stored object keys.

## Outstanding: certificate renewal

Certificate expires **2026-12-03 22:44:50 UTC**. Server files are under `/root/.acme.sh/im-files.lanrensoft.cn_ecc/`; no private key is stored here.

Issuance used manual DNS validation. Automatic renewal/deployment is **not configured**. Before expiry, renew the certificate using a fresh ACME DNS challenge, upload the renewed full chain/private key to Qiniu, and bind the new certificate ID to this source domain. An unattended DNS credential or another validated renewal mechanism is still required for automatic renewal; the existing manual ACME scheduled entry alone does not complete this process.

The user has been informed of this remaining operational limitation. No recurring reminder was created.
