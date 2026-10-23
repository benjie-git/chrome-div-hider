# Div Hider

A small Chrome extension for deleting (or hiding) elements on specific sites by
matching an **exact attribute name** against a **regex value**.

Example rule: on `mail.yahoo.com`, find any `<section data-test-id="...">`
whose `data-test-id` value matches `novation.*` and remove it from the DOM.
(Yahoo's current markup uses a `<section>`; the selector field accepts any CSS
selector.)

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select this folder.
4. The rule editor opens on first install. You can also reach it later via
   **Details → Extension options** (or right-click the toolbar icon → Options).
5. Add a rule and click **Save**. Chrome asks for access to that host; allow it.

Rules are saved locally in `chrome.storage.local`. Saving applies them to
matching tabs that are already open; no reload is needed. The toolbar popup
shows whether the script is running on the current tab and how many elements
match right now. If access was denied, the rule card shows **Site access
needed** with a **Grant** button.

## Rule fields

| Field | Meaning |
| --- | --- |
| **Enabled** | Turn the rule off without deleting it. Disabled rules are not registered, so their hosts get no injected script. |
| **Host** | Exact hostname (`mail.yahoo.com`) or wildcard subdomains (`*.yahoo.com`). This is the fast pre-filter and decides where the content script is loaded. |
| **URL regex** | Optional JavaScript regex tested against the full URL (`location.href`). Use it when you only want part of a host, e.g. `^https://mail\.yahoo\.com/`. |
| **Element selector** | CSS selector used to find candidates, e.g. `div`, `.message`, `[role="main"] div`. Defaults to `*`. |
| **Attribute key** | Exact attribute name. Case is handled by the DOM, so write it as it appears in HTML, e.g. `data-test-id`. |
| **Attribute value regex** | JavaScript regex tested against the attribute value. Empty means "any value". |
| **Action** | `Remove from DOM` deletes the element. `Hide` sets `display: none !important`. |
| **Ignore case** | Adds the `i` flag to both regexes. |

Regexes are partial matches, like `RegExp.test()`. Use `^` and `$` if you need
the whole value.

### Example

```json
[
  {
    "host": "mail.yahoo.com",
    "selector": "section",
    "attr": "data-test-id",
    "valueRegex": "novation.*",
    "action": "remove"
  }
]
```

Paste that into **Import / export → Replace rules from JSON**, then save.

On a site with dynamic content (Yahoo Mail, most SPAs), the content script keeps
watching the DOM and removes elements that appear or change later. Already
removed elements stay removed; hidden elements are not automatically unhidden if
their attribute later stops matching.

## Why it does not slow down other sites

- Saved rules are compiled by the service worker into **dynamic content-script
  registrations**, one per host. Chrome injects `content.js` only on those
  hosts. On every other website, the extension injects **no JavaScript at all**.
- Host access is optional and granted per host. Until you grant a host, Chrome
  gives the extension no access to it, so unrelated sites are untouched.
- The toolbar action is enabled declaratively only on rule hosts. Chrome grays
  it out elsewhere without waking the background worker on every navigation.
- Within a registered host, the content script reads the rules and checks the
  optional URL regex once. If nothing matches the URL, it does no element
  processing; a lightweight child-list observer stays only to notice in-page
  URL changes (SPA navigation).
- When a rule is active, it uses one `MutationObserver` with
  `attributeFilter` set to the exact keys you care about, plus selector-scoped
  scanning of added subtrees. It never polls.
- Wildcard hosts (`*.example.com`) and URL regexes still only load the script on
  the matching host family; the regex itself is cheap.

Host rules are matched exactly (or by subdomain wildcard). The URL regex is
intended for path/query filtering on the selected host, not for discovering
hosts — that keeps injection cost at zero on unrelated sites.

## Permissions

- `storage` — save rules.
- `scripting` — register the per-host content scripts and apply rules to open
  tabs.
- `activeTab` — when you open the popup on a host that has a rule but no
  persistent access yet, lets the popup read that tab and offer **Grant site
  access**.
- `declarativeContent` — enables the toolbar action only on hosts with rules,
  without needing host permissions.
- **Optional host access** for `http://*/*` and `https://*/*` — not granted at
  install time. Chrome prompts for a specific host when you save a rule (or
  click **Grant**). Only granted hosts can be injected.

There is no install-time "read and change all your data on all websites"
warning. If you deny access, the rule is still saved; grant it later from the
rule card, the popup, or **chrome://extensions → Site access**.

If you previously loaded an older build that requested all-site access, click
**Reload** on `chrome://extensions` first. If Chrome still lists all-site access
for the extension, export your rules, remove the extension, load it unpacked
again, and import the rules.

## Toolbar icon

Chrome MV3 no longer supports a page-action icon that is hidden entirely on some
sites. Div Hider **disables** the action on hosts that have no rules, so Chrome
shows it grayed out and it will not open the popup there. On hosts with a rule
it is enabled. To remove it from the toolbar completely, unpin it in Chrome's
Extensions menu; it remains available there on every site.

## Notes and limitations

- Only attributes are matched, not text content.
- Open shadow DOM is not traversed.
- Cross-origin iframes are only changed if they have their own matching host
  rule. Same-origin/about:blank frames are covered by `allFrames`.
- If two rules match the same element, the first one in the list wins.
- Invalid regexes/selectors are rejected by the options page. If bad rules are
  imported some other way, the content script ignores them.
- The `hide` action is intentionally one-way to keep the observer cheap.
- Elements that the page removes and re-adds are handled each time they appear.
- If the popup says elements match but are still present, they may be inside
  shadow DOM, a cross-origin iframe, or a page that keeps recreating them.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | Manifest V3, permissions, icons. |
| `background.js` | Syncs rules into dynamic content-script registrations per host, enables the action only on rule hosts, and applies rules to open tabs. |
| `content.js` | Matches and removes/hides elements; watches the DOM on matching hosts. |
| `popup.html` / `popup.css` / `popup.js` | Status for the current tab: registration, injection, active rules, live match count, and a Grant access action. |
| `options.html` / `options.css` / `options.js` | Rule editor, validation, import/export. |
| `icons/` | Generated PNG icons. |
