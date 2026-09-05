import { $ } from './dom.js';
import { t } from '../i18n/index.js';
let saving = false;
let identity = '';
export function renderAccountNickname(status) {
  identity = status?.loggedIn ? status.user?.id || '' : '';
  const panel = $('accountNicknamePanel');
  if (panel) panel.hidden = !identity || Boolean(status.user?.passwordMustChange);
  const input = $('accountNicknameInput');
  if (input && !saving) input.value = status?.user?.displayName || status?.user?.display_name || '';
}
export function initAccountNickname(refresh) {
  $('accountNicknameSaveBtn')?.addEventListener('click', async () => {
    if (saving || !identity) return;
    const displayName = $('accountNicknameInput')?.value?.trim() || '';
    const message = $('accountNicknameStatus');
    if (!message) return;
    message.hidden = false;
    if (!displayName || [...displayName].length > 32 || /[\u0000-\u001f\u007f-\u009f]/u.test(displayName)) {
      message.textContent = t('settings.nicknameInvalid'); return;
    }
    const owner = identity;
    saving = true;
    const button = $('accountNicknameSaveBtn');
    button.disabled = true;
    message.textContent = t('settings.nicknameSaving');
    try {
      const result = await window.assistantClient.updateAccountProfile({ displayName });
      if (identity !== owner) return;
      message.textContent = t(result?.ok ? 'settings.nicknameSaved' : 'settings.nicknameFailed');
      if (result?.ok) await refresh();
    } catch {
      if (identity === owner) message.textContent = t('settings.nicknameFailed');
    } finally { saving = false; button.disabled = false; }
  });
}
