export const compareCardPosition=(a,b)=>a.createdAt-b.createdAt||(a.id===b.id?0:a.id<b.id?-1:1);

// Refresh to the user's oldest loaded anchor, including newly arrived cards.
// Every IPC response remains bounded even after many pages have been opened.
export async function readCardWindow(read,{before,through,current}) {
  let cursor=before,rows=[],conversationIds=new Set();
  for(;;) {
    const page=await read(cursor);if(!current())return null;
    if(!page?.ok)return {ok:false,code:page?.code,cards:[],nextCursor:null};
    const cards=page.cards||[],next=page.nextCursor||null;
    if(next&&cursor&&compareCardPosition(next,cursor)>=0)throw Error("Task card cursor did not advance");
    for(const id of page.conversationIds||[])conversationIds.add(id);
    rows.push(...cards);
    if(!through||!next||compareCardPosition(next,through)<=0) {
      const older=through&&rows.some(card=>compareCardPosition(card,through)<0);
      return {ok:true,cards:(through?rows.filter(card=>compareCardPosition(card,through)>=0):rows).sort(compareCardPosition),
        nextCursor:through&&(next||older)?{id:through.id,createdAt:through.createdAt}:next,conversationIds:[...conversationIds]};
    }
    cursor=next;
  }
}

export function renderCardPager(root,{nextCursor,busy,error,loadMore},t) {
  let row=root.querySelector(":scope > .task-card-pager");
  if(!nextCursor&&!error){row?.remove();return;}
  if(!row){row=document.createElement("div");row.className="task-card-pager";const button=document.createElement("button");button.type="button";button.className="remote-task-button";row.append(button);}
  const button=row.firstElementChild;button.disabled=busy;button.textContent=t(`collaboration.task.${error?"retryOlder":busy?"loadingOlder":"loadOlder"}`);button.onclick=loadMore;
  root.insertBefore(row,root.firstChild);
}
