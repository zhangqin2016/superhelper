import crypto from 'node:crypto';
import { createCollaborationObjectKeyBroker } from '../src/services/collaboration/object-key-broker.js';
import { createPrivateQiniuObjectStore } from '../src/services/collaboration/object-store.js';
import { createCollaborationObjectService } from '../src/services/collaboration/objects.js';
import { createKyselyObjectRepository } from '../src/services/collaboration/object-repository.js';

/** Real authorization, crypto and private-ticket signer; no provider egress. */
export function enterpriseDownloadFixture(database, pool) {
  let barrier = null;
  const keyBroker = createCollaborationObjectKeyBroker({ currentKekVersion: 1, kekByVersion: { 1: crypto.randomBytes(32) } });
  const objectStore = createPrivateQiniuObjectStore({ config: { accessKey: 'fixture-ak', secretKey: 'fixture-sk', bucket: 'fixture-private', privateBucket: true, privateBaseUrl: 'https://private.invalid', uploadUrl: 'https://upload.invalid' }, fetchImpl: async () => { throw new Error('Unexpected provider egress'); } });
  const service = createCollaborationObjectService({ repository: createKyselyObjectRepository(database), keyBroker, objectStore: {
    ...objectStore,
    async createDownloadTicket(input) {
      if (barrier) { barrier.entered.resolve(); await barrier.release.promise; }
      return objectStore.createDownloadTicket(input);
    },
  } });
  return { service, hold(next) { barrier = next; },
    async seed(conversationId, messageId) {
      const objectId = `obj_${crypto.randomUUID()}`, context = { objectId, ownerUserId: 'member', conversationId, scopeType: 'organization', organizationId: 'org', purpose: 'attachment' };
      const envelope = keyBroker.wrap({ ...context, dek: crypto.randomBytes(32) });
      await pool.query("insert into stored_objects(id,owner_user_id,conversation_id,scope_type,organization_id,purpose,object_key,state,ciphertext_size,ciphertext_sha256,mime_type,original_name,bound_message_id) values($1,'member',$2,'organization','org','attachment',$3,'bound',64,$4,'text/plain','fixture.txt',$5)", [objectId, conversationId, objectStore.createObjectKey(), 'a'.repeat(64), messageId]);
      await pool.query('insert into object_keys(object_id,wrapped_dek,kek_version,algorithm) values($1,$2,$3,$4)', [objectId, envelope.wrappedDek, envelope.kekVersion, envelope.algorithm]);
      await pool.query("insert into message_attachments(message_id,object_id,purpose) values($1,$2,'attachment')", [messageId, objectId]);
      return objectId;
    },
  };
}
