import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {createObjectCleanup} from '../src/services/collaboration/object-cleanup.js';

export async function verifyObjectCleanup({db,pool,conversationId,messageId,command,accepted}){
  const prefix='cleanup_'+randomUUID(),ids={orphan:prefix+'_orphan',bound:prefix+'_bound',future:prefix+'_future',explicit:prefix+'_explicit'};
  for(const [kind,id] of Object.entries(ids)){
    await pool.query(`INSERT INTO stored_objects(id,owner_user_id,conversation_id,scope_type,organization_id,purpose,object_key,state,ciphertext_size,ciphertext_sha256,mime_type,original_name,orphan_expires_at,expires_at,bound_message_id)
      VALUES($1,'a',$2,'organization','org','attachment',$3,$4,100,$5,'application/octet-stream','fixture',clock_timestamp()+$6::interval,$7,$8)`,
    [id,conversationId,'collaboration/'+randomBytes(32).toString('hex'),kind==='bound'?'bound':'verified','a'.repeat(64),kind==='future'?'1 hour':'-1 second',kind==='explicit'?new Date(Date.now()-1000):null,kind==='bound'?messageId:null]);
    await pool.query("INSERT INTO object_keys(object_id,wrapped_dek,kek_version,algorithm) VALUES($1,$2,1,'aes-256-gcm')",[id,Buffer.alloc(60)]);
  }
  let failure=true,calls=0,gate,release;
  const cleaner=createObjectCleanup({database:db,objectStore:{async delete(){calls++;if(gate)await gate;if(failure)throw Error('PRIVATE_PROVIDER_SECRET');}}});
  assert.ok(await cleaner.retireExpired()>=2);
  const object=async id=>(await pool.query('SELECT * FROM stored_objects WHERE id=$1',[id])).rows[0];
  assert.equal((await object(ids.bound)).state,'bound');assert.equal((await object(ids.future)).state,'verified');
  assert.equal((await object(ids.orphan)).state,'expired');assert.equal((await pool.query('SELECT count(*)::int n FROM object_keys WHERE object_id=$1',[ids.orphan])).rows[0].n,0);
  assert.equal(accepted(await command('a',`objects/${ids.orphan}/status`,{})).reason,'orphan-expired');
  assert.equal((await command('a',`objects/${ids.explicit}/status`,{})).status,403);
  assert.equal(await cleaner.deleteNext(),null,'freshly retired objects wait out already-issued upload credentials');assert.equal(calls,0);
  const due=()=>pool.query("UPDATE object_cleanup_jobs SET available_at=clock_timestamp()-interval '1 second' WHERE object_id=$1",[ids.orphan]);
  await due();assert.equal((await cleaner.deleteNext()).state,'retry');
  let job=(await pool.query('SELECT * FROM object_cleanup_jobs WHERE object_id=$1',[ids.orphan])).rows[0];
  assert.equal(job.attempts,1);assert.equal(job.last_error_code,'COLLAB_OBJECT_STORE_UNAVAILABLE');assert.ok(new Date(job.available_at)>new Date());
  assert.equal((await object(ids.orphan)).state,'expired');await due();failure=false;
  gate=new Promise(resolve=>{release=resolve;});const pending=cleaner.deleteNext();while(calls!==2)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(await cleaner.deleteNext(),null,'a second cleaner skips the row locked across provider deletion');release();assert.equal((await pending).state,'completed');gate=null;
  assert.equal((await object(ids.orphan)).state,'deleted');assert.equal(accepted(await command('a',`objects/${ids.orphan}/status`,{})).reason,'orphan-expired');
  assert.equal((await command('b',`objects/${ids.orphan}/status`,{})).status,403);
  assert.equal(await cleaner.deleteNext(),null);assert.equal(calls,2);
  // Misqueued cleanup cannot delete a live bound object.
  await pool.query("INSERT INTO object_cleanup_jobs(object_id,reason,available_at) VALUES($1,'fixture',clock_timestamp()-interval '1 second')",[ids.bound]);
  assert.equal(await cleaner.deleteNext(),null);assert.equal((await object(ids.bound)).state,'bound');
  await pool.query("UPDATE object_cleanup_jobs SET available_at=clock_timestamp()-interval '1 second' WHERE object_id=$1",[ids.explicit]);
  let removed=false;
  const crashing=createObjectCleanup({database:{transaction:()=>({execute:callback=>db.transaction().execute(async trx=>{const result=await callback(trx);if(result?.state==='completed')throw Error('before-cleanup-commit');return result;})})},objectStore:{async delete(){removed=true;}}});
  await assert.rejects(crashing.deleteNext(),/before-cleanup-commit/);assert.equal(removed,true);
  assert.equal((await object(ids.explicit)).state,'expired','provider success without database commit remains recoverable');
  assert.equal((await pool.query('SELECT state FROM object_cleanup_jobs WHERE object_id=$1',[ids.explicit])).rows[0].state,'pending');
  assert.equal((await cleaner.deleteNext()).state,'completed');assert.equal((await object(ids.explicit)).state,'deleted');
  console.log('Object cleanup HTTP/PG: delayed retirement, key erasure, retry/backoff, concurrent row fence, bound-object preservation and owner-only orphan recovery after deletion passed (provider adapter).');
}
