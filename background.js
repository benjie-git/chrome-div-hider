/**
 * Div Hider — background service worker
 *
 * The performance strategy lives here: instead of injecting a content script
 * into every page, we compile the host list from the saved rules and register
 * one dynamic content script per host. Chrome then injects content.js only on
 * those hosts. Every other website runs with zero Div Hider JavaScript.
 *
 * Host access is optional and granted per host from the options page or popup.
 * The toolbar action is disabled by default and enabled only on hosts that have
 * a rule, using declarativeContent (which works without host permissions).
 */

const SCRIPT_PREFIX = 'divhider@';
const ACTION_RULE_PREFIX = 'divhider-action@';
const SCHEMES = ['http', 'https'];

function isValidHost(host) {
  if (typeof host !== 'string' || host.length === 0 || host.length > 253) return false;
  if (host === '*') return false;
  const body = host.startsWith('*.') ? host.slice(2) : host;
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i.test(body);
}

function normalizeHost(host) {
  return String(host || '').trim().toLowerCase().replace(/\.$/, '');
}

/** Exact hostname or wildcard subdomain (`*.example.com` includes example.com). */
function hostMatches(pattern, hostname) {
  const normalized = normalizeHost(pattern);
  if (!isValidHost(normalized)) return false;
  if (normalized.startsWith('*.')) {
    const base = normalized.slice(2);
    return hostname === base || hostname.endsWith(`.${base}`);
  }
  return hostname === normalized;
}

async function readRules() {
  const { rules } = await chrome.storage.local.get('rules');
  return Array.isArray(rules) ? rules : [];
}

function enabledHosts(rules) {
  return [
    ...new Set(
      rules
        .filter((rule) => rule && typeof rule === 'object' && rule.enabled !== false)
        .map((rule) => normalizeHost(rule.host))
        .filter(isValidHost),
    ),
  ];
}

/**
 * Which match patterns may we inject into for this host? Host access is
 * optional, so a rule can exist before the user grants it.
 */
async function grantedMatches(host) {
  const matches = [];
  for (const scheme of SCHEMES) {
    try {
      if (await chrome.permissions.contains({ origins: [`${scheme}://${host}/*`] })) {
        matches.push(`${scheme}://${host}/*`);
      }
    } catch {
      // Ignore an unparseable origin; other hosts should still sync.
    }
  }
  return matches;
}

/**
 * Enable the toolbar action only on rule hosts. This is declarative, so Chrome
 * handles it without waking the service worker on every navigation. It works
 * without host permissions, which is what lets the popup offer a Grant button
 * on a rule host that has not been granted yet.
 */
function buildActionRules(hosts) {
  const rules = [];
  for (const host of hosts) {
    const pageUrls = host.startsWith('*.')
      ? [
          { hostEquals: host.slice(2), schemes: SCHEMES },
          { hostSuffix: `.${host.slice(2)}`, schemes: SCHEMES },
        ]
      : [{ hostEquals: host, schemes: SCHEMES }];

    for (const pageUrl of pageUrls) {
      rules.push({
        id: `${ACTION_RULE_PREFIX}${rules.length}`,
        conditions: [new chrome.declarativeContent.PageStateMatcher({ pageUrl })],
        actions: [new chrome.declarativeContent.ShowAction()],
      });
    }
  }
  return rules;
}

function replaceActionRules(hosts) {
  return new Promise((resolve) => {
    const changed = chrome.declarativeContent.onPageChanged;
    changed.removeRules(undefined, () => {
      // Consume benign errors (for example, no rules to remove).
      void chrome.runtime.lastError;
      const rules = buildActionRules(hosts);
      if (rules.length === 0) {
        resolve();
        return;
      }
      changed.addRules(rules, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    });
  });
}

/**
 * Rebuild the dynamic content-script registrations from storage.
 * Only hosts with an enabled rule and a usable host permission get a script.
 */
async function syncRegistrations() {
  const rules = await readRules();
  const hosts = enabledHosts(rules);

  const registered = await chrome.scripting.getRegisteredContentScripts();
  const staleIds = registered
    .filter((script) => script.id.startsWith(SCRIPT_PREFIX))
    .map((script) => script.id);
  if (staleIds.length > 0) {
    await chrome.scripting.unregisterContentScripts({ ids: staleIds });
  }

  const batch = [];
  const skipped = [];

  for (const [index, host] of hosts.entries()) {
    const matches = await grantedMatches(host);
    if (matches.length === 0) {
      skipped.push(host);
      continue;
    }
    batch.push({
      // An index avoids embedding `*` and other host syntax in the script id.
      id: `${SCRIPT_PREFIX}${index}`,
      matches,
      js: ['content.js'],
      runAt: 'document_start',
      allFrames: true,
      matchOriginAsFallback: true,
      persistAcrossSessions: true,
    });
  }

  if (batch.length > 0) {
    await chrome.scripting.registerContentScripts(batch);
  }

  // The action should be available on every rule host, including hosts where
  // site access was not granted, so the popup can explain and fix it.
  try {
    await replaceActionRules(hosts);
  } catch {
    // Content-script registration is more important than the icon state.
  }

  return { hosts, skipped };
}

// Serialize syncs so overlapping triggers cannot interleave register/unregister
// calls. Each queued run rereads storage, so the last save always wins.
let queue = Promise.resolve();
function scheduleSync() {
  const run = queue.then(syncRegistrations, syncRegistrations);
  queue = run.catch(() => {});
  return run;
}

/**
 * Rules changed after a tab was opened: inject content.js into matching open
 * tabs now, so the user does not have to reload. The content-script guard makes
 * this a no-op where it is already running.
 */
async function applyToOpenTabs() {
  let rules;
  try {
    rules = await readRules();
  } catch {
    return;
  }
  const hosts = enabledHosts(rules);
  if (hosts.length === 0) return;

  let tabs;
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return;
  }

  for (const tab of tabs) {
    // Without host access Chrome omits tab.url. That is fine: those tabs have
    // either no rule or no permission, and future loads are covered by the
    // dynamic registration once the user grants access.
    if (!tab.id || !tab.url) continue;

    let hostname;
    try {
      hostname = new URL(tab.url).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (!hosts.some((host) => hostMatches(host, hostname))) continue;

    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ['content.js'],
      });
    } catch {
      // One restricted child frame can fail the all-frames call; retry the
      // top frame, which is where the popup reports status.
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js'],
        });
      } catch {
        // Restricted tab: future loads are still covered by the dynamic
        // registration.
      }
    }
  }
}

async function inspectHost(host) {
  const scripts = await chrome.scripting.getRegisteredContentScripts();
  const patterns = [];
  for (const script of scripts) {
    if (!script.id.startsWith(SCRIPT_PREFIX)) continue;
    for (const pattern of script.matches || []) patterns.push(pattern);
  }
  const registered = patterns.some((pattern) => {
    const match = /^[a-z*]+:\/\/([^/]+)\//i.exec(pattern);
    return match ? hostMatches(match[1], host) : false;
  });
  return { registered, patterns };
}

/** The action is opt-in per host; start with it disabled everywhere. */
async function resetAction() {
  try {
    await chrome.action.disable();
  } catch {
    // The action API is always available with an action in the manifest.
  }
  await scheduleSync();
  await applyToOpenTabs();
}

chrome.runtime.onInstalled.addListener((details) => {
  resetAction().catch(() => {});
  if (details.reason === 'install') {
    // With no rules yet, the action is disabled everywhere, so open the editor.
    chrome.runtime.openOptionsPage().catch(() => {});
  }
});

chrome.runtime.onStartup.addListener(() => {
  resetAction().catch(() => {});
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.rules) {
    scheduleSync()
      .then(applyToOpenTabs)
      .catch(() => {});
  }
});

// Site access can be changed from chrome://extensions or from the popup.
chrome.permissions.onAdded.addListener(() => {
  scheduleSync()
    .then(applyToOpenTabs)
    .catch(() => {});
});

chrome.permissions.onRemoved.addListener(() => {
  scheduleSync().catch(() => {});
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;

  if (message.type === 'divhider:inspect') {
    inspectHost(normalizeHost(message.host))
      .then(sendResponse)
      .catch((error) => sendResponse({ registered: false, patterns: [], error: String(error) }));
    return true;
  }

  if (message.type === 'divhider:sync') {
    scheduleSync()
      .then(async (result) => {
        await applyToOpenTabs();
        sendResponse({ ok: true, hosts: result.hosts, skipped: result.skipped });
      })
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  return false;
});
