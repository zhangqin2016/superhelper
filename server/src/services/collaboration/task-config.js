import { createCollaborationTaskService } from './tasks.js';
import { createKyselyConversationRepository } from './conversation-repository.js';
import { createCollaborationMessageCrypto } from './message-crypto.js';
import { createTaskPackageBroker } from './task-packages.js';
export function createConfiguredTaskService({database,config}){
  if(config.collaborationTasksEnabled!==true || config.collaborationWorkspaceSharesEnabled!==true)return null;
  try {
  const raw=String(config.collaborationMessageKek||'');
  const version=Number(/^v([1-9][0-9]*)$/.exec(String(config.collaborationMessageKekVersion||''))?.[1]);
  const key=/^[a-f0-9]{64}$/i.test(raw)?Buffer.from(raw,'hex'):Buffer.from(raw,'base64');
  const crypto=createCollaborationMessageCrypto({currentKekVersion:version,kekByVersion:{[version]:key}});
  return createCollaborationTaskService({repository:createKyselyConversationRepository(database),crypto,packages:createTaskPackageBroker()});
  } catch { return null; } // Optional collaboration tasks never disable chat.
}
