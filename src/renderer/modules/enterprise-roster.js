import { t } from '../i18n/index.js';
import { identityName, socialNode, socialRowButton, socialAvatar } from './collaboration-social-ui.js';
export function memberPresence(member, now = Date.now()) {
  if (member.presence === 'online') return Date.parse(member.onlineUntil) > now ? 'online' : 'unknown';
  return member.presence === 'offline' ? 'offline' : 'unknown';
}
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
  let limit = 50;
  function paint() {
    state.search = search.value; state.online = checkbox.checked;
    const needle = search.value.trim().toLocaleLowerCase();
    const selected = team.members.filter(m => (!checkbox.checked || memberPresence(m) === 'online') && (!needle || [identityName(m), m.lilyId].some(v => String(v || '').toLocaleLowerCase().includes(needle))))
      .sort((a, b) => Number(memberPresence(b) === 'online') - Number(memberPresence(a) === 'online') || identityName(a).localeCompare(identityName(b)));
    members.replaceChildren();
    for (const member of selected.slice(0, limit)) {
      const status = memberPresence(member), name = identityName(member);
      const row = socialRowButton(name, member.userId === selfId ? null : () => onChat(member), {
        avatar: socialAvatar(name), subtitle: `${t('collaboration.enterprise.' + status)} · ${t('collaboration.social.role.' + member.role)}`,
      });
      row.dataset.userId = member.userId; row.dataset.presence = status;
      members.append(row);
    }
    if (selected.length > limit) {
      const more = socialNode('button', t('collaboration.enterprise.more')); more.type = 'button'; more.className = 'settings-action-btn';
      more.addEventListener('click', () => { limit += 50; paint(); }); members.append(more);
    }
    if (!selected.length) members.append(socialNode('p', t('collaboration.enterprise.noMatch'), 'collaboration-empty'));
  }
  search.addEventListener('input', paint); checkbox.addEventListener('change', paint); paint();
  return root;
}
