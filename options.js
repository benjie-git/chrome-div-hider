'use strict';

const STORAGE_KEY = 'rules';

const HOST_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i;

const els = {
  rules: document.getElementById('rules'),
  empty: document.getElementById('empty'),
  template: document.getElementById('rule-template'),
  add: document.getElementById('add-rule'),
  addExample: document.getElementById('add-example'),
  save: document.getElementById('save'),
  notice: document.getElementById('notice'),
  noticeText: document.getElementById('notice-text'),
  ioText: document.getElementById('io-text'),
  export: document.getElementById('export'),
  import: document.getElementById('import'),
  toast: document.getElementById('toast'),
};

/** @type {Array<Record<string, any>>} */
let rules = [];
let dirty = false;
let toastTimer = 0;
let toastHideTimer = 0;
let accessTimer = 0;
let accessRun = 0;

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

function normalizeHost(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
}

function isValidHost(host) {
  if (!host || host.length > 253 || host === '*') return false;
  const body = host.startsWith('*.') ? host.slice(2) : host;
  return HOST_RE.test(body);
}

function normalizeRule(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    id: typeof source.id === 'string' && source.id ? source.id : uid(),
    enabled: source.enabled !== false,
    host: String(source.host ?? ''),
    urlRegex: String(source.urlRegex ?? ''),
    selector: String(source.selector ?? 'div'),
    attr: String(source.attr ?? ''),
    valueRegex: String(source.valueRegex ?? ''),
    action: source.action === 'hide' ? 'hide' : 'remove',
    ignoreCase: Boolean(source.ignoreCase),
  };
}

function normalizeRuleList(rawList) {
  const seen = new Set();
  return rawList.map((raw) => {
    const rule = normalizeRule(raw);
    if (seen.has(rule.id)) rule.id = uid();
    seen.add(rule.id);
    return rule;
  });
}

function regexError(value, ignoreCase) {
  const text = String(value ?? '');
  if (!text) return '';
  try {
    new RegExp(text, ignoreCase ? 'i' : '');
    return '';
  } catch (error) {
    return `Invalid regex — ${error.message}`;
  }
}

function fieldError(rule, key) {
  switch (key) {
    case 'host': {
      const host = normalizeHost(rule.host);
      if (!host) return 'Host is required.';
      if (host === '*') return 'Use *.example.com rather than a bare *.';
      if (host.length > 253) return 'Host is too long.';
      if (!isValidHost(host)) return 'Use an exact hostname (mail.yahoo.com) or *.example.com.';
      return '';
    }
    case 'urlRegex':
      return regexError(rule.urlRegex, rule.ignoreCase);
    case 'selector': {
      const selector = String(rule.selector ?? '').trim();
      if (!selector) return 'CSS selector is required.';
      try {
        document.createDocumentFragment().querySelector(selector);
      } catch {
        return 'Invalid CSS selector.';
      }
      return '';
    }
    case 'attr': {
      const attr = String(rule.attr ?? '').trim();
      if (!attr) return 'Attribute key is required.';
      if (!/^[^\s"'<>/=]+$/.test(attr)) {
        return 'Attribute names cannot contain quotes, spaces, or < > / =.';
      }
      return '';
    }
    case 'valueRegex':
      return regexError(rule.valueRegex, rule.ignoreCase);
    default:
      return '';
  }
}

function setDirty(next) {
  dirty = next;
  els.save.disabled = !dirty;
  els.notice.hidden = !dirty;
  els.noticeText.textContent = 'Unsaved changes. Save to apply them to your browser.';
}

function showToast(message, kind = 'ok') {
  clearTimeout(toastTimer);
  clearTimeout(toastHideTimer);
  els.toast.hidden = false;
  els.toast.className = `toast${kind === 'ok' ? '' : ` ${kind}`}`;
  // Force a reflow so the entrance transition runs every time.
  void els.toast.offsetWidth;
  els.toast.classList.add('visible');
  toastTimer = window.setTimeout(() => {
    els.toast.classList.remove('visible');
    toastHideTimer = window.setTimeout(() => {
      els.toast.hidden = true;
    }, 220);
  }, 3200);
}

async function hostAccess(host) {
  const origins = [`http://${host}/*`, `https://${host}/*`];
  let results = [false, false];
  try {
    results = await Promise.all(
      origins.map((origin) => chrome.permissions.contains({ origins: [origin] })),
    );
  } catch {
    // Treat an unreadable permission as missing.
  }
  return { http: Boolean(results[0]), https: Boolean(results[1]) };
}

async function refreshAccess() {
  const run = ++accessRun;
  for (const card of els.rules.querySelectorAll('.rule')) {
    const rule = rules.find((candidate) => candidate.id === card.dataset.id);
    if (!rule) continue;

    const access = card.querySelector('[data-role="access"]');
    const text = card.querySelector('[data-role="access-text"]');
    const host = normalizeHost(rule.host);

    if (!rule.enabled || !isValidHost(host)) {
      access.hidden = true;
      continue;
    }

    const state = await hostAccess(host);
    if (run !== accessRun) return;
    if (!card.isConnected) continue;

    if (state.http && state.https) {
      access.hidden = true;
    } else {
      access.hidden = false;
      text.textContent = state.http || state.https ? 'Limited site access' : 'Site access needed';
    }
  }
}

function scheduleAccessRefresh() {
  clearTimeout(accessTimer);
  accessTimer = window.setTimeout(() => {
    refreshAccess().catch(() => {});
  }, 180);
}

async function grantAccess(card, rule) {
  const host = normalizeHost(rule.host);
  if (!isValidHost(host)) {
    showToast('Enter a valid host before granting access.', 'error');
    card.querySelector('[data-field="host"]').focus();
    return;
  }

  const button = card.querySelector('[data-action="grant"]');
  button.disabled = true;
  try {
    const granted = await chrome.permissions.request({
      origins: [`http://${host}/*`, `https://${host}/*`],
    });
    if (!granted) {
      showToast(`Chrome did not grant access to ${host}.`, 'warn');
    } else {
      showToast(`Site access granted for ${host}.`);
      if (!dirty) {
        try {
          await chrome.runtime.sendMessage({ type: 'divhider:sync' });
        } catch {
          // The permissions event also triggers a sync in the background.
        }
      }
    }
  } catch (error) {
    showToast(`Could not request site access: ${error.message}`, 'error');
  } finally {
    button.disabled = false;
    await refreshAccess();
  }
}

function updateCardChrome(card, rule) {
  const host = normalizeHost(rule.host);
  card.querySelector('[data-role="pill"]').textContent = host || 'no host';

  const selector = String(rule.selector ?? '').trim() || '?';
  const attr = String(rule.attr ?? '').trim();
  let summary = selector + (attr ? `[${attr}]` : '');
  if (rule.valueRegex) summary += ` ~ /${rule.valueRegex}/`;
  card.querySelector('[data-role="id"]').textContent = summary;
}

function validateCard(card, rule) {
  if (card.dataset.validated !== '1') return true;

  let valid = true;
  for (const key of ['host', 'urlRegex', 'selector', 'attr', 'valueRegex']) {
    const message = fieldError(rule, key);
    const err = card.querySelector(`[data-err="${key}"]`);
    const input = card.querySelector(`[data-field="${key}"]`);

    if (message) {
      valid = false;
      err.textContent = message;
      err.classList.add('visible');
      input.classList.add('invalid');
      input.setAttribute('aria-invalid', 'true');
    } else {
      err.textContent = '';
      err.classList.remove('visible');
      input.classList.remove('invalid');
      input.removeAttribute('aria-invalid');
    }
  }
  return valid;
}

function createCard(rule) {
  const card = els.template.content.firstElementChild.cloneNode(true);
  card.dataset.id = rule.id;
  card.dataset.validated = '1';

  for (const input of card.querySelectorAll('[data-field]')) {
    const key = input.dataset.field;

    if (input.type === 'checkbox') input.checked = Boolean(rule[key]);
    else input.value = rule[key] ?? '';

    const onEdit = () => {
      rule[key] = input.type === 'checkbox' ? input.checked : input.value;
      setDirty(true);
      if (card.dataset.validated === '1') validateCard(card, rule);
      updateCardChrome(card, rule);
      scheduleAccessRefresh();
    };

    input.addEventListener('input', onEdit);
    input.addEventListener('change', onEdit);
    input.addEventListener('blur', () => {
      card.dataset.validated = '1';
      validateCard(card, rule);
    });
  }

  card.querySelector('[data-action="delete"]').addEventListener('click', () => {
    rules = rules.filter((candidate) => candidate.id !== rule.id);
    render();
    setDirty(true);
  });

  card.querySelector('[data-action="grant"]').addEventListener('click', () => {
    grantAccess(card, rule);
  });

  updateCardChrome(card, rule);
  return card;
}

function render() {
  els.rules.replaceChildren(...rules.map(createCard));
  els.empty.hidden = rules.length > 0;
  refreshAccess().catch(() => {});
}

function addRule(partial = {}) {
  const rule = normalizeRule({
    id: uid(),
    enabled: true,
    selector: 'div',
    attr: '',
    ...partial,
  });
  rules.push(rule);
  render();

  const card = [...els.rules.children].find((element) => element.dataset.id === rule.id);
  if (card) {
    delete card.dataset.validated;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.querySelector('[data-field="host"]').focus({ preventScroll: true });
  }
  setDirty(true);
}

async function saveRules() {
  let valid = true;
  for (const card of els.rules.querySelectorAll('.rule')) {
    const rule = rules.find((candidate) => candidate.id === card.dataset.id);
    if (!rule) continue;
    card.dataset.validated = '1';
    if (!validateCard(card, rule)) valid = false;
  }

  if (!valid) {
    showToast('Fix the highlighted fields before saving.', 'error');
    els.rules.querySelector('.err.visible')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }

  const hosts = [
    ...new Set(
      rules
        .filter((rule) => rule.enabled && isValidHost(normalizeHost(rule.host)))
        .map((rule) => normalizeHost(rule.host)),
    ),
  ];
  const origins = hosts.flatMap((host) => [`http://${host}/*`, `https://${host}/*`]);

  // Ask while the Save click still counts as a user gesture. Saving proceeds
  // even if access is denied, so the rule is not lost; the card then offers
  // Grant as a retry.
  let permissionPromise = null;
  if (origins.length > 0) {
    try {
      permissionPromise = chrome.permissions.request({ origins });
      permissionPromise.catch(() => {});
    } catch {
      permissionPromise = null;
    }
  }

  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: rules });
  } catch (error) {
    showToast(`Could not save rules: ${error.message}`, 'error');
    return;
  }

  setDirty(false);

  let permissionsGranted = true;
  if (permissionPromise) {
    try {
      permissionsGranted = await permissionPromise;
    } catch {
      permissionsGranted = false;
    }
  }

  let result = null;
  try {
    result = await chrome.runtime.sendMessage({ type: 'divhider:sync' });
  } catch {
    // Saving is still valid; the storage event triggers the same sync.
  }

  await refreshAccess();

  if (result && result.ok === false) {
    showToast(`Saved, but content scripts could not be registered: ${result.error}`, 'error');
  } else if (result && Array.isArray(result.skipped) && result.skipped.length > 0) {
    showToast(
      `Saved, but site access is missing for ${result.skipped.join(', ')}. Click Grant on the rule, then retry.`,
      'warn',
    );
  } else if (!permissionsGranted && hosts.length > 0) {
    showToast('Saved, but Chrome did not grant site access. Click Grant on the rule to retry.', 'warn');
  } else {
    showToast(
      rules.length === 1 ? 'Rule saved and applied.' : `${rules.length} rules saved and applied.`,
    );
  }
}

async function importRules() {
  try {
    const parsed = JSON.parse(els.ioText.value);
    if (!Array.isArray(parsed)) throw new Error('Expected a JSON array of rule objects.');
    if (parsed.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry))) {
      throw new Error('Every array entry must be a rule object.');
    }

    rules = normalizeRuleList(parsed);
    render();
    setDirty(true);
    els.ioText.value = '';
    showToast(`Loaded ${rules.length} rule${rules.length === 1 ? '' : 's'}. Save to apply.`);
  } catch (error) {
    showToast(`Import failed: ${error.message}`, 'error');
  }
}

async function exportRules() {
  const json = JSON.stringify(rules, null, 2);
  els.ioText.value = json;
  els.ioText.focus();
  els.ioText.select();

  try {
    await navigator.clipboard.writeText(json);
    showToast('JSON copied to the clipboard.');
  } catch {
    showToast('JSON shown below — copy it manually.');
  }
}

els.add.addEventListener('click', () => addRule());

els.addExample.addEventListener('click', () => {
  addRule({
    host: 'mail.yahoo.com',
    selector: 'section',
    attr: 'data-test-id',
    valueRegex: 'novation.*',
    action: 'remove',
  });
});

els.save.addEventListener('click', () => {
  saveRules();
});

els.export.addEventListener('click', () => {
  exportRules();
});

els.import.addEventListener('click', () => {
  importRules();
});

document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    if (!els.save.disabled) els.save.click();
  }
});

window.addEventListener('beforeunload', (event) => {
  if (!dirty) return;
  event.preventDefault();
  event.returnValue = '';
});

chrome.permissions.onAdded.addListener(() => {
  refreshAccess().catch(() => {});
});

chrome.permissions.onRemoved.addListener(() => {
  refreshAccess().catch(() => {});
});

async function init() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    rules = Array.isArray(stored[STORAGE_KEY]) ? normalizeRuleList(stored[STORAGE_KEY]) : [];
  } catch (error) {
    rules = [];
    showToast(`Could not load rules: ${error.message}`, 'error');
  }

  render();
  setDirty(false);
}

init();
