/**
 * Div Hider — content script
 *
 * Injected at document_start, but only on hostnames that have an enabled rule
 * (see background.js). It bails immediately if no saved rule matches this host
 * or URL, otherwise it watches for matching elements and removes/hides them.
 *
 * Matching model:
 *   - host:  exact hostname or "*.example.com" (decides where the script loads)
 *   - URL:   optional JavaScript regex tested against the full href
 *   - key:   exact attribute name
 *   - value: optional JavaScript regex tested against the attribute value
 */
(() => {
  'use strict';

  // The background may inject this file into an already-open tab after a rule
  // is saved, even though the dynamic registration will also inject it on the
  // next load. Keep exactly one instance per frame.
  if (window.__divHiderContentLoaded) return;
  window.__divHiderContentLoaded = true;

  const HIDDEN_ATTR = 'data-divhider-hidden';

  /** Rules from storage. */
  let allRules = [];
  /** Rules whose host matches this page (includes URL-regex misses). */
  let hostRules = [];
  /** Fully compiled rules active for the current URL. */
  let active = [];
  /** href the current `active` list was compiled against. */
  let currentHref = '';
  /** MutationObserver, watching the document for new/changed elements. */
  let observer = null;
  /** Signature of the attribute filter currently installed on the observer. */
  let observerAttrs = null;

  function hostMatches(pattern, hostname) {
    const normalized = String(pattern || '').trim().toLowerCase().replace(/\.$/, '');
    if (!normalized) return false;
    if (normalized.startsWith('*.')) {
      const base = normalized.slice(2);
      return hostname === base || hostname.endsWith(`.${base}`);
    }
    return hostname === normalized;
  }

  /** Build the active rule set for the current URL. */
  function buildActive() {
    const href = location.href;
    const hostname = location.hostname.toLowerCase();

    hostRules = allRules.filter(
      (rule) =>
        rule &&
        typeof rule === 'object' &&
        rule.enabled !== false &&
        hostMatches(rule.host, hostname),
    );

    const next = [];
    for (const rule of hostRules) {
      const attr = String(rule.attr || '').trim();
      if (!attr) continue;

      const flags = rule.ignoreCase ? 'i' : '';
      let urlRegex = null;
      let valueRegex;
      try {
        valueRegex = new RegExp(String(rule.valueRegex ?? ''), flags);
        if (rule.urlRegex) urlRegex = new RegExp(String(rule.urlRegex), flags);
      } catch {
        continue; // Invalid regex saved by another client: ignore this rule.
      }

      if (urlRegex && !urlRegex.test(href)) continue;

      const selector = String(rule.selector || '*').trim() || '*';
      next.push({
        selector,
        attr,
        valueRegex,
        action: rule.action === 'hide' ? 'hide' : 'remove',
      });
    }

    active = next;
    currentHref = href;
  }

  function elementMatches(element, rule) {
    const value = element.getAttribute(rule.attr);
    return value !== null && rule.valueRegex.test(value);
  }

  function applyRule(element, rule) {
    console.debug('[Div Hider]', rule.action, rule.selector, `[${rule.attr}]`);
    if (rule.action === 'hide') {
      element.style.setProperty('display', 'none', 'important');
      element.setAttribute(HIDDEN_ATTR, '');
    } else {
      element.remove();
    }
  }

  /** Apply the first matching rule to an element, if any. */
  function checkElement(element) {
    if (!element || element.nodeType !== 1) return;
    if (!element.isConnected) return;
    if (element.hasAttribute(HIDDEN_ATTR)) return;

    for (const rule of active) {
      if (elementMatches(element, rule)) {
        applyRule(element, rule);
        return;
      }
    }
  }

  /**
   * Scan a newly added subtree (or the document root) once for all active
   * rules. Candidate nodes are collected by CSS selector first, then tested
   * against the attribute rules.
   */
  function scan(root) {
    if (!root || active.length === 0) return;
    if (root.nodeType !== 1 && root.nodeType !== 9) return;

    const candidates = new Set();
    const selectors = new Set(active.map((rule) => rule.selector));

    for (const selector of selectors) {
      if (selector === '*') {
        if (root.nodeType === 1) candidates.add(root);
        for (const element of root.querySelectorAll('*')) candidates.add(element);
      } else {
        try {
          if (root.nodeType === 1 && root.matches(selector)) candidates.add(root);
          for (const element of root.querySelectorAll(selector)) candidates.add(element);
        } catch {
          // Invalid selector stored by another client: skip it.
        }
      }
    }

    for (const element of candidates) checkElement(element);
  }

  function handleMutations(records) {
    // SPA navigations change the URL without a page load. Re-evaluate rules
    // whenever the URL changes, then rescan because previously ignored
    // elements may now match.
    if (location.href !== currentHref) {
      buildActive();
      installObserver();
      scan(document.documentElement || document);
      if (active.length === 0) return;
    }

    if (active.length === 0) return;

    for (const record of records) {
      if (record.type === 'attributes') {
        checkElement(record.target);
      } else {
        for (const node of record.addedNodes) {
          if (node.nodeType === 1) scan(node);
        }
      }
    }
  }

  /**
   * (Re)install the observer. The attribute filter is the union of every
   * active rule's attribute name, so unrelated attribute churn on the page
   * does not wake the callback (Chrome filters natively).
   */
  function installObserver() {
    const attrs = [...new Set(active.map((rule) => rule.attr))].sort();
    const signature = attrs.join('\u0000');

    if (observer && observerAttrs === signature) return;

    if (observer) observer.disconnect();
    observerAttrs = signature;
    observer = new MutationObserver(handleMutations);

    const target = document.documentElement || document;
    observer.observe(target, {
      childList: true,
      subtree: true,
      attributes: attrs.length > 0,
      attributeFilter: attrs.length > 0 ? attrs : undefined,
    });
  }

  /** Number of elements currently matching any active rule and not yet hidden. */
  function countMatches() {
    let count = 0;
    for (const rule of active) {
      let nodes;
      try {
        nodes = document.querySelectorAll(rule.selector);
      } catch {
        continue;
      }
      for (const element of nodes) {
        if (element.isConnected && !element.hasAttribute(HIDDEN_ATTR) && elementMatches(element, rule)) {
          count += 1;
        }
      }
    }
    return count;
  }

  function snapshot() {
    return {
      host: location.hostname,
      href: location.href,
      hostRules: hostRules.length,
      activeRules: active.length,
      matches: countMatches(),
      observing: Boolean(observer),
    };
  }

  async function refresh() {
    const { rules } = await chrome.storage.local.get('rules');
    allRules = Array.isArray(rules) ? rules : [];

    buildActive();

    if (active.length > 0) {
      console.info(`[Div Hider] ${active.length} rule(s) active on ${location.hostname}`);
    }

    if (hostRules.length === 0) {
      // Rules for this host were removed while the page was open. Stop
      // watching until something changes.
      if (observer) {
        observer.disconnect();
        observer = null;
        observerAttrs = null;
      }
      return;
    }

    if (!document.documentElement) {
      // Extremely early document: wait for the root element to appear.
      document.addEventListener(
        'readystatechange',
        () => {
          if (!document.documentElement) return;
          installObserver();
          scan(document.documentElement);
        },
        { once: true },
      );
      return;
    }

    installObserver();
    scan(document.documentElement);
  }

  window.addEventListener('popstate', refresh);
  window.addEventListener('hashchange', refresh);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.rules) refresh();
  });

  // Used by the toolbar popup to report whether this tab is actually covered
  // by the extension and whether any elements match right now.
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') return false;

    if (message.type === 'divhider:ping') {
      sendResponse(snapshot());
      return false;
    }

    if (message.type === 'divhider:rescan') {
      refresh()
        .then(() => sendResponse(snapshot()))
        .catch(() => sendResponse(snapshot()));
      return true;
    }

    return false;
  });

  refresh().catch(() => {
    // Storage failure should never surface as a page error.
  });
})();
