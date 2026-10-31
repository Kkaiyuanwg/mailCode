const connectButton = document.getElementById('connect-btn');
const refreshAccountsButton = document.getElementById('refresh-accounts-btn');
const accountSelect = document.getElementById('gmail-account-select');
const gmailButton = document.getElementById('gmail-btn');
const pageButton = document.getElementById('page-btn');
const copyButton = document.getElementById('copy-btn');
const automationToggle = document.getElementById('automation-toggle');
const connectionBadge = document.getElementById('connection-badge');
const resultCode = document.getElementById('result-code');
const emailSubject = document.getElementById('email-subject');
const emailFrom = document.getElementById('email-from');
const resultTime = document.getElementById('result-time');
const statusText = document.getElementById('status');
const watchState = document.getElementById('watch-state');
const watchTitle = document.getElementById('watch-title');
const watchDetail = document.getElementById('watch-detail');
const settingsOpenButton = document.getElementById('settings-open-btn');
const settingsCloseButton = document.getElementById('settings-close-btn');
const settingsDoneButton = document.getElementById('settings-done-btn');
const mainPanel = document.getElementById('main-panel');
const settingsPanel = document.getElementById('settings-panel');
const settingsAccountEmail = document.getElementById('settings-account-email');
const settingsConnectionBadge = document.getElementById('settings-connection-badge');
const settingsStatus = document.getElementById('settings-status');

function setStatus(message, isError = false) {
  statusText.textContent = message;
  statusText.style.color = isError ? '#fca5a5' : '#7dd3fc';
  settingsStatus.textContent = message;
  settingsStatus.style.color = isError ? '#fca5a5' : '#7dd3fc';
}

function setConnection(email, connected) {
  const badgeText = connected ? 'Connected' : 'Sign in required';
  for (const badge of [connectionBadge, settingsConnectionBadge]) {
    badge.textContent = badgeText;
    badge.classList.toggle('connected', connected);
  }
  settingsAccountEmail.textContent = email || (connected ? 'Gmail session detected' : 'No Gmail session detected');
  connectButton.textContent = 'Open Gmail';
}

function renderAccounts(accounts, selectedSlot) {
  accountSelect.replaceChildren();
  if (!accounts.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No signed-in Gmail accounts found';
    accountSelect.append(option);
    accountSelect.disabled = true;
    setConnection('', false);
    return;
  }

  for (const account of accounts) {
    const option = document.createElement('option');
    option.value = account.slot;
    option.textContent = account.email || `Gmail account ${Number(account.slot) + 1}`;
    accountSelect.append(option);
  }
  accountSelect.value = selectedSlot;
  accountSelect.disabled = false;
  const selected = accounts.find((account) => account.slot === selectedSlot);
  if (selected) setConnection(selected.email, true);
}

function showSettings(show) {
  mainPanel.classList.toggle('hidden', show);
  settingsPanel.classList.toggle('hidden', !show);
  settingsOpenButton.setAttribute('aria-expanded', String(show));
  if (show) settingsCloseButton.focus();
}

function formatRelativeTime(timestamp) {
  if (!timestamp) return '';
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(timestamp).toLocaleDateString();
}

function renderEmail(result) {
  if (!result || typeof result.code !== 'string') {
    resultCode.textContent = '------';
    emailSubject.textContent = 'No code found yet';
    emailFrom.textContent = '';
    resultTime.textContent = '';
    copyButton.disabled = true;
    return;
  }

  resultCode.textContent = result.code;
  emailSubject.textContent = result.subject || 'Confirmation email';
  emailFrom.textContent = result.from || 'Unknown sender';
  resultTime.textContent = formatRelativeTime(result.internalDate || result.savedAt);
  copyButton.disabled = false;
}

function renderAutomationState(state) {
  const status = state?.status || 'idle';
  const showWatch = status === 'waiting' || status === 'error';
  watchState.classList.toggle('hidden', !showWatch);
  watchState.classList.toggle('watch-error', status === 'error');

  if (status === 'waiting') {
    watchTitle.textContent = 'Waiting for a code';
    watchDetail.textContent = state.message || 'Gmail sync triggers checks, with a 30-second fallback.';
  } else if (status === 'error') {
    watchTitle.textContent = 'Still waiting — needs attention';
    watchDetail.textContent = state.message || 'Sign in to Gmail in your browser to continue checking.';
  } else if (status === 'found') {
    watchTitle.textContent = 'Code received';
    watchDetail.textContent = state.message || 'The verification code is ready.';
  }
}

settingsOpenButton.addEventListener('click', () => showSettings(true));
settingsCloseButton.addEventListener('click', () => showSettings(false));
settingsDoneButton.addEventListener('click', () => showSettings(false));

async function saveEmailResult(result, source) {
  const saved = { ...result, savedAt: Date.now() };
  await chrome.storage.local.set({
    lastCode: result.code,
    lastEmail: saved,
    source
  });
  renderEmail(saved);
  return saved;
}

async function sendTabMessage(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });
    return chrome.tabs.sendMessage(tabId, message);
  }
}

async function loadAccount() {
  const stored = await chrome.storage.local.get(['gmailAccounts', 'gmailAccountSlot']);
  if (stored.gmailAccounts?.length) {
    renderAccounts(stored.gmailAccounts, stored.gmailAccountSlot || stored.gmailAccounts[0].slot);
  } else {
    setConnection(stored.accountEmail || '', false);
  }
  await refreshAccounts();
}

async function refreshAccounts() {
  refreshAccountsButton.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'list-gmail-accounts' });
    if (response?.status === 'error') throw new Error(response.message);
    renderAccounts(response?.accounts || [], response?.selectedSlot || '');
    if (!response?.accounts?.length) {
      setStatus('No signed-in Gmail accounts found. Open Gmail and sign in, then refresh.', true);
    }
  } catch (error) {
    console.error('ConfirmCode could not list Gmail accounts:', error);
    setStatus(error.message || 'Could not load Gmail accounts.', true);
  } finally {
    refreshAccountsButton.disabled = false;
  }
}

async function loadPopupState() {
  const stored = await chrome.storage.local.get([
    'lastEmail',
    'autoFillEnabled',
    'automationState'
  ]);
  automationToggle.checked = stored.autoFillEnabled !== false;
  renderEmail(stored.lastEmail);
  renderAutomationState(stored.automationState);
  if (stored.automationState?.message) {
    setStatus(stored.automationState.message, stored.automationState.error);
  }
  await loadAccount();
}

connectButton.addEventListener('click', async () => {
  connectButton.disabled = true;
  setStatus('Opening Gmail. Sign in there to enable code detection.');
  try {
    await chrome.tabs.create({ url: 'https://mail.google.com/mail/u/0/#inbox' });
  } catch (error) {
    console.error('ConfirmCode could not open Gmail:', error);
    setStatus('Could not open Gmail. Please open mail.google.com and sign in.', true);
  } finally {
    connectButton.disabled = false;
  }
});

refreshAccountsButton.addEventListener('click', refreshAccounts);

accountSelect.addEventListener('change', async () => {
  const previousSlot = accountSelect.value;
  accountSelect.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'select-gmail-account',
      slot: previousSlot
    });
    if (response?.status === 'error') throw new Error(response.message);
    renderAccounts(response.accounts || [], response.selectedSlot);
    setStatus(`Using ${response.email} for Gmail code searches.`);
  } catch (error) {
    console.error('ConfirmCode could not change Gmail account:', error);
    setStatus(error.message || 'Could not change Gmail account.', true);
    await refreshAccounts();
  } finally {
    accountSelect.disabled = false;
  }
});

automationToggle.addEventListener('change', async () => {
  try {
    await chrome.storage.local.set({ autoFillEnabled: automationToggle.checked });
    setStatus(automationToggle.checked
      ? 'Automatic code fill is enabled on websites.'
      : 'Automatic code fill is paused.');
  } catch (error) {
    console.error('ConfirmCode automation setting error:', error);
    automationToggle.checked = !automationToggle.checked;
    setStatus('Could not update the automatic fill setting.', true);
  }
});

gmailButton.addEventListener('click', async () => {
  gmailButton.disabled = true;
  setStatus('Searching recent unread Gmail messages...');
  try {
    const response = await chrome.runtime.sendMessage({ type: 'search-latest-code' });
    const result = response?.result;
    if (response?.status !== 'code-found' || !result) {
      if (response?.status === 'no-code') {
        setStatus('No code found in unread Gmail messages. Make sure the message is unread.', true);
      } else {
        setStatus(response?.message || 'Could not search Gmail. Sign in to Gmail and try again.', true);
      }
      return;
    }

    await saveEmailResult(result, 'gmail-session');
    let filled = false;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (typeof tab?.id === 'number') {
        const response = await sendTabMessage(tab.id, {
          type: 'apply-confirmation-code',
          code: result.code
        });
        filled = response?.filled === true;
      }
    } catch (error) {
      console.info('ConfirmCode: active page is not available for automatic fill.', error);
    }

    setStatus(filled
      ? `Found ${result.code} in “${result.subject}” and filled the verification field.`
      : `Found ${result.code} in “${result.subject}”.`);
  } catch (error) {
    console.error('ConfirmCode Gmail session search error:', error);
    setStatus(error.message || 'Could not search Gmail. Sign in to Gmail and try again.', true);
  } finally {
    gmailButton.disabled = false;
  }
});

pageButton.addEventListener('click', async () => {
  pageButton.disabled = true;
  setStatus('Searching Gmail for a code for this page...');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (typeof tab?.id !== 'number') {
      setStatus('Could not access the active tab.', true);
      return;
    }

    const response = await sendTabMessage(tab.id, { type: 'request-confirmation-code' });
    if (response?.status === 'waiting') {
      renderAutomationState({ status: 'waiting' });
      setStatus('Waiting for Gmail sync, with a 30-second fallback check.');
    } else if (response?.status === 'complete') {
      const { automationState } = await chrome.storage.local.get(['automationState']);
      renderAutomationState(automationState);
      setStatus(automationState?.message || 'The verification code arrived.');
    } else if (response?.status === 'not-verification-page') {
      setStatus('No verification field was detected on this page.', true);
    } else {
      setStatus(response?.message || 'Could not start code watching.', true);
    }
  } catch (error) {
    console.error('ConfirmCode page code request error:', error);
    setStatus(error.message || 'Could not start code watching. Sign in to Gmail and try again.', true);
  } finally {
    pageButton.disabled = false;
  }
});

copyButton.addEventListener('click', async () => {
  const value = resultCode.textContent.trim();
  if (!/^\d{4,8}$/.test(value)) {
    setStatus('There is no code to copy yet.', true);
    return;
  }

  try {
    await navigator.clipboard.writeText(value);
    setStatus(`Code copied: ${value}`);
  } catch (error) {
    console.error('ConfirmCode clipboard error:', error);
    setStatus('Could not copy the code. Check your browser permissions.', true);
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;

  if (changes.lastEmail) {
    renderEmail(changes.lastEmail.newValue);
  }
  if (changes.accountEmail || changes.gmailAccounts || changes.gmailAccountSlot) {
    chrome.storage.local.get(['gmailAccounts', 'gmailAccountSlot']).then((stored) => {
      renderAccounts(stored.gmailAccounts || [], stored.gmailAccountSlot || '');
    }).catch((error) => {
      console.error('ConfirmCode could not update Gmail accounts:', error);
    });
  }
  if (changes.gmailSessionConnected) {
    chrome.storage.local.get(['accountEmail']).then((stored) => {
      setConnection(stored.accountEmail || '', changes.gmailSessionConnected.newValue === true);
    }).catch((error) => {
      console.error('ConfirmCode could not update Gmail session status:', error);
    });
  }
  if (changes.automationState) {
    const state = changes.automationState.newValue || { status: 'idle' };
    renderAutomationState(state);
    if (state.message) {
      setStatus(state.message, state.error);
    } else if (state.status === 'idle') {
      setStatus('Ready. Automatic fill is enabled.');
    }
  }
  if (changes.autoFillEnabled) {
    automationToggle.checked = changes.autoFillEnabled.newValue !== false;
  }
});

loadPopupState().catch((error) => {
  console.error('ConfirmCode popup initialization error:', error);
  setStatus('Could not load extension status.', true);
});
