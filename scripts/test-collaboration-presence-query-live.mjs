import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {queryPresence,assertPresenceAccount} from '../server/src/services/collaboration/presence-query.js';
import {createOnlinePresence} from '../server/src/services/collaboration/online-presence.js';
import {createCollaborationWsTicketService} from '../server/src/services/collaboration/ws-ticket.js';
const path=process.env.PRESENCE_TEST_PG_CONNECTION_FILE;
if(!path){console.log('SKIP PostgreSQL presence integration: PRESENCE_TEST_PG_CONNECTION_FILE not set');process.exit(0);}
const {url}=JSON.parse(await readFile(path,'utf8'));
const require=createRequire(new URL('../server/package.json',import.meta.url));
const {Pool}=require('pg'); const {Kysely,PostgresDialect,sql}=require('kysely');
const pool=new Pool({connectionString:url,max:1});
const database=new Kysely({dialect:new PostgresDialect({pool})});
try {
 await sql.raw(`CREATE TEMP TABLE users(id text, status text, password_must_change boolean);
 CREATE TEMP TABLE user_sessions(id text primary key,user_id text,device_id text,revoked_at timestamptz,expires_at timestamptz);
 CREATE TEMP TABLE user_devices(user_id text,device_id text,status text);
 CREATE TEMP TABLE user_blocks(blocker_user_id text,blocked_user_id text);
 CREATE TEMP TABLE friendships(user_low_id text,user_high_id text,status text);
 CREATE TEMP TABLE organizations(id text,status text);
 CREATE TEMP TABLE organization_members(organization_id text,user_id text,status text);`).execute(database);
 await sql.raw('CREATE TEMP TABLE collaboration_ws_tickets(token_hash text primary key,user_id text,device_id text,expires_at timestamptz,consumed_at timestamptz)').execute(database);
 const migration=await readFile(new URL('../server/migrations/046_collaboration_presence_ticket_sessions.sql',import.meta.url),'utf8');
 await sql.raw(migration).execute(database);await sql.raw(migration).execute(database);
 const ids=['self','friend','team','blocked','removed','disabled','revoked','device-revoked','expired','password-reset'];
 for(const id of ids){
  await sql`INSERT INTO users VALUES(${id},${id==='disabled'?'disabled':'active'},${id==='password-reset'})`.execute(database);
  await sql`INSERT INTO user_devices VALUES(${id},'device',${id==='device-revoked'?'revoked':'active'})`.execute(database);
  await sql`INSERT INTO user_sessions VALUES(${id+'-session'},${id},'device',${id==='revoked'?new Date():null},${new Date(Date.now()+(id==='expired'?-10000:3600000))})`.execute(database);
 }
 await sql.raw(`INSERT INTO friendships VALUES('self','friend','active'),('self','removed','removed');
 INSERT INTO organizations VALUES('org','active');
 INSERT INTO organization_members SELECT 'org',id,'active' FROM users WHERE id NOT IN ('friend','removed');
 INSERT INTO organization_members VALUES('org','removed','removed');
 INSERT INTO user_blocks VALUES('blocked','self');`).execute(database);
 const presence=createOnlinePresence(); for(const id of ids)presence.connect(id,{userId:id,deviceId:'device',sessionId:id+'-session'});
 await sql.raw("INSERT INTO user_sessions VALUES('other-active-session','revoked','device',NULL,now()+interval '1 hour')").execute(database);
 const ticketService=createCollaborationWsTicketService({db:database});
 const ticket=await ticketService.issue({userId:'self',deviceId:'device',sessionId:'self-session'});
 assert.equal('sessionId' in ticket,false,'public ticket response does not expose session identity');
 assert.deepEqual(await ticketService.consume({ticket:ticket.ticket}),{userId:'self',deviceId:'device',sessionId:'self-session'});
 const legacy=await ticketService.issue({userId:'self',deviceId:'device'});
 assert.deepEqual(await ticketService.consume({ticket:legacy.ticket}),{userId:'self',deviceId:'device'},'nullable legacy ticket keeps transport compatibility');
 const revokedTicket=await ticketService.issue({userId:'self',deviceId:'device',sessionId:'self-session'});
 await sql.raw("UPDATE user_sessions SET revoked_at=now() WHERE id='self-session'").execute(database);
 await assert.rejects(ticketService.consume({ticket:revokedTicket.ticket}),/invalid/,'new bound ticket cannot authenticate revoked session');
 await sql.raw("UPDATE user_sessions SET revoked_at=NULL WHERE id='self-session'").execute(database);
 const result=await queryPresence({database,presence,userId:'self',userIds:[...ids,'absent']});
 assert.deepEqual(Object.fromEntries(result.states.map(s=>[s.userId,s.presence])),{self:'online',friend:'online',team:'online',blocked:'unknown',removed:'unknown',disabled:'unknown',revoked:'offline','device-revoked':'offline',expired:'offline','password-reset':'unknown',absent:'unknown'});
 await assertPresenceAccount(database,'self','device');
 for(const id of ['device-revoked','disabled','password-reset'])await assert.rejects(assertPresenceAccount(database,id,'device'),/unavailable/);
 await sql.raw("UPDATE organizations SET status='disabled'").execute(database);
 assert.equal((await queryPresence({database,presence,userId:'self',userIds:['team']})).states[0].presence,'unknown','disabled common team revokes permission');
 console.log('Real PostgreSQL TEMP tables: friend/team/block override, revoked session/device, expired/disabled accounts and account guard passed');
} finally {await database.destroy();}
