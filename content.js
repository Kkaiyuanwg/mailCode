(() => {
if (globalThis.confirmCodeContentLoaded) return;
globalThis.confirmCodeContentLoaded = true;

const VERIFICATION_TERMS = /(^|[^a-z0-9])(?:verification|verify|security|confirmation|confirm|passcode|one[- ]time|otp|code|c[oó]digo|seguridad|pin|confirmaci[oó]n)(?=$|[^a-z0-9])/i;
const FIELD_TERMS = /(^|[^a-z0-9])(?:verification|verify|security|confirmation|confirm|passcode|one[- ]time|otp|code|c[oó]digo|seguridad|pin|confirmaci[oó]n)(?=$|[^a-z0-9])/i;
let autoFillEnabled = true;
let autoTarget = null;
let autoRequestInFlight = false;
let autoStartedAt = 0;
let autoComplete = false;
let pageObserver = null;
let scanTimer = null;
let statusHost = null;
let statusRoot = null;
let statusTarget = null;

function showFieldStatus(input, message, state = 'waiting') {
  if (!input?.isConnected) return;

  if (!statusHost || statusTarget !== input || !statusHost.isConnected) {
    statusHost?.remove();
    statusTarget = input;
    statusHost = document.createElement('span');
    statusHost.setAttribute('data-confirmcode-status', '');
    statusHost.style.cssText = 'display:block;margin:5px 0 0;line-height:normal;';
    statusRoot = statusHost.attachShadow({ mode: 'closed' });
    const parentDisplay = input.parentElement
      ? window.getComputedStyle(input.parentElement).display
      : '';
    const insertAfter = ['flex', 'inline-flex', 'grid', 'inline-grid'].includes(parentDisplay)
      ? input.parentElement
      : input;
    insertAfter.insertAdjacentElement('afterend', statusHost);
  }

  const isComplete = state === 'complete';
  const isError = state === 'error';
  const label = document.createElement('span');
  label.className = 'status';
  label.setAttribute('aria-label', `mailCode: ${message}`);

  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 16 16');
  icon.setAttribute('aria-hidden', 'true');
  icon.classList.add('icon', isComplete ? 'complete' : isError ? 'error' : 'loading');

  if (state === 'complete') {
    const check = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    check.setAttribute('d', 'M3.5 8.2 6.5 11l6-6');
    icon.append(check);
  } else if (isError) {
    const mark = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    mark.setAttribute('d', 'M8 2.5v6M8 11.5v.1');
    icon.append(mark);
  } else {
    const spinner = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    spinner.setAttribute('cx', '8');
    spinner.setAttribute('cy', '8');
    spinner.setAttribute('r', '5.5');
    icon.append(spinner);
  }
  label.append(icon);

  const brand = document.createElement('span');
  brand.textContent = 'mailCode';
  brand.className = 'brand';
  label.append(brand);
  const style = document.createElement('style');
  style.textContent = `
    .status {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      color: #80868b;
      font: 400 10px/1.4 system-ui, sans-serif;
      vertical-align: top;
    }
    .icon {
      width: 13px;
      height: 13px;
      flex: 0 0 13px;
      fill: none;
      stroke: currentColor;
      stroke-linecap: round;
      stroke-linejoin: round;
      stroke-width: 1.7;
    }
    .icon.loading, .status.loading, .status.loading .brand { color: #80868b; }
    .icon.loading circle {
      stroke-dasharray: 24 11;
      transform-origin: center;
      animation: mailcode-spin .8s linear infinite;
    }
    .icon.complete, .status.complete, .status.complete .brand { color: #188038; }
    .icon.error, .status.error, .status.error .brand { color: #d93025; }
    .brand {
      font-weight: 600;
    }
    @keyframes mailcode-spin { to { transform: rotate(360deg); } }
    @media (prefers-color-scheme: dark) {
      .icon.loading, .status.loading, .status.loading .brand { color: #9aa0a6; }
      .icon.complete, .status.complete, .status.complete .brand { color: #81c995; }
      .icon.error, .status.error, .status.error .brand { color: #f28b82; }
    }
  `;
  statusRoot.replaceChildren(style, label);
  statusHost.setAttribute('role', 'status');
  statusHost.setAttribute('aria-live', 'polite');
}

function removeFieldStatus() {
  statusHost?.remove();
  statusHost = null;
  statusRoot = null;
  statusTarget = null;
}

function isVisible(element) {
  const style = window.getComputedStyle(element);
  return style.display !== 'none'
    && style.visibility !== 'hidden'
    && element.getClientRects().length > 0;
}

function getFieldDescription(input) {
  const label = input.labels ? [...input.labels].map((item) => item.innerText).join(' ') : '';
  return [
    input.name,
    input.id,
    input.placeholder,
    input.getAttribute('aria-label'),
    input.getAttribute('autocomplete'),
    label
  ].filter(Boolean).join(' ');
}

function findVerificationField() {
  const inputs = [...document.querySelectorAll('input, textarea')];
  const eligibleInputs = inputs.filter((input) => {
    if (!isVisible(input) || input.disabled || input.readOnly || input.value.trim()) return false;
    const type = input.type?.toLowerCase() || 'text';
    if (!['text', 'number', 'tel', 'search'].includes(type)) return false;
    return true;
  });
  if (!eligibleInputs.length) return null;

  const explicitField = eligibleInputs.find((input) => {
    const description = getFieldDescription(input).replace(/([a-z])([A-Z])/g, '$1 $2');
    const fieldMatches = FIELD_TERMS.test(description);
    const oneTimeCode = input.autocomplete?.toLowerCase() === 'one-time-code';
    if (input.maxLength === 1 && (fieldMatches || oneTimeCode)) {
      const fields = getSegmentedInputs(input);
      return fields.length >= 4 && fields.every((field) => !field.value.trim());
    }
    return oneTimeCode || fieldMatches;
  });
  if (explicitField) return explicitField;

  const pageContext = `${document.title} ${document.body?.innerText || ''}`;
  if (!VERIFICATION_TERMS.test(pageContext)) return null;
  return eligibleInputs.find((input) =>
    (input.maxLength >= 4 && input.maxLength <= 8)
    || (input.maxLength === 1 && getSegmentedInputs(input).length >= 4)
  ) || null;
}

function setInputValue(input, value) {
  const prototype = input instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (!setter) return false;

  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return input.value === value;
}

function getSegmentedInputs(input) {
  let container = input.parentElement;
  while (container && container !== document.body) {
    const fields = [...container.querySelectorAll('input')]
      .filter((field) => field.maxLength === 1 && isVisible(field) && !field.disabled && !field.readOnly);
    if (fields.length >= 4 && fields.length <= 8 && fields.includes(input)) {
      return fields;
    }
    container = container.parentElement;
  }
  return [];
}

function fillVerificationField(input, code) {
  if (!input || !/^\d{4,8}$/.test(code) || !input.isConnected || input.disabled || input.readOnly) {
    return false;
  }
  if (input.maxLength === 1) {
    const fields = getSegmentedInputs(input);
    if (fields.length !== code.length || fields.some((field) => field.value.trim())) return false;
    return fields.every((field, index) => setInputValue(field, code[index]));
  }
  if (input.value.trim() || (input.maxLength > 0 && code.length > input.maxLength)) return false;
  return setInputValue(input, code);
}

async function setAutomationState(message, error = false, status = 'error') {
  try {
    await chrome.storage.local.set({
      automationState: { status, message, error, updatedAt: Date.now() }
    });
  } catch (storageError) {
    console.error('ConfirmCode could not update automation status:', storageError);
  }
}

async function startCodeWatch(input) {
  if (autoRequestInFlight || !input?.isConnected) return;
  autoRequestInFlight = true;
  showFieldStatus(input, 'mailCode is connecting to Gmail…');
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'start-code-watch',
      requestedAt: autoStartedAt
    });

    if (response?.status === 'disabled') {
      await setAutomationState('Automatic code fill is paused.', true, 'idle');
      showFieldStatus(input, 'Automatic code fill is paused', 'error');
    } else if (response?.status === 'not-connected') {
      const message = 'Sign in to Gmail to wait for a code.';
      await setAutomationState(message, true);
      showFieldStatus(input, 'Sign in to Gmail and retry', 'error');
    } else if (response?.status === 'error') {
      const message = response.message || 'Sign in to Gmail to wait for a code.';
      await setAutomationState(message, true);
      showFieldStatus(input, 'Gmail check failed · open mailCode for details', 'error');
    } else if (response?.status === 'waiting') {
      showFieldStatus(input, 'Waiting for Gmail sync · 30-second fallback checks');
    } else if (response?.status === 'complete') {
      showFieldStatus(input, 'Code filled · form not submitted', 'complete');
    }
    return response;
  } catch (error) {
    console.error('ConfirmCode could not start Gmail code watching:', error);
    await setAutomationState('Could not start code watching. Open the extension and connect Gmail.', true);
    showFieldStatus(input, 'Could not connect to Gmail', 'error');
    return { status: 'error' };
  } finally {
    autoRequestInFlight = false;
  }
}

async function checkForVerificationRequest() {
  if (!autoFillEnabled || autoComplete || autoRequestInFlight) return;
  const input = findVerificationField();
  if (!input) {
    if (autoTarget && !autoComplete) {
      removeFieldStatus();
      chrome.runtime.sendMessage({ type: 'stop-code-watch' }).catch((error) => {
        console.error('ConfirmCode could not stop code watching:', error);
      });
    }
    autoTarget = null;
    autoStartedAt = 0;
    return;
  }
  if (input === autoTarget) return;

  autoTarget = input;
  autoStartedAt = Date.now();
  autoComplete = false;
  await startCodeWatch(input);
}

function startAutomaticDetection() {
  if (!pageObserver) {
    pageObserver = new MutationObserver(() => {
      if (statusTarget && !statusTarget.isConnected) removeFieldStatus();
      if (!autoFillEnabled || autoComplete || scanTimer) return;
      scanTimer = window.setTimeout(() => {
        scanTimer = null;
        checkForVerificationRequest();
      }, 250);
    });
    pageObserver.observe(document.documentElement, { childList: true, subtree: true });
  }
  checkForVerificationRequest();
}

function stopAutomaticDetection() {
  if (scanTimer) {
    window.clearTimeout(scanTimer);
    scanTimer = null;
  }
  pageObserver?.disconnect();
  pageObserver = null;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'apply-confirmation-code' || message.type === 'apply-watched-code') {
    const input = findVerificationField();
    const result = message.result;
    const code = result?.code || message.code;
    const filled = fillVerificationField(input, code);
    if (filled) {
      autoComplete = true;
      autoTarget = input;
      showFieldStatus(input, 'Code filled · form not submitted', 'complete');
    } else if (statusTarget?.isConnected) {
      showFieldStatus(statusTarget, 'Code found, but the verification field changed', 'error');
    }
    sendResponse({ filled });
    return;
  }

  if (message.type === 'check-verification-field') {
    const input = findVerificationField();
    sendResponse({ waiting: Boolean(input) });
    return;
  }

  if (message.type === 'request-confirmation-code') {
    const input = findVerificationField();
    if (!input) {
      sendResponse({ status: 'not-verification-page' });
      return;
    }

    autoTarget = input;
    autoStartedAt = Date.now();
    startCodeWatch(input).then((response) => sendResponse(response || { status: 'waiting' }));
    return true;
  }
});

chrome.storage.local.get(['autoFillEnabled']).then((stored) => {
  autoFillEnabled = stored.autoFillEnabled !== false;
  if (autoFillEnabled) startAutomaticDetection();
}).catch((error) => {
  console.error('ConfirmCode could not read automatic fill settings:', error);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;

  if (changes.autoFillEnabled) {
    autoFillEnabled = changes.autoFillEnabled.newValue !== false;
    if (autoFillEnabled) {
      autoComplete = false;
      autoTarget = null;
      startAutomaticDetection();
    } else {
      stopAutomaticDetection();
      removeFieldStatus();
      chrome.runtime.sendMessage({ type: 'stop-code-watch' }).catch((error) => {
        console.error('ConfirmCode could not stop code watching:', error);
      });
    }
  }

  if (changes.accountEmail?.newValue && autoFillEnabled) {
    autoComplete = false;
    autoTarget = null;
    autoStartedAt = Date.now();
    checkForVerificationRequest();
  }
});

})();
