# Dead-Click & Rage-Click Telemetry

Privacy-first, local-only instrumentation that detects clicks on controls that
produce no observable effect (**dead clicks**) and rapid repeated dead clicks on
the same control (**rage clicks**).

## Architecture

```
dead_click_detector.js    UMD module — injectable into any page
__diag.html / __diag.js   Live diagnostics dashboard (last 200 events)
tests/playwright/
  test_dead_click_tripwire.py   Fast CI tripwire (representative clicks)
  test_email_view_all_clickables.py   Full inventory test (Codex)
scripts/check_testids.js  CI check: every interactive control has data-testid
```

### How it works

1. A **capture-phase click listener** on the app root intercepts every click.
2. For each click on an interactive element, the detector watches for **activity
   signals** for 750 ms:
   - DOM mutations (via MutationObserver scoped to the container)
   - URL / navigation change
   - `aria-expanded` / `aria-pressed` / `aria-selected` toggle
   - Network activity (via `PerformanceObserver("resource")`, falls back to
     `fetch()` / `XMLHttpRequest` wrapping if unavailable)
3. If **none** fire → a `dead_click` event is recorded.
4. If ≥ 5 dead clicks hit the **same control** within 3 seconds → a `rage_click`
   event is recorded.

### False-positive suppression

Certain clicks are **automatically suppressed** and never recorded as dead:

| Condition | Rationale |
|-----------|-----------|
| `disabled` / `aria-disabled="true"` | Disabled controls are not expected to respond |
| `<input>`, `<select>`, `<textarea>` | Focus-only elements; click gives focus, not a visible mutation |
| `data-testid` or `aria-label` contains "copy" | Clipboard-copy buttons write to clipboard (not observable via DOM) |
| `role="tab"` with `aria-selected="true"` | Re-clicking the already-active tab is idempotent |
| **User allowlist** matches | Custom entries passed via `install({ allowlist })` |

#### Allowlist format

```js
DeadClickDetector.install(root, {
  allowlist: [
    { testId: 'btn-settings' },           // match by data-testid
    { selector: '.my-widget button' },     // match by CSS selector
    { role: 'tab', name: 'Overview' },     // match role + accessible name
  ],
});

// Add entries at runtime:
DeadClickDetector.addAllowlistEntry({ testId: 'btn-new-feature' });
```

Each entry can have any combination of `testId`, `selector`, `role`, and `name`.
All **non-null** fields must match for the entry to suppress a click.

### Privacy guarantees

The detector **never** captures email subject, body, or user content.  Recorded
fields:

| Field            | Source                       |
|------------------|------------------------------|
| `route`          | `location.pathname + hash`   |
| `testId`         | `data-testid` attribute      |
| `role`           | ARIA role                    |
| `accessibleName` | `aria-label` (trimmed ≤ 80)  |
| `textHash`       | FNV-1a hash of visible text  |
| `bbox`           | Bounding box (x, y, w, h)   |
| `ts`             | `Date.now()` timestamp       |

---

## Quick start

### Install in your app (dev builds)

```js
// After page load:
DeadClickDetector.install(document.getElementById('app'), {
  container: document.querySelector('[data-testid="email-view"]'),
  devMode: true,     // console.error + non-blocking toast
  observeMs: 750,    // observation window (ms)
});
```

### Open the diagnostics dashboard

Open `__diag.html` from the extension or serve it alongside your app:

```
moz-extension://<extension-id>/__diag.html
```

The dashboard auto-refreshes every 2 seconds and shows:
- All dead-click / rage-click events (newest first)
- Filter by type or search by testid / route / name
- Export as JSON for offline analysis

### Playwright test hooks

```js
// In page context:
window.__deadClicks        // Array of events (live reference)
window.__deadClickDetector // The detector API object

// Reset between test steps:
window.__deadClickDetector.reset();
```

---

## CI integration

### 1. Dead-click tripwire test

```bash
# Requires EMAIL_VIEW_BASE_URL
EMAIL_VIEW_BASE_URL=http://localhost:3000 \
  python -m pytest tests/playwright/test_dead_click_tripwire.py -v
```

This test:
1. Opens the email view
2. Injects `dead_click_detector.js`
3. Clicks a handful of representative controls (configurable via
   `DEAD_CLICK_REPRESENTATIVE` env var)
4. Asserts `window.__deadClicks.length === 0`

**Difference from the full inventory test:**  The tripwire is fast (seconds) and
checks a curated set of controls.  `test_email_view_all_clickables.py` probes
*every* discoverable control and is heavier.

### 2. data-testid enforcement

```bash
EMAIL_VIEW_BASE_URL=http://localhost:3000 node scripts/check_testids.js
```

Exits non-zero if any visible interactive control in the email view container
lacks `data-testid`.  Set `TESTID_EXIT_ZERO=1` for advisory (dry-run) mode.

**Scope rules:**
- Only controls inside the email view container are checked (not the whole page).
- Controls inside the **rendered email body** are excluded — these are user
  content (links in the email itself), not app controls.
- Built-in exclusions: `a[href^='mailto:']` and `a[href^='tel:']` links.
- Additional exclusions via `TESTID_ALLOW_MISSING` (comma-separated CSS selectors).

### 3. Unit tests

```bash
npm run test:dead-clicks
```

Runs Jest unit tests for the detector module.  Included in the pre-push gate.

---

## Adding data-testid to controls

Every interactive element in the email view should have a unique, stable
`data-testid`:

```html
<button data-testid="btn-reply">Reply</button>
<button data-testid="btn-forward">Forward</button>
<button data-testid="btn-archive">Archive</button>
<a data-testid="link-attachment-invoice" href="...">invoice.pdf</a>
```

Naming convention: `{type}-{action}[-{qualifier}]`

| Prefix  | Use for          |
|---------|------------------|
| `btn-`  | Buttons          |
| `link-` | Anchor links     |
| `menu-` | Menu triggers    |
| `tab-`  | Tab switches     |
| `input-`| Form inputs      |

---

## Environment variables

| Variable                       | Default | Description |
|--------------------------------|---------|-------------|
| `EMAIL_VIEW_BASE_URL`          | —       | Target email app URL (required for Playwright tests) |
| `DEAD_CLICK_OBSERVE_MS`        | `750`   | Observation window override |
| `DEAD_CLICK_DEV_MODE`          | `0`     | `1` to enable toasts in tripwire test |
| `DEAD_CLICK_REPRESENTATIVE`    | *(see source)* | Comma-separated testid values to click |
| `TESTID_EXIT_ZERO`             | `0`     | `1` for advisory testid check |
| `TESTID_ALLOW_MISSING`         | —       | CSS selectors for controls allowed to skip testid |

All `EMAIL_VIEW_*` variables from `email_view_clickables_helpers.py` are also
supported by the tripwire test.

---

## Overlap with existing tests

| Test file | Purpose | Speed |
|-----------|---------|-------|
| `test_email_view_all_clickables.py` | Full inventory + probe every control + dead-click assertion | Slower |
| `test_dead_click_tripwire.py` | Zero dead clicks on representative actions | Fast |
| `dead_click_detector.test.js` | Unit tests for the detector module | Instant |
| `check_testids_logic.test.js` | Unit tests for testid enforcement logic | Instant |
| `scripts/check_testids.js` | Enforce data-testid coverage | Fast |

The tripwire and full inventory tests are **complementary** and **share helpers**
from `email_view_clickables_helpers.py` (injection, collection, reset).  The
tripwire runs in CI on every push; the full inventory test runs on-demand or in
scheduled CI.  Both inject the same `dead_click_detector.js` and assert zero
dead clicks via shared helper functions.
