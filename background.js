importScripts('gmail-service.js');

const WATCHES_KEY = 'pendingCodeWatches';
const WATCH_ALARM = 'poll-for-confirmation-code';
const WATCH_INTERVAL_MINUTES = 0.5;
const ACCOUNT_SLOT_KEY = 'gmailAccountSlot';
const activePolls = new Set();
let lastSyncPollAt = 0;
let checkingSyncSignal = false;

chrome.runtime.onInstalled.addListener(async () => {
  const { autoFillEnabled } = await chrome.storage.local.get(['autoFillEnabled']);
  if (typeof autoFillEnabled !== 'boolean') {
    await chrome.storage.local.set({ autoFillEnabled: true });
  }
  await restoreWatchAlarm();
});

chrome.runtime.onStartup.addListener(restoreWatchAlarm);

async function getWatches() {
  const stored = await chrome.storage.local.get([WATCHES_KEY]);
  return stored[WATCHES_KEY] || {};
}

async function getAccountSlot() {
  const stored = await chrome.storage.local.get([ACCOUNT_SLOT_KEY]);
  if (typeof stored[ACCOUNT_SLOT_KEY] === 'string') return stored[ACCOUNT_SLOT_KEY];

  const activeTabs = await chrome.tabs.query({
    active: true,
    currentWindow: true,
    url: 'https://mail.google.com/*'
  });
  const activeSlot = activeTabs[0]?.url?.match(/\/mail\/u\/(\d+)(?:[/?#]|$)/)?.[1];
  const slot = activeSlot || '0';
  await chrome.storage.local.set({ [ACCOUNT_SLOT_KEY]: slot });
  return slot;
}

async function findLatestCode(afterMs) {
  const slot = await getAccountSlot();
  const { email, result } = await ConfirmCodeGmail.fetchFeed(slot, afterMs);
  await chrome.storage.local.set({
    gmailSessionConnected: true,
    ...(email ? { accountEmail: email } : {})
  });
  return result;
}

async function checkGmailSession() {
  try {
    const slot = await getAccountSlot();
    const { email } = await ConfirmCodeGmail.fetchFeed(slot);
    await chrome.storage.local.set({
      gmailSessionConnected: true,
      ...(email ? { accountEmail: email } : {})
    });
    return { connected: true, email };
  } catch (error) {
    await chrome.storage.local.set({ gmailSessionConnected: false });
    return { connected: false, message: error.message };
  }
}

async function listGmailAccounts() {
  const accounts = await ConfirmCodeGmail.listAccounts();
  const stored = await chrome.storage.local.get([ACCOUNT_SLOT_KEY]);
  let selectedSlot = stored[ACCOUNT_SLOT_KEY];

  if (!accounts.length) {
    await chrome.storage.local.set({
      gmailAccounts: [],
      gmailSessionConnected: false
    });
    return { accounts: [], selectedSlot: null };
  }

  if (!accounts.some((account) => account.slot === selectedSlot)) {
    const activeTabs = await chrome.tabs.query({
      active: true,
      currentWindow: true,
      url: 'https://mail.google.com/*'
    });
    const activeSlot = activeTabs[0]?.url?.match(/\/mail\/u\/(\d+)(?:[/?#]|$)/)?.[1];
    selectedSlot = accounts.some((account) => account.slot === activeSlot)
      ? activeSlot
      : accounts[0].slot;
  }

  const selected = accounts.find((account) => account.slot === selectedSlot);
  await chrome.storage.local.set({
    [ACCOUNT_SLOT_KEY]: selectedSlot,
    gmailAccounts: accounts,
    gmailSessionConnected: true,
    accountEmail: selected.email
  });
  return { accounts, selectedSlot };
}

async function selectGmailAccount(slot) {
  if (typeof slot !== 'string' || !/^\d+$/.test(slot)) {
    throw new Error('Choose a valid Gmail account.');
  }

  const accounts = await ConfirmCodeGmail.listAccounts();
  const selected = accounts.find((account) => account.slot === slot);
  if (!selected) {
    throw new Error('That Gmail account is not signed in. Refresh the account list and try again.');
  }

  await chrome.storage.local.set({
    [ACCOUNT_SLOT_KEY]: slot,
    gmailAccounts: accounts,
    gmailSessionConnected: true,
    accountEmail: selected.email,
    lastEmail: null,
    lastCode: null
  });

  lastSyncPollAt = 0;
  const watches = await getWatches();
  await Promise.all(Object.keys(watches).map((tabId) => pollWatch(Number(tabId))));
  return { accounts, selectedSlot: slot, email: selected.email };
}

async function setAutomationState(state) {
  await chrome.storage.local.set({ automationState: { ...state, updatedAt: Date.now() } });
}

async function updateWaitingState(watches) {
  const active = Object.values(watches);
  if (!active.length) {
    await chrome.alarms.clear(WATCH_ALARM);
    await setAutomationState({ status: 'idle', message: '', watchCount: 0 });
    return;
  }

  await setAutomationState({
    status: 'waiting',
    message: active.length === 1
      ? `Waiting for a Gmail code for ${active[0].site}. Gmail sync triggers checks; a 30-second fallback is active.`
      : `Waiting for Gmail codes on ${active.length} verification pages. Gmail sync triggers checks; a 30-second fallback is active.`,
    startedAt: Math.min(...active.map((watch) => watch.requestedAt)),
    watchCount: active.length
  });
}

async function ensureWatchAlarm() {
  const existing = await chrome.alarms.get(WATCH_ALARM);
  if (!existing) {
    await chrome.alarms.create(WATCH_ALARM, {
      delayInMinutes: WATCH_INTERVAL_MINUTES,
      periodInMinutes: WATCH_INTERVAL_MINUTES
    });
  }
}

async function restoreWatchAlarm() {
  const watches = await getWatches();
  if (Object.keys(watches).length) {
    await ensureWatchAlarm();
    await updateWaitingState(watches);
  }
}

async function removeWatch(tabId, updateState = true) {
  const watches = await getWatches();
  delete watches[String(tabId)];
  await chrome.storage.local.set({ [WATCHES_KEY]: watches });
  if (updateState) await updateWaitingState(watches);
}

function createCodeNotification(tabId, result, filled) {
  const notificationId = `confirm-code-${tabId}`;
  const message = filled
    ? `A new code from ${result.from} was added to the verification field.`
    : `A new code from ${result.from} is ready. Return to the verification page.`;

  chrome.notifications.create(notificationId, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('notification-icon.png'),
    title: 'mailCode: code received',
    message,
    priority: 2
  }, () => {
    if (chrome.runtime.lastError) {
      console.error('ConfirmCode could not show a notification:', chrome.runtime.lastError.message);
    }
  });
}

async function completeWatch(tabId, watch, result) {
  await removeWatch(tabId, false);

  let filled = false;
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: 'apply-watched-code',
      result
    });
    filled = response?.filled === true;
  } catch (error) {
    console.info('ConfirmCode could not fill the verification tab:', error);
  }

  await chrome.storage.local.set({
    lastCode: result.code,
    lastEmail: { ...result, savedAt: Date.now() },
    source: 'automatic'
  });
  await setAutomationState({
    status: 'found',
    message: filled
      ? `Code received from “${result.subject}” and filled in ${watch.site}. The form was not submitted.`
      : `Code received from “${result.subject}”. Open ${watch.site} to enter it.`,
    result: { ...result, savedAt: Date.now() },
    watchCount: Object.keys(await getWatches()).length
  });

  createCodeNotification(tabId, result, filled);
  await updateWaitingStateAfterCompletion();
}

async function updateWaitingStateAfterCompletion() {
  const watches = await getWatches();
  if (Object.keys(watches).length) {
    await updateWaitingState(watches);
  } else {
    await chrome.alarms.clear(WATCH_ALARM);
  }
}

async function stopWatchForInvalidTab(tabId) {
  await removeWatch(tabId);
}

async function pollWatch(tabId) {
  const key = String(tabId);
  if (activePolls.has(key)) return { status: 'checking' };
  activePolls.add(key);

  try {
    const watches = await getWatches();
    const watch = watches[key];
    if (!watch) return { status: 'stopped' };

    try {
      const pageState = await chrome.tabs.sendMessage(tabId, { type: 'check-verification-field' });
      if (!pageState?.waiting) {
        await stopWatchForInvalidTab(tabId);
        return { status: 'stopped' };
      }
    } catch (error) {
      await stopWatchForInvalidTab(tabId);
      return { status: 'stopped' };
    }

    const result = await findLatestCode(Math.max(0, watch.requestedAt - 5 * 60 * 1000));

    if (result) {
      await completeWatch(tabId, watch, result);
      return { status: 'found', result };
    }

    await chrome.storage.local.set({
      [WATCHES_KEY]: {
        ...(await getWatches()),
        [key]: { ...watch, lastCheckedAt: Date.now() }
      }
    });
    await updateWaitingState(await getWatches());
    return { status: 'waiting' };
  } catch (error) {
    console.error('ConfirmCode code polling failed:', error);
    await setAutomationState({
      status: 'error',
      message: error.message || 'Could not check the Gmail session. ConfirmCode will try again.',
      error: true
    });
    return { status: 'error', message: error.message };
  } finally {
    activePolls.delete(key);
  }
}

async function startWatch(message, sender) {
  const tabId = sender.tab?.id;
  if (typeof tabId !== 'number') {
    return { status: 'error', message: 'Could not identify the verification page.' };
  }

  const { autoFillEnabled } = await chrome.storage.local.get(['autoFillEnabled']);
  if (autoFillEnabled === false) return { status: 'disabled' };

  const watches = await getWatches();
  const key = String(tabId);
  if (!watches[key]) {
    const hostname = (() => {
      try {
        return new URL(sender.url).hostname;
      } catch {
        return 'this page';
      }
    })();

    watches[key] = {
      tabId,
      site: hostname,
      requestedAt: message.requestedAt || Date.now(),
      lastCheckedAt: 0
    };
  }

  await chrome.storage.local.set({ [WATCHES_KEY]: watches });
  await ensureWatchAlarm();
  await updateWaitingState(watches);
  await pollWatch(tabId);
  const latest = await getWatches();
  if (latest[key]) {
    const { automationState } = await chrome.storage.local.get(['automationState']);
    return automationState?.status === 'error'
      ? { status: 'error', message: automationState.message }
      : { status: 'waiting' };
  }
  const { automationState } = await chrome.storage.local.get(['automationState']);
  return automationState?.status === 'found'
    ? { status: 'complete', result: automationState.result }
    : { status: 'stopped' };
}

async function searchLatestCode() {
  const result = await findLatestCode();
  if (!result) return { status: 'no-code' };

  await chrome.storage.local.set({
    lastCode: result.code,
    lastEmail: { ...result, savedAt: Date.now() },
    source: 'gmail-session'
  });
  return { status: 'code-found', result };
}

async function getCodeForPage(message, sender) {
  const tabId = sender.tab?.id;
  if (typeof tabId !== 'number') {
    return { status: 'error', message: 'Could not identify the verification page.' };
  }

  try {
    const result = await findLatestCode(
      message.requestedAt ? Math.max(0, message.requestedAt - 5 * 60 * 1000) : undefined
    );

    if (!result) return { status: 'no-code' };

    await chrome.storage.local.set({
      lastCode: result.code,
      lastEmail: { ...result, savedAt: Date.now() },
      source: 'gmail-session'
    });
    return { status: 'code-found', result };
  } catch (error) {
    console.error('ConfirmCode manual Gmail session search error:', error);
    return { status: 'error', message: error.message };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  let operation;
  if (message.type === 'start-code-watch') {
    operation = startWatch(message, sender);
  } else if (message.type === 'stop-code-watch') {
    operation = removeWatch(sender.tab?.id).then(() => ({ status: 'stopped' }));
  } else if (message.type === 'get-code-for-page') {
    operation = getCodeForPage(message, sender);
  } else if (message.type === 'search-latest-code') {
    operation = searchLatestCode();
  } else if (message.type === 'check-gmail-session') {
    operation = checkGmailSession();
  } else if (message.type === 'list-gmail-accounts') {
    operation = listGmailAccounts();
  } else if (message.type === 'select-gmail-account') {
    operation = selectGmailAccount(message.slot);
  } else if (message.type === 'poll-code-watch') {
    const tabId = sender.tab?.id;
    operation = typeof tabId === 'number'
      ? pollWatch(tabId)
      : Promise.resolve({ status: 'error', message: 'Could not identify the verification page.' });
  } else {
    return false;
  }

  operation
    .then(sendResponse)
    .catch((error) => {
      console.error('ConfirmCode background request failed:', error);
      sendResponse({ status: 'error', message: error.message });
    });
  return true;
});

chrome.webRequest.onBeforeRequest.addListener((details) => {
  const slot = details.url.match(/\/sync\/u\/(\d+)(?:\/|$)/)?.[1];
  if (!slot || details.tabId < 0 || checkingSyncSignal) return;
  checkingSyncSignal = true;

  chrome.tabs.get(details.tabId).then(async (tab) => {
    if (!tab.active) return;
    if (slot !== await getAccountSlot()) return;
    if (Date.now() - lastSyncPollAt < 10000) return;

    lastSyncPollAt = Date.now();
    const watches = await getWatches();
    if (!Object.keys(watches).length) return;

    await Promise.all(Object.keys(watches).map((tabId) => pollWatch(Number(tabId))));
  }).catch((error) => {
    console.error('ConfirmCode could not handle Gmail sync activity:', error);
  }).finally(() => {
    checkingSyncSignal = false;
  });
}, {
  urls: ['https://mail.google.com/sync/*']
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== WATCH_ALARM) return;
  getWatches()
    .then((watches) => Promise.all(
      Object.keys(watches).map((tabId) => pollWatch(Number(tabId)))
    ))
    .catch((error) => console.error('ConfirmCode could not poll pending codes:', error));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  removeWatch(tabId).catch((error) => {
    console.error('ConfirmCode could not clear a closed-tab watcher:', error);
  });
});

chrome.notifications.onClicked.addListener((notificationId) => {
  const match = notificationId.match(/^confirm-code-(\d+)$/);
  if (!match) return;
  chrome.tabs.update(Number(match[1]), { active: true }, () => {
    if (chrome.runtime.lastError) {
      console.info('ConfirmCode verification tab is no longer available.');
    }
  });
});

restoreWatchAlarm().catch((error) => {
  console.error('ConfirmCode could not restore code watching:', error);
});
