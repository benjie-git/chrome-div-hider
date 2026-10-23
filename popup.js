'use strict';

const els = {
  host: document.getElementById('host'),
  dot: document.getElementById('state-dot'),
  saved: document.getElementById('saved'),
  registered: document.getElementById('registered'),
  running: document.getElementById('running'),
  active: document.getElementById('active'),
  matches: document.getElementById('matches'),
  hint: document.getElementById('hint'),
  rescan: document.getElementById('rescan'),
  grant: document.getElementById('grant'),
  apply: document.getElementById('apply'),
  options: document.getElementById('options'),
};

let tab = null;
let currentHost = '';
let hostRules = 0;
let legacyRules = 0;
let needsAccess = false;

function isValidHost(host) {
  if (!host || host.length > 253 || host === '*') return false;
  const body = host.startsWith('*.') ? host.slice(2) : host;
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i.test(body);
}

function hostMatches(pattern, hostname) {
  const normalized = String(pattern || '').trim().toLowerCase().replace(/\.$/, '');
  if (!isValidHost(normalized)) return false;
  if (normalized.startsWith('*.')) {
    const base = normalized.slice(2);
    return hostname === base || hostname.endsWith(`.${base}`);
  }
  return hostname === normalized;
}

function setHint(text, kind = '') {
  els.hint.textContent = text;
  els.hint.className = `hint${kind ? ` ${kind}` : ''}`;
}

function setState(kind, label) {
  els.dot.className = `dot${kind ? ` ${kind}` : ''}`;
  els.dot.title = label;
}

function setRunning(running) {
  els.running.textContent = running ? 'running' : 'not running';
  els.running.className = running ? 'ok' : 'bad';
}

function setValue(element, value, kind = '') {
  element.textContent = String(value);
  element.className = kind;
}

async function ping() {
  let state = null;
  try {
    state = await chrome.tabs.sendMessage(tab.id, { type: 'divhider:ping' }, { frameId: 0 });
  } catch {
    state = null;
  }

  if (!state) {
    setRunning(false);
    setValue(els.active, '—');
    setValue(els.matches, '—');
    els.rescan.hidden = true;
    els.grant.hidden = !needsAccess;
    els.apply.hidden = hostRules === 0 || needsAccess;
    setState('bad', 'Content script is not running on this tab');
    if (legacyRules > 0) {
      setHint('A saved rule uses the old attribute/value fields. Open Edit rules and put the condition in the CSS selector.', 'warn');
    } else if (needsAccess) {
      setHint('This host has rules, but Div Hider needs site access. Grant it to run on future page loads.', 'warn');
    } else if (hostRules === 0) {
      setHint('No enabled rule targets this host. Add one in the options.', 'warn');
    } else {
      setHint('The content script is not running in this tab yet. Apply it without reloading, or reload the page.', 'warn');
    }
    return false;
  }

  setRunning(true);
  setValue(els.active, state.activeRules);
  setValue(els.matches, state.matches, state.matches > 0 ? 'bad' : 'ok');
  els.rescan.hidden = false;
  els.grant.hidden = !needsAccess;
  els.apply.hidden = true;
  setState(state.activeRules > 0 ? 'ok' : 'idle', state.activeRules > 0 ? 'Rules active' : 'Running, but no rule matches this URL');

  if (state.legacyRules > 0) {
    setHint('A saved rule uses the old attribute/value fields. Open Edit rules and put the condition in the CSS selector.', 'warn');
  } else if (state.hostRules > 0 && state.activeRules === 0) {
    setHint('A rule exists for this host, but its URL regex does not match this page.', 'warn');
  } else if (state.activeRules === 0) {
    setHint('No enabled rule matches this URL. Nothing will be changed here.');
  } else if (state.matches > 0) {
    setHint(
      'Elements match but are still present. They may be inside a cross-origin iframe, inside open shadow DOM, or being re-added by the page.',
      'warn',
    );
  } else if (!state.observing) {
    setHint('Rules are active but the DOM observer is not installed. Try Rescan.', 'error');
  } else {
    setHint('Working. Matching elements are removed or hidden as they appear.');
  }
  return true;
}

async function inspect() {
  try {
    return await chrome.runtime.sendMessage({ type: 'divhider:inspect', host: new URL(tab.url).hostname });
  } catch {
    return { registered: false, patterns: [] };
  }
}

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab || !tab.url || !/^https?:/i.test(tab.url)) {
    els.host.textContent = tab && tab.url ? 'Not a website' : 'No access';
    setValue(els.saved, '—');
    setValue(els.registered, '—');
    setRunning(false);
    setValue(els.active, '—');
    setValue(els.matches, '—');
    els.grant.hidden = true;
    els.apply.hidden = true;
    setHint(
      tab && tab.url
        ? 'Div Hider only runs on http and https pages.'
        : 'Div Hider only activates on hosts with saved rules. Add one in the options.',
    );
    setState('idle', 'Not a website');
    return;
  }

  const hostname = new URL(tab.url).hostname.toLowerCase();
  currentHost = hostname;
  els.host.textContent = hostname;
  els.host.title = tab.url;

  let rules = [];
  try {
    const stored = await chrome.storage.local.get('rules');
    rules = Array.isArray(stored.rules) ? stored.rules : [];
  } catch {
    rules = [];
  }

  hostRules = rules.filter(
    (rule) => rule && typeof rule === 'object' && rule.enabled !== false && hostMatches(rule.host, hostname),
  ).length;
  legacyRules = rules.filter(
    (rule) =>
      rule &&
      typeof rule === 'object' &&
      rule.enabled !== false &&
      hostMatches(rule.host, hostname) &&
      (String(rule.attr ?? '').trim() || String(rule.valueRegex ?? '').trim()),
  ).length;
  setValue(els.saved, hostRules);

  const registration = await inspect();
  needsAccess = hostRules > 0 && !registration.registered;
  els.grant.hidden = !needsAccess;
  setValue(els.registered, registration.registered ? 'yes' : 'no', registration.registered ? 'ok' : 'bad');

  const running = await ping();

  if (legacyRules > 0) {
    setHint('A saved rule uses the old attribute/value fields. Open Edit rules and put the condition in the CSS selector.', 'warn');
  } else if (running && !registration.registered && hostRules > 0) {
    setHint(
      'Running now, but this host is not registered for future page loads. Click Grant site access to keep it running after reloads.',
      'warn',
    );
  } else if (!running && hostRules > 0 && !registration.registered) {
    setHint(
      'This host has rules, but Div Hider does not have site access. Click Grant site access to allow it.',
      'warn',
    );
  }
}

async function applyToTab() {
  els.apply.disabled = true;
  setHint('Injecting the content script…');
  try {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ['content.js'],
      });
    } catch {
      // A restricted child frame can make the all-frames injection fail;
      // the top frame is what matters for the popup status.
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js'],
      });
    }
  } catch (error) {
    setHint(`Could not run on this tab: ${error.message}`, 'error');
    els.apply.disabled = false;
    return;
  }
  els.apply.disabled = false;
  await ping();
}

async function grantAccess() {
  if (!currentHost) return;
  els.grant.disabled = true;
  try {
    const granted = await chrome.permissions.request({
      origins: [`http://${currentHost}/*`, `https://${currentHost}/*`],
    });
    if (!granted) {
      setHint('Site access was not granted. You can retry, or use the Grant button on the rule in the options.', 'warn');
      return;
    }

    try {
      await chrome.runtime.sendMessage({ type: 'divhider:sync' });
    } catch {
      // The background's permissions.onAdded listener also triggers a sync.
    }

    const registration = await inspect();
    needsAccess = hostRules > 0 && !registration.registered;
    els.grant.hidden = !needsAccess;
    setValue(els.registered, registration.registered ? 'yes' : 'no', registration.registered ? 'ok' : 'bad');

    const running = await ping();
    if (!needsAccess) {
      setHint(
        running
          ? 'Site access granted. This host is registered for future page loads.'
          : 'Site access granted. Reload this page to start Div Hider.',
        running ? '' : 'warn',
      );
    }
  } catch (error) {
    setHint(`Could not request site access: ${error.message}`, 'error');
  } finally {
    els.grant.disabled = false;
  }
}

els.rescan.addEventListener('click', async () => {
  els.rescan.disabled = true;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'divhider:rescan' }, { frameId: 0 });
  } catch {
    // ping() below reports the state.
  }
  els.rescan.disabled = false;
  await ping();
});

els.apply.addEventListener('click', applyToTab);
els.grant.addEventListener('click', grantAccess);

els.options.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

init().catch((error) => {
  setHint(`Could not read this tab: ${error.message}`, 'error');
  setState('bad', 'Error');
});
