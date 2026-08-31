import assert from 'node:assert/strict';
import fs from 'node:fs';
const keys = ['loading','confirming','saved','failed','permissionDenied','confirm','cancel','retry','request','myLilyId','exactLilyId','unavailable','friend','incoming','outgoing','blocked','contact','accept','decline','chat','remove','block','unblock','confirmRemove','confirmBlock','confirmUnblock','confirmDecline','createGroup','name','members','visibility','private','public','createChannel','teamChat','confirmMemberChange','removeMember','makeMember','makeAdmin','addMember','publicMembership','readOnlyMembers','noTeams','permissionUnavailable','cachedDirectory','role.owner','role.admin','role.member','action.request','action.respond','action.remove','action.block','action.unblock','action.create','action.member'];
for (const language of ['en','zh-CN','ar']) {
  const messages = JSON.parse(fs.readFileSync(new URL(`../src/renderer/i18n/locales/${language}.json`, import.meta.url), 'utf8'));
  for (const key of keys) assert.ok(messages[`collaboration.social.${key}`], `${language}: ${key}`);
  assert.ok(messages['collaboration.social.deviceChanged']);
}
for (const name of ['collaboration-friends','collaboration-teams','collaboration-social-ui']) assert.doesNotMatch(fs.readFileSync(new URL(`../src/renderer/modules/${name}.js`, import.meta.url),'utf8'), /innerHTML|insertAdjacentHTML/, 'directory content must remain inert text');
console.log('collaboration social locales/security passed');
