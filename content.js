/**
 * Div Hider — content script
 *
 * Injected at document_start, but only on hostnames that have an enabled rule
 * (see background.js). It bails immediately if no saved rule matches this host
 * or URL, otherwise it watches for matching elements and removes/hides them.
 *
 * Matching model:
 *   - host:     exact hostname or "*.example.com" (decides where the script loads)
 *   - URL:      optional JavaScript regex tested against the full href
 *   - selector: full CSS selector, evaluated by the browser. Supports
 *               descendants, attribute selectors, :has(), etc.
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
  /** Rules whose host matches this page (includes URL-regex and legacy misses). */
  let hostRules = [];
  /** Fully compiled rules active for the current URL. */
  let active = [];
  /** Rules for this host that still carry the old attr/valueRegex fields. */
  let legacyRules = 0;
  /** href the current `active` list was compiled against. */
  let currentHref = '';
  /** MutationObserver, watching the document for new/changed elements. */
  let observer = null;

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
    legacyRules = 0;
    for (const rule of hostRules) {
      // The previous version stored a separate attribute key and value regex.
      // This version is selector-only; ignore those rules rather than letting
      // them degrade into a broad tag-only match. The options page disables
      // them so they can be updated deliberately.
      if (rule.attr || rule.valueRegex) {
        legacyRules += 1;
        continue;
      }

      const selector = String(rule.selector || '').trim();
      if (!selector) continue;

      const flags = rule.ignoreCase ? 'i' : '';
      let urlRegex = null;
      try {
        if (rule.urlRegex) urlRegex = new RegExp(String(rule.urlRegex), flags);
        // Reject invalid selectors saved by another client. A fragment parses
        // the selector without scanning the page's DOM.
        document.createDocumentFragment().querySelector(selector);
      } catch {
        continue;
      }

      if (urlRegex && !urlRegex.test(href)) continue;

      next.push({
        selector,
        action: rule.action === 'hide' ? 'hide' : 'remove',
      });
    }

    active = next;
    currentHref = href;
  }

  function matchesRule(element, rule) {
    try {
      return element.matches(rule.selector);
    } catch {
      return false;
    }
  }

  function applyRule(element, rule) {
    console.debug('[Div Hider]', rule.action, rule.selector);
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
      if (matchesRule(element, rule)) {
        applyRule(element, rule);
        return;
      }
    }
  }

  /**
   * Scan one root (an element or the document) with the browser's native CSS
   * selector engine. For an element root, the root itself is checked too.
   */
  function scanRoot(root) {
    if (!root || active.length === 0) return;

    const candidates = new Set();
    for (const rule of active) {
      try {
        if (root.nodeType === 1 && root.matches(rule.selector)) {
          candidates.add(root);
        }
        for (const element of root.querySelectorAll(rule.selector)) {
          candidates.add(element);
        }
      } catch {
        // Invalid selector stored by another client: skip it.
      }
    }

    for (const element of candidates) checkElement(element);
  }

  /** Check the element's ancestors; useful for selectors containing :has(). */
  function checkAncestors(element) {
    let node = element && element.parentElement;
    while (node) {
      checkElement(node);
      node = node.parentElement;
    }
  }

  function handleMutations(records) {
    // SPA navigations change the URL without a page load. Re-evaluate rules
    // whenever the URL changes, then rescan because previously ignored
    // elements may now match.
    if (location.href !== currentHref) {
      buildActive();
      installObserver();
      scanRoot(document);
      if (active.length === 0) return;
    }

    if (active.length === 0) return;

    // CSS selectors can depend on an element's own attributes, its ancestors
    // (`:has`), its descendants (`div.fancy a`), and its siblings (`+`, `~`,
    // :nth-child). Rescan the mutation's parent subtree to cover all of those,
    // then explicitly check ancestors for :has() matches above that subtree.
    const roots = new Set();
    const checkNodes = new Set();

    for (const record of records) {
      if (record.type === 'attributes') {
        const parent = record.target.parentElement;
        roots.add(parent || record.target);
        checkNodes.add(record.target);
        continue;
      }

      // childList: the target is the parent whose children changed.
      const parent = record.target.nodeType === 1 ? record.target : document.documentElement;
      if (parent) roots.add(parent);
      if (record.target.nodeType === 1) checkNodes.add(record.target);
      for (const node of record.addedNodes) {
        if (node.nodeType === 1) checkNodes.add(node);
      }
    }

    for (const root of roots) scanRoot(root);
    for (const node of checkNodes) {
      checkElement(node);
      checkAncestors(node);
    }
  }

  /**
   * Watch the whole document. Arbitrary CSS selectors can depend on any
   * attribute or on structural changes, so there is no useful attributeFilter.
   * Scanning is limited to the mutated parent subtree plus ancestors, not the
   * whole document, except when the mutation itself is near the root.
   *
   * When no rule is active for this URL, only structural changes are needed to
   * notice an in-page URL change; skipping attribute watching keeps that case
   * as light as possible.
   */
  function installObserver() {
    if (!observer) observer = new MutationObserver(handleMutations);
    observer.disconnect();
    observer.observe(document, {
      childList: true,
      subtree: true,
      attributes: active.length > 0,
    });
  }

  /** Number of elements currently matching any active rule and not yet hidden. */
  function countMatches() {
    const elements = new Set();
    for (const rule of active) {
      let nodes;
      try {
        nodes = document.querySelectorAll(rule.selector);
      } catch {
        continue;
      }
      for (const element of nodes) {
        if (element.isConnected && !element.hasAttribute(HIDDEN_ATTR)) {
          elements.add(element);
        }
      }
    }
    return elements.size;
  }

  function snapshot() {
    return {
      host: location.hostname,
      href: location.href,
      hostRules: hostRules.length,
      activeRules: active.length,
      legacyRules,
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
      }
      return;
    }

    installObserver();
    scanRoot(document);
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
