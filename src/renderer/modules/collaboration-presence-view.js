import { t } from '../i18n/index.js';

export function memberPresence(member, now = Date.now()) {
  if (member?.presence === 'online') return Date.parse(member.onlineUntil) > now ? 'online' : 'unknown';
  return member?.presence === 'offline' ? 'offline' : 'unknown';
}
export function paintPresence(node, member) {
  const status = memberPresence(member);
  node.dataset.presence = status;
  const label = t('collaboration.presence.' + status);
  if (node.textContent !== label) node.textContent = label;
  node.setAttribute('aria-label', node.textContent);
  node.classList.add('collaboration-presence');
}
export function presenceBadge(userId, member) {
  const node = document.createElement('span');
  node.dataset.presenceUser = userId;
  paintPresence(node, member);
  return node;
}
