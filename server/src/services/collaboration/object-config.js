import { createCollaborationObjectKeyBroker } from "./object-key-broker.js";
import { createPrivateQiniuObjectStore } from "./object-store.js";
import { createCollaborationObjectService } from "./objects.js";
import { createKyselyObjectRepository } from "./object-repository.js";

const failure = (code) => Object.assign(new Error(code), { code, retryable: false });

/** Read only the dedicated object settings. Never consult public storage keys. */
export function readCollaborationObjectConfig(env = {}) {
  return {
    collaborationObjectStorage: {
      accessKey: env.COLLAB_QINIU_ACCESS_KEY || "", secretKey: env.COLLAB_QINIU_SECRET_KEY || "",
      bucket: env.COLLAB_QINIU_BUCKET || "", privateBaseUrl: env.COLLAB_QINIU_PRIVATE_BASE_URL || "",
      uploadUrl: env.COLLAB_QINIU_UPLOAD_URL || "https://upload.qiniup.com",
      // Explicit deployment acknowledgement, not a claim that ACL was probed.
      privateBucket: env.COLLAB_QINIU_PRIVATE_BUCKET === "true",
    },
    collaborationObjectKek: env.COLLAB_OBJECT_KEK || "",
    collaborationObjectKekVersion: env.COLLAB_OBJECT_KEK_VERSION || "v1",
    collaborationObjectKeks: env.COLLAB_OBJECT_KEKS || "",
  };
}

function keyBrokerFor(config) {
  try {
    const versionOf = (value) => {
      const match = /^(?:v)?([1-9][0-9]*)$/.exec(String(value));
      const version = Number(match?.[1]);
      if (!Number.isSafeInteger(version)) throw new Error();
      return version;
    };
    const decodeKey = (value) => {
      if (typeof value !== "string") throw new Error();
      const bytes = /^[a-f0-9]{64}$/i.test(value) ? Buffer.from(value, "hex")
        : /^[A-Za-z0-9+/]{43}=$/.test(value) ? Buffer.from(value, "base64") : null;
      if (bytes?.length !== 32 || !/^[a-f0-9]{64}$/i.test(value) && bytes.toString("base64") !== value) throw new Error();
      return bytes;
    };
    const currentKekVersion = versionOf(config.collaborationObjectKekVersion);
    const raw = config.collaborationObjectKeks ? JSON.parse(config.collaborationObjectKeks) : { [currentKekVersion]: config.collaborationObjectKek };
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length > 32) throw new Error();
    const kekByVersion = new Map();
    for (const [versionName, value] of Object.entries(raw)) {
      const version = versionOf(versionName);
      if (kekByVersion.has(version)) throw new Error();
      kekByVersion.set(version, decodeKey(value));
    }
    if (config.collaborationObjectKeks && config.collaborationObjectKek && !decodeKey(config.collaborationObjectKek).equals(kekByVersion.get(currentKekVersion) || Buffer.alloc(0))) throw new Error();
    return createCollaborationObjectKeyBroker({ currentKekVersion, kekByVersion });
  } catch { throw failure("COLLAB_OBJECT_KEK_UNAVAILABLE"); }
}

function storeFor(config, fetchImpl) {
  try {
    const storage = config.collaborationObjectStorage;
    if (storage?.bucket && storage.bucket === config.qiniuBucket) throw new Error();
    if (config.qiniuPublicBaseUrl && new URL(storage.privateBaseUrl).origin === new URL(config.qiniuPublicBaseUrl).origin) throw new Error();
    return createPrivateQiniuObjectStore({ config: storage, fetchImpl });
  } catch { throw failure("COLLAB_OBJECT_STORE_UNAVAILABLE"); }
}

export function validateCollaborationObjectConfig(config, { fetchImpl } = {}) {
  return { keyBroker: keyBrokerFor(config), objectStore: storeFor(config, fetchImpl) };
}

/** Optional assembly: absent object secrets do not disable ordinary messages. */
export function createConfiguredCollaborationObjectService({ database, config = {}, fetchImpl } = {}) {
  let keyBroker = null, objectStore = null;
  try { keyBroker = keyBrokerFor(config); } catch { /* Object calls fail explicitly in the domain service. */ }
  try { objectStore = storeFor(config, fetchImpl); } catch { /* Never fall back to the public store. */ }
  const service = createCollaborationObjectService({ repository: createKyselyObjectRepository(database), keyBroker, objectStore });
  return Object.freeze({ ...service, async init(input) {
    const enabled = input?.purpose === "workspace" ? config.collaborationWorkspaceSharesEnabled : config.collaborationAttachmentsEnabled;
    if (enabled !== true) throw failure("COLLAB_OBJECT_SHARING_DISABLED");
    return service.init(input);
  } });
}
