import { t, getLocale } from '../i18n/index.js';
import { identityName, socialNode, socialRowButton, socialAvatar } from './collaboration-social-ui.js';
import { memberPresence, presenceBadge, paintPresence } from './collaboration-presence-view.js';
export { memberPresence } from './collaboration-presence-view.js';
export function createEnterpriseRoster({ team, selfId, onChat, state, cached = false }) {
  const root = document.createElement('details');
  root.className = 'enterprise-roster'; root.dataset.teamId = team.id; root.open = state.open === true;
  const summary = socialNode('summary', t('collaboration.enterprise.membersSummary', { count: team.members.length, online: team.members.filter(m => memberPresence(m) === 'online').length }));
  root.append(summary);
  root.addEventListener('toggle', () => { state.open = root.open; });
  const search = document.createElement('input'); search.type = 'search'; search.className = 'settings-input';
  search.placeholder = t('collaboration.enterprise.search'); search.setAttribute('aria-label', search.placeholder); search.value = state.search || '';
  const label = socialNode('label'); const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = state.online === true;
  label.append(checkbox, document.createTextNode(t('collaboration.enterprise.onlineOnly')));
  const members = socialNode('div');
  root.append(search, label);
  if (cached) root.append(socialNode('p', t('collaboration.enterprise.cached'), 'collaboration-empty'));
  root.append(members);
  let page = Math.max(0, Number(state.page) || 0);
  const rows = new Map(), pageSize = 50;
  const empty = socialNode('p', '', 'collaboration-empty');
  const previous = socialNode('button', '', 'settings-action-btn'); previous.type='button';previous.dataset.action='presence-previous';
  const more = socialNode('button', '', 'settings-action-btn'); more.type='button';more.dataset.action='presence-more';
  previous.addEventListener('click',()=>{page=Math.max(0,page-1);paint();});
  more.addEventListener('click',()=>{page++;paint();});
  root.append(empty,previous,more);
  let statuses = null, statusKey = '';
  const current = member => statuses ? statuses.get(member.userId) : member;
  const candidates = () => { const needle = search.value.trim().toLocaleLowerCase(); return team.members.filter(m => !needle || [identityName(m), m.lilyId].some(v => String(v || '').toLocaleLowerCase().includes(needle))).sort((a,b)=>identityName(a).localeCompare(identityName(b))); };
  root.presenceTargets = () => candidates().slice(page*pageSize,(page+1)*pageSize).map(m => m.userId);
  root.updatePresence = values => {
    const next = JSON.stringify([getLocale(),team.members.map(m => [m.userId,memberPresence(values.get(m.userId))])]);
    statuses = values; if (next === statusKey) return; statusKey = next; paint();
  };
  function paint() {
    state.search = search.value; state.online = checkbox.checked; state.page=page;
    search.placeholder = t('collaboration.enterprise.search'); search.setAttribute('aria-label',search.placeholder);
    label.lastChild.textContent = t('collaboration.enterprise.onlineOnly');
    const unknown = team.members.some(m=>memberPresence(current(m))==='unknown');
    summary.textContent = t(unknown?'collaboration.enterprise.membersSummaryPartial':'collaboration.enterprise.membersSummary', {count:team.members.length,online:team.members.filter(m => memberPresence(current(m)) === 'online').length});
    const matching = candidates(), selected = matching.slice(page*pageSize,(page+1)*pageSize);
    const selectedIds = new Set(selected.map(m=>m.userId));
    for (const [id,row] of rows) if (!selectedIds.has(id)) {row.remove();rows.delete(id);}
    let position=0, shown=0;
    for (const member of selected) {
      const status = memberPresence(current(member)), name = identityName(member);
      let row=rows.get(member.userId);
      if (!row) {
        row = socialRowButton(name, member.userId === selfId ? null : () => onChat(member), {avatar:socialAvatar(name),subtitle:t('collaboration.social.role.'+member.role)});
        row.dataset.userId=member.userId; row.querySelector('.collaboration-row-content')?.append(presenceBadge(member.userId,current(member))); rows.set(member.userId,row);
      }
      row.dataset.presence = status;
      paintPresence(row.querySelector('[data-presence-user]'),current(member));
      const role = row.querySelector('small'); const roleLabel=t('collaboration.social.role.'+member.role);if(role&&role.textContent!==roleLabel)role.textContent=roleLabel;
      const hidden=checkbox.checked && status!=='online';if(row.hidden!==hidden)row.hidden=hidden;if(!hidden)shown++;
      // Stable keys preserve focused member buttons through lease expiry.
      if(members.children[position]!==row)members.insertBefore(row,members.children[position]||null);position++;
    }
    empty.textContent=t('collaboration.enterprise.noMatch');empty.hidden=shown>0;
    previous.textContent=t('collaboration.enterprise.previous');previous.hidden=page===0;
    more.textContent=t('collaboration.enterprise.more');more.hidden=(page+1)*pageSize>=matching.length;
  }
  search.addEventListener('input', ()=>{page=0;paint();}); checkbox.addEventListener('change', paint); paint();
  return root;
}
