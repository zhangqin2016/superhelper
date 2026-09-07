import { onLocaleChange } from '../i18n/index.js';
import { paintPresence, presenceBadge } from './collaboration-presence-view.js';

/** Visible-target declarations only. Main owns network polling and lease timers. */
export function createOnlinePresenceView({root, header, getPeer = () => '', getAccountId = () => '', api = window.assistantClient?.collaboration}) {
  if (!root?.querySelectorAll || typeof api?.getPresence !== 'function') return {refresh:async()=>{},changed(){},reset(){},destroy(){}};
  let epoch = 0, owner = getAccountId(), disposed = false, scheduled = false, targetsKey = '', values = new Map();
  const visible = node => {
    if (!node.isConnected || node.closest('[hidden]')) return false;
    const details = node.closest('details'); if (details && !details.open) return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
  };
  function collect() {
    if (disposed || root.hidden || document.visibilityState === 'hidden') return [];
    const ids = new Set(); const peer = getPeer(); if (peer) ids.add(peer);
    for (const node of root.querySelectorAll('[data-presence-user]')) if (visible(node) && ids.size < 200) ids.add(node.dataset.presenceUser);
    // The online filter must still query its current search/page candidates,
    // including unknown users, or it could never discover a newly online peer.
    for (const roster of root.querySelectorAll('.enterprise-roster')) if (roster.open && visible(roster)) {
      for (const id of roster.presenceTargets?.() || []) { if (ids.size >= 200) break; ids.add(id); }
    }
    return [...ids].filter(id => /^[A-Za-z0-9_-]{1,200}$/.test(id)).slice(0,200);
  }
  function paint() {
    if (header) {
      const peer = getPeer();
      let badge = header.querySelector('[data-presence-user]');
      if (!peer) badge?.remove();
      else { if (!badge) { badge = presenceBadge(peer); header.append(badge); } badge.dataset.presenceUser = peer; }
      const hidden = !peer || Boolean(root.querySelector('#collaborationTyping:not([hidden])'));
      if (header.hidden !== hidden) header.hidden = hidden;
    }
    for (const node of root.querySelectorAll('[data-presence-user]')) paintPresence(node, values.get(node.dataset.presenceUser));
    for (const roster of root.querySelectorAll('.enterprise-roster')) roster.updatePresence?.(values);
  }
  async function refresh({changedOnly = false} = {}) {
    if (disposed) return;
    if (owner !== getAccountId()) { owner = getAccountId(); epoch++; values.clear(); targetsKey = ''; }
    const ids = collect(), key = JSON.stringify(ids);
    if (changedOnly && key === targetsKey) { paint(); return; }
    targetsKey = key;
    const generation = ++epoch, account = owner;
    paint();
    let result;
    try { result = await api?.getPresence?.({userIds:ids}); } catch { result = null; }
    if (disposed || generation !== epoch || account !== getAccountId()) return;
    values = new Map((result?.ok === true && Array.isArray(result.states) ? result.states : []).filter(row => ids.includes(row.userId)).map(row => [row.userId,row]));
    paint();
  }
  const schedule = () => { if (scheduled || disposed) return; scheduled = true; queueMicrotask(() => { scheduled = false; void refresh({changedOnly:true}); }); };
  const observer = new MutationObserver(schedule);
  observer.observe(root,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden','open']});
  const foreground = () => { void refresh(); };
  root.addEventListener('scroll',schedule,true); root.addEventListener('input',schedule,true); root.addEventListener('change',schedule,true); root.addEventListener('toggle',schedule,true);
  window.addEventListener('resize',schedule); window.addEventListener('focus',foreground); document.addEventListener('visibilitychange',foreground);
  const offLocale = onLocaleChange(() => { paint(); });
  return { refresh,
    changed(snapshot) { values = new Map((snapshot?.states || []).map(row => [row.userId,row])); paint(); },
    reset() { epoch++; values.clear(); targetsKey=''; paint(); schedule(); },
    destroy() { disposed=true;epoch++;observer.disconnect();offLocale?.();root.removeEventListener('scroll',schedule,true);root.removeEventListener('input',schedule,true);root.removeEventListener('change',schedule,true);root.removeEventListener('toggle',schedule,true);window.removeEventListener('resize',schedule);window.removeEventListener('focus',foreground);document.removeEventListener('visibilitychange',foreground);void Promise.resolve().then(()=>api?.getPresence?.({userIds:[]})).catch(()=>{}); },
  };
}
