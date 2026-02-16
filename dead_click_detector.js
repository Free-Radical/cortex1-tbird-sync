/**
 * Dead-Click & Rage-Click Detector
 *
 * Privacy-first, local-only instrumentation for detecting clicks on controls
 * that produce no observable effect (dead clicks) and rapid repeated dead
 * clicks on the same control (rage clicks).
 *
 * Design:
 *   - Capture-phase click listener on a root element.
 *   - After each click, observe "activity signals" for up to OBSERVE_MS:
 *       (a) DOM mutations in the app container (MutationObserver)
 *       (b) URL / navigation change
 *       (c) menu / dialog / toast appears OR aria-expanded/aria-pressed toggles
 *       (d) fetch / XHR count incremented
 *   - If NONE fire within the window => record a DeadClick event.
 *   - Rage-click: >= RAGE_THRESHOLD dead clicks on same control within RAGE_WINDOW_MS.
 *
 * Privacy:
 *   - NO email subject, body, or user content captured.
 *   - Recorded fields: route, data-testid, role, accessibleName (trimmed),
 *     text HASH (sha-like, not raw), bounding box, timestamp.
 *
 * Usage (browser):
 *   DeadClickDetector.install(document.getElementById('app'));
 *
 * Usage (Playwright injection):
 *   page.evaluate(detectorSource);           // inject
 *   page.evaluate(() => DeadClickDetector.install(document.body));
 *   // ... interact ...
 *   const events = page.evaluate(() => window.__deadClicks);
 *
 * UMD wrapper follows the convention in sent_folder_discovery.js.
 */
(function (root, factory) {
    var api = factory();
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    } else {
        root.DeadClickDetector = api;
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    // =========================================================================
    // Configuration
    // =========================================================================

    var OBSERVE_MS = 750;          // How long to watch for activity after a click
    var RAGE_THRESHOLD = 5;        // Dead clicks on same control within window
    var RAGE_WINDOW_MS = 3000;     // Rolling window for rage-click detection
    var MAX_EVENTS = 200;          // Ring-buffer cap
    var DEV_MODE = false;          // Set true for console.error + toast
    var INTERACTIVE_SELECTOR =
        "button, a[href], [role='button'], [role='menuitem'], [role='tab'], " +
        "[role='option'], [role='link'], [onclick], input, select, textarea, " +
        "summary, [tabindex]:not([tabindex='-1'])";

    // Tags for which a click that only moves focus is legitimate (not dead).
    var FOCUS_ONLY_TAGS = { INPUT: 1, SELECT: 1, TEXTAREA: 1 };

    // =========================================================================
    // Allowlist — controls that should never be flagged as dead clicks.
    //
    // Each entry is an object:  { testId, selector, role, name }
    //   - testId   : exact match on data-testid
    //   - selector : CSS selector (el.matches)
    //   - role     : exact match on ARIA role
    //   - name     : substring match on accessibleName (case-insensitive)
    //
    // At least one field must be present.  An entry matches if ALL non-null
    // fields match.
    // =========================================================================

    var allowlist = [];

    // =========================================================================
    // State
    // =========================================================================

    var installed = false;
    var rootEl = null;
    var containerEl = null;
    var events = [];          // DeadClick + RageClick events (ring buffer)
    var recentDeadClicks = []; // For rage-click windowing: { controlKey, ts }
    var mutationObserver = null;
    var toastContainer = null;

    // Counters reset per observation window
    var pendingObservations = [];  // active observation timers

    // Network intercept bookkeeping
    var fetchCount = 0;
    var xhrOpenCount = 0;
    var originalFetch = null;
    var originalXhrOpen = null;
    var networkIntercepted = false;
    var useNetworkSignals = true;   // opt-out via options.networkSignals = false
    var perfObserver = null;        // PerformanceObserver fallback

    // =========================================================================
    // Helpers
    // =========================================================================

    /** Simple FNV-1a-like hash for short strings => hex. NOT cryptographic. */
    function textHash(str) {
        if (!str) return "";
        var hash = 0x811c9dc5 | 0;
        for (var i = 0; i < str.length; i++) {
            hash ^= str.charCodeAt(i);
            hash = (hash * 0x01000193) | 0;
        }
        return (hash >>> 0).toString(16);
    }

    function trimStr(s, max) {
        if (!s) return "";
        s = s.replace(/\s+/g, " ").trim();
        return s.length > (max || 80) ? s.substring(0, max || 80) : s;
    }

    function now() { return Date.now(); }

    function getRoute() {
        try { return location.pathname + location.hash; } catch (e) { return ""; }
    }

    function getAccessibleName(el) {
        var label = (el.getAttribute("aria-label") || "").trim();
        if (label) return label;
        var labelledBy = (el.getAttribute("aria-labelledby") || "").trim();
        if (labelledBy) {
            var parts = labelledBy.split(/\s+/).map(function (id) {
                var node = document.getElementById(id);
                return node ? (node.innerText || node.textContent || "").trim() : "";
            }).filter(Boolean);
            if (parts.length) return parts.join(" ");
        }
        return (el.innerText || el.textContent || "").trim();
    }

    /** Find the nearest interactive ancestor (or self) for a click target. */
    function resolveInteractive(target) {
        if (!target || target === document || target === document.documentElement) return null;
        try {
            return target.closest(INTERACTIVE_SELECTOR);
        } catch (e) {
            return null;
        }
    }

    /**
     * Check whether an allowlist entry matches a given element.
     * All non-null fields in the entry must match.
     */
    function allowlistMatches(entry, el) {
        if (entry.testId) {
            if ((el.getAttribute("data-testid") || "") !== entry.testId) return false;
        }
        if (entry.selector) {
            try { if (!el.matches(entry.selector)) return false; } catch (e) { return false; }
        }
        if (entry.role) {
            if ((el.getAttribute("role") || "") !== entry.role) return false;
        }
        if (entry.name) {
            var accName = getAccessibleName(el).toLowerCase();
            if (accName.indexOf(entry.name.toLowerCase()) === -1) return false;
        }
        return true;
    }

    /** Returns true if this click should NOT be observed for dead-click. */
    function shouldSuppress(el) {
        // 1. Disabled / aria-disabled — clicking disabled controls is always a no-op
        if (el.disabled === true || el.getAttribute("aria-disabled") === "true") {
            return true;
        }

        // 2. Focus-only elements — clicking an input/select/textarea to focus it
        //    produces no DOM mutation but is perfectly normal behaviour.
        var tag = (el.tagName || "").toUpperCase();
        if (FOCUS_ONLY_TAGS[tag]) {
            return true;
        }

        // 3. Clipboard-copy buttons (commonly have no visible UI change)
        var testId = (el.getAttribute("data-testid") || "").toLowerCase();
        var label = (el.getAttribute("aria-label") || "").toLowerCase();
        if (testId.indexOf("copy") !== -1 || label.indexOf("copy") !== -1) {
            return true;
        }

        // 4. Idempotent toggles — element already in the target state.
        //    e.g. clicking an already-selected tab or already-expanded panel.
        var role = (el.getAttribute("role") || "").toLowerCase();
        if (role === "tab" && el.getAttribute("aria-selected") === "true") {
            return true;
        }

        // 5. Check user-defined allowlist
        for (var i = 0; i < allowlist.length; i++) {
            if (allowlistMatches(allowlist[i], el)) return true;
        }

        return false;
    }

    /** Build a stable key for a control (for rage-click grouping). */
    function controlKey(el) {
        var testId = el.getAttribute("data-testid") || "";
        var role = el.getAttribute("role") || "";
        var tag = (el.tagName || "").toLowerCase();
        var name = trimStr(getAccessibleName(el), 40);
        return [tag, role, testId, textHash(name)].join("|");
    }

    /** Build a privacy-safe descriptor for a control. */
    function describeControl(el) {
        var rect = el.getBoundingClientRect();
        return {
            testId: el.getAttribute("data-testid") || null,
            role: el.getAttribute("role") || null,
            tag: (el.tagName || "").toLowerCase(),
            accessibleName: trimStr(getAccessibleName(el), 80),
            textHash: textHash((el.innerText || el.textContent || "").trim()),
            bbox: {
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                w: Math.round(rect.width),
                h: Math.round(rect.height)
            }
        };
    }

    /** Friendly label for dev toasts. */
    function controlLabel(desc) {
        return desc.testId || desc.accessibleName || desc.tag || "unknown";
    }

    // =========================================================================
    // Network intercept (fetch + XHR)
    // =========================================================================

    /**
     * Start observing network activity.
     *
     * Strategy (safest first):
     *   1. PerformanceObserver("resource") — non-invasive, no global mutation.
     *   2. fetch/XHR wrapping — only when PerformanceObserver is unavailable.
     *
     * Either way, increments fetchCount so the signal checker works the same.
     */
    function interceptNetwork() {
        if (networkIntercepted || !useNetworkSignals) return;
        networkIntercepted = true;

        // Strategy 1: PerformanceObserver (preferred — zero side-effects)
        if (typeof PerformanceObserver === "function") {
            try {
                perfObserver = new PerformanceObserver(function (list) {
                    fetchCount += list.getEntries().length;
                });
                perfObserver.observe({ type: "resource", buffered: false });
                return; // success — no need to wrap globals
            } catch (e) {
                perfObserver = null;
                // Fall through to strategy 2
            }
        }

        // Strategy 2: Wrap fetch + XHR (fallback — mutates globals)
        if (typeof fetch === "function") {
            originalFetch = fetch;
            var wrappedFetch = function () {
                fetchCount++;
                return originalFetch.apply(this, arguments);
            };
            try { Object.defineProperty(wrappedFetch, "name", { value: "fetch" }); } catch (e) { /* ok */ }
            if (typeof globalThis !== "undefined") {
                globalThis.fetch = wrappedFetch;
            } else if (typeof window !== "undefined") {
                window.fetch = wrappedFetch;
            }
        }

        if (typeof XMLHttpRequest !== "undefined") {
            originalXhrOpen = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function () {
                xhrOpenCount++;
                return originalXhrOpen.apply(this, arguments);
            };
        }
    }

    function restoreNetwork() {
        if (!networkIntercepted) return;
        networkIntercepted = false;

        // Clean up PerformanceObserver if used
        if (perfObserver) {
            try { perfObserver.disconnect(); } catch (e) { /* ok */ }
            perfObserver = null;
        }

        // Restore wrapped globals if used
        if (originalFetch) {
            if (typeof globalThis !== "undefined") {
                globalThis.fetch = originalFetch;
            } else if (typeof window !== "undefined") {
                window.fetch = originalFetch;
            }
            originalFetch = null;
        }
        if (originalXhrOpen && typeof XMLHttpRequest !== "undefined") {
            XMLHttpRequest.prototype.open = originalXhrOpen;
            originalXhrOpen = null;
        }
    }

    // =========================================================================
    // Recording
    // =========================================================================

    function recordEvent(evt) {
        events.push(evt);
        while (events.length > MAX_EVENTS) {
            events.shift();
        }
        // Also expose on window for Playwright test hooks
        if (typeof window !== "undefined") {
            window.__deadClicks = events;
        }
    }

    function recordDeadClick(el) {
        var ts = now();
        var desc = describeControl(el);
        var evt = {
            type: "dead_click",
            ts: ts,
            route: getRoute(),
            control: desc
        };
        recordEvent(evt);

        // Rage-click detection
        var key = controlKey(el);
        recentDeadClicks.push({ controlKey: key, ts: ts });

        // Prune old entries outside the rage window
        var cutoff = ts - RAGE_WINDOW_MS;
        recentDeadClicks = recentDeadClicks.filter(function (e) {
            return e.ts >= cutoff;
        });

        // Count dead clicks on this same control within the window
        var count = 0;
        for (var i = 0; i < recentDeadClicks.length; i++) {
            if (recentDeadClicks[i].controlKey === key) count++;
        }

        if (count >= RAGE_THRESHOLD) {
            var rageEvt = {
                type: "rage_click",
                ts: ts,
                route: getRoute(),
                control: desc,
                deadClickCount: count,
                windowMs: RAGE_WINDOW_MS
            };
            recordEvent(rageEvt);

            // Clear matched entries to avoid repeat rage events per burst
            recentDeadClicks = recentDeadClicks.filter(function (e) {
                return e.controlKey !== key;
            });
        }

        // Dev-mode surfacing
        if (DEV_MODE) {
            var label = controlLabel(desc);
            console.error("[DeadClick] Dead click detected: " + label, desc);
            if (count >= RAGE_THRESHOLD) {
                console.error("[DeadClick] RAGE CLICK: " + label + " (" + count + " dead clicks in " + RAGE_WINDOW_MS + "ms)");
            }
            showDevToast(
                count >= RAGE_THRESHOLD
                    ? "Rage click: " + label
                    : "Dead click: " + label
            );
        }
    }

    // =========================================================================
    // Dev toast (non-blocking, auto-dismiss)
    // =========================================================================

    function showDevToast(message) {
        if (typeof document === "undefined") return;
        if (!toastContainer) {
            toastContainer = document.createElement("div");
            toastContainer.setAttribute("data-testid", "dead-click-toast-container");
            toastContainer.style.cssText =
                "position:fixed;bottom:8px;right:8px;z-index:999999;" +
                "display:flex;flex-direction:column;gap:4px;pointer-events:none;";
            document.body.appendChild(toastContainer);
        }
        var toast = document.createElement("div");
        toast.setAttribute("role", "alert");
        toast.style.cssText =
            "background:#b91c1c;color:#fff;padding:6px 12px;border-radius:4px;" +
            "font:12px/1.4 monospace;opacity:0.92;max-width:360px;word-break:break-word;";
        toast.textContent = message;
        toastContainer.appendChild(toast);
        setTimeout(function () {
            if (toast.parentNode) toast.parentNode.removeChild(toast);
        }, 4000);
    }

    // =========================================================================
    // Observation window: watch for activity signals after each click
    // =========================================================================

    function observeClick(el) {
        var startUrl = getRoute();
        var startFetch = fetchCount;
        var startXhr = xhrOpenCount;
        var startPressed = (el.getAttribute("aria-pressed") || "").trim();
        var startExpanded = (el.getAttribute("aria-expanded") || "").trim();
        var mutationCount = 0;
        var signalDetected = false;
        var observationDone = false;

        // Start MutationObserver on the container (or body)
        var observeTarget = containerEl || document.body;
        var mo = new MutationObserver(function (mutations) {
            mutationCount += mutations.length;
        });
        mo.observe(observeTarget, {
            childList: true,
            subtree: true,
            attributes: true,
            characterData: true
        });

        function checkSignals() {
            if (observationDone) return;

            // (a) DOM mutations (threshold: > 0 means something changed)
            if (mutationCount > 0) { signalDetected = true; }

            // (b) URL / navigation change
            if (getRoute() !== startUrl) { signalDetected = true; }

            // (c) ARIA toggles
            var nowPressed = (el.getAttribute("aria-pressed") || "").trim();
            var nowExpanded = (el.getAttribute("aria-expanded") || "").trim();
            if (nowPressed !== startPressed || nowExpanded !== startExpanded) {
                signalDetected = true;
            }

            // (d) Network activity (fetch or XHR)
            if (fetchCount > startFetch || xhrOpenCount > startXhr) {
                signalDetected = true;
            }
        }

        // Check periodically and at end of window
        var intervalId = setInterval(function () {
            checkSignals();
            if (signalDetected) {
                cleanup();
            }
        }, 100);

        function cleanup() {
            if (observationDone) return;
            observationDone = true;
            clearInterval(intervalId);
            mo.disconnect();

            // Final check
            checkSignals();

            if (!signalDetected) {
                recordDeadClick(el);
            }
        }

        // End observation after OBSERVE_MS
        var timerId = setTimeout(cleanup, OBSERVE_MS);

        pendingObservations.push({
            cancel: function () {
                observationDone = true;
                clearInterval(intervalId);
                clearTimeout(timerId);
                mo.disconnect();
            }
        });
    }

    // =========================================================================
    // Click listener (capture phase)
    // =========================================================================

    function onClickCapture(e) {
        var target = e.target;
        var interactive = resolveInteractive(target);
        if (!interactive) return;  // click on non-interactive element — ignore

        // Don't observe clicks on the toast container itself
        if (toastContainer && toastContainer.contains(target)) return;

        // Suppress known false-positive patterns
        if (shouldSuppress(interactive)) return;

        observeClick(interactive);
    }

    // =========================================================================
    // Public API
    // =========================================================================

    var api = {
        /**
         * Install the dead-click detector on a root element.
         *
         * @param {Element} root        - Element to attach capture listener to.
         * @param {Object}  [options]   - Optional overrides.
         * @param {Element} [options.container]  - App container for MutationObserver scope.
         * @param {boolean} [options.devMode]    - Enable console.error + toast. Default: false.
         * @param {number}  [options.observeMs]  - Observation window (ms). Default: 750.
         * @param {number}  [options.rageThreshold] - Dead clicks for rage. Default: 5.
         * @param {number}  [options.rageWindowMs]  - Rage window (ms). Default: 3000.
         * @param {number}  [options.maxEvents]      - Ring buffer cap. Default: 200.
         * @param {Array}   [options.allowlist]      - Entries to suppress. See DEAD_CLICK_TELEMETRY.md.
         */
        install: function (root, options) {
            if (installed) return;
            if (!root) throw new Error("DeadClickDetector.install: root element required");

            var opts = options || {};
            rootEl = root;
            containerEl = opts.container || root;
            DEV_MODE = opts.devMode === true;
            if (typeof opts.observeMs === "number") OBSERVE_MS = opts.observeMs;
            if (typeof opts.rageThreshold === "number") RAGE_THRESHOLD = opts.rageThreshold;
            if (typeof opts.rageWindowMs === "number") RAGE_WINDOW_MS = opts.rageWindowMs;
            if (typeof opts.maxEvents === "number") MAX_EVENTS = opts.maxEvents;
            if (Array.isArray(opts.allowlist)) allowlist = opts.allowlist.slice();
            if (opts.networkSignals === false) useNetworkSignals = false;

            interceptNetwork();
            rootEl.addEventListener("click", onClickCapture, true);  // capture phase
            installed = true;

            // Expose on window for Playwright hooks
            if (typeof window !== "undefined") {
                window.__deadClicks = events;
                window.__deadClickDetector = api;
            }
        },

        /** Remove all listeners and restore state. */
        uninstall: function () {
            if (!installed) return;
            rootEl.removeEventListener("click", onClickCapture, true);
            restoreNetwork();

            // Cancel pending observations
            for (var i = 0; i < pendingObservations.length; i++) {
                pendingObservations[i].cancel();
            }
            pendingObservations = [];

            if (toastContainer && toastContainer.parentNode) {
                toastContainer.parentNode.removeChild(toastContainer);
            }
            toastContainer = null;

            installed = false;
            rootEl = null;
            containerEl = null;
            allowlist = [];
            useNetworkSignals = true;
        },

        /** Return current event buffer. */
        getEvents: function () {
            return events.slice();
        },

        /** Clear the event buffer and recent dead-click window. */
        reset: function () {
            events.length = 0;
            recentDeadClicks.length = 0;
            if (typeof window !== "undefined") {
                window.__deadClicks = events;
            }
        },

        /** Export events as JSON string. */
        exportJSON: function () {
            return JSON.stringify(events, null, 2);
        },

        /** Whether the detector is currently installed. */
        isInstalled: function () {
            return installed;
        },

        /** Current event count. */
        eventCount: function () {
            return events.length;
        },

        /**
         * Replace the entire allowlist.
         * @param {Array} entries - Array of { testId, selector, role, name }.
         */
        setAllowlist: function (entries) {
            allowlist = Array.isArray(entries) ? entries.slice() : [];
        },

        /**
         * Append a single entry to the allowlist.
         * @param {Object} entry - { testId?, selector?, role?, name? }.
         */
        addAllowlistEntry: function (entry) {
            if (entry && typeof entry === "object") {
                allowlist.push(entry);
            }
        },

        /** Return current allowlist (copy). */
        getAllowlist: function () {
            return allowlist.slice();
        },

        // Expose internals for testing
        _internals: {
            textHash: textHash,
            controlKey: controlKey,
            describeControl: describeControl,
            resolveInteractive: resolveInteractive,
            shouldSuppress: shouldSuppress,
            allowlistMatches: allowlistMatches,
            INTERACTIVE_SELECTOR: INTERACTIVE_SELECTOR
        }
    };

    return api;
});
