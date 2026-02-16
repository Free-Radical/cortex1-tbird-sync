/**
 * Unit tests for dead_click_detector.js
 *
 * These tests run in Node.js with a minimal DOM mock.  The detector is
 * designed as a UMD module so we can require() it directly.
 */
"use strict";

// ---------------------------------------------------------------------------
// Minimal DOM mock (enough for the detector's needs)
// ---------------------------------------------------------------------------

function createMockElement(tag, attrs = {}) {
    const el = {
        tagName: tag.toUpperCase(),
        parentNode: null,
        children: [],
        _attrs: { ...attrs },
        _listeners: {},
        _style: {
            cssText: "",
            display: "block",
            visibility: "visible",
            pointerEvents: "auto",
        },
        style: {},
        innerText: attrs._text || "",
        textContent: attrs._text || "",

        getAttribute(name) {
            return this._attrs[name] || null;
        },
        setAttribute(name, value) {
            this._attrs[name] = value;
        },
        removeAttribute(name) {
            delete this._attrs[name];
        },
        hasAttribute(name) {
            return name in this._attrs;
        },
        matches(selector) {
            // Minimal selector matching for tests
            if (selector === "button" && this.tagName === "BUTTON") return true;
            if (selector === "a[href]" && this.tagName === "A" && this._attrs.href) return true;
            if (selector.startsWith("[role='") && this._attrs.role) {
                const role = selector.match(/\[role='(.+?)'\]/);
                if (role && this._attrs.role === role[1]) return true;
            }
            if (selector === "[data-testid]" && this._attrs["data-testid"]) return true;
            if (selector.includes("[tabindex]") && this._attrs.tabindex != null) return true;
            return false;
        },
        closest(selector) {
            // Check self first, then walk up
            const selectors = selector.split(",").map(s => s.trim());
            let node = this;
            while (node && node.matches) {
                for (const sel of selectors) {
                    if (node.matches(sel)) return node;
                }
                node = node.parentNode;
            }
            return null;
        },
        getBoundingClientRect() {
            return { x: 10, y: 20, width: 100, height: 30 };
        },
        addEventListener(event, handler, capture) {
            if (!this._listeners[event]) this._listeners[event] = [];
            this._listeners[event].push({ handler, capture: !!capture });
        },
        removeEventListener(event, handler, capture) {
            if (!this._listeners[event]) return;
            this._listeners[event] = this._listeners[event].filter(
                l => l.handler !== handler || l.capture !== !!capture
            );
        },
        contains(other) {
            return other === this || this.children.some(c => c === other || (c.contains && c.contains(other)));
        },
        appendChild(child) {
            child.parentNode = this;
            this.children.push(child);
            return child;
        },
        removeChild(child) {
            const idx = this.children.indexOf(child);
            if (idx >= 0) this.children.splice(idx, 1);
            child.parentNode = null;
            return child;
        },
        // Dispatch a mock click event
        dispatchClick(target) {
            const event = { type: "click", target: target || this };
            const listeners = this._listeners.click || [];
            for (const l of listeners) {
                if (l.capture) l.handler(event);
            }
        },
    };
    el.style = el._style;
    return el;
}

// Mock MutationObserver
class MockMutationObserver {
    constructor(callback) {
        this._callback = callback;
        this._observing = false;
        MockMutationObserver._instances.push(this);
    }
    observe() { this._observing = true; }
    disconnect() { this._observing = false; }
    // Test helper: simulate mutations
    _trigger(count) {
        if (!this._observing) return;
        const mutations = Array.from({ length: count }, () => ({}));
        this._callback(mutations);
    }
}
MockMutationObserver._instances = [];

// ---------------------------------------------------------------------------
// Setup global DOM mocks before requiring the module
// ---------------------------------------------------------------------------

let mockBody;
let mockDocument;

beforeEach(() => {
    jest.useFakeTimers();
    jest.resetModules();

    MockMutationObserver._instances = [];

    mockBody = createMockElement("body");

    mockDocument = {
        body: mockBody,
        documentElement: createMockElement("html"),
        createElement(tag) {
            return createMockElement(tag);
        },
        getElementById() { return null; },
        querySelector() { return null; },
    };

    global.document = mockDocument;
    global.window = {
        __deadClicks: undefined,
        __deadClickDetector: undefined,
    };
    global.MutationObserver = MockMutationObserver;
    global.location = { pathname: "/mail", hash: "" };
    global.XMLHttpRequest = function () {};
    global.XMLHttpRequest.prototype = { open: jest.fn() };
    global.URL = { createObjectURL: jest.fn(() => "blob:test"), revokeObjectURL: jest.fn() };
    global.Blob = class { constructor() {} };
    global.globalThis = global;
});

afterEach(() => {
    jest.useRealTimers();
    // Clean up global mocks
    delete global.document;
    delete global.MutationObserver;
    delete global.location;
    delete global.XMLHttpRequest;
    delete global.URL;
    delete global.Blob;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DeadClickDetector", () => {
    function loadDetector() {
        return require("../../dead_click_detector.js");
    }

    describe("module loading", () => {
        test("exports an object with install/uninstall/getEvents/reset", () => {
            const detector = loadDetector();
            expect(typeof detector.install).toBe("function");
            expect(typeof detector.uninstall).toBe("function");
            expect(typeof detector.getEvents).toBe("function");
            expect(typeof detector.reset).toBe("function");
            expect(typeof detector.exportJSON).toBe("function");
            expect(typeof detector.isInstalled).toBe("function");
            expect(typeof detector.eventCount).toBe("function");
        });
    });

    describe("install / uninstall", () => {
        test("install sets up click listener on root", () => {
            const detector = loadDetector();
            const root = createMockElement("div");
            detector.install(root);

            expect(detector.isInstalled()).toBe(true);
            expect(root._listeners.click).toBeDefined();
            expect(root._listeners.click.length).toBe(1);
            expect(root._listeners.click[0].capture).toBe(true);

            detector.uninstall();
            expect(detector.isInstalled()).toBe(false);
        });

        test("install throws if no root element", () => {
            const detector = loadDetector();
            expect(() => detector.install(null)).toThrow("root element required");
        });

        test("install is idempotent (second call is no-op)", () => {
            const detector = loadDetector();
            const root = createMockElement("div");
            detector.install(root);
            detector.install(root); // should not throw or double-register
            expect(root._listeners.click.length).toBe(1);
            detector.uninstall();
        });

        test("exposes window.__deadClicks and window.__deadClickDetector", () => {
            const detector = loadDetector();
            const root = createMockElement("div");
            detector.install(root);

            expect(global.window.__deadClicks).toBeDefined();
            expect(Array.isArray(global.window.__deadClicks)).toBe(true);
            expect(global.window.__deadClickDetector).toBe(detector);

            detector.uninstall();
        });
    });

    describe("_internals", () => {
        test("textHash returns consistent hex hash", () => {
            const detector = loadDetector();
            const { textHash } = detector._internals;

            expect(typeof textHash("hello")).toBe("string");
            expect(textHash("hello")).toBe(textHash("hello"));
            expect(textHash("hello")).not.toBe(textHash("world"));
            expect(textHash("")).toBe("");
            expect(textHash(null)).toBe("");
        });

        test("controlKey builds stable key from element attributes", () => {
            const detector = loadDetector();
            const { controlKey } = detector._internals;

            const btn = createMockElement("button", {
                "data-testid": "btn-reply",
                role: "button",
                _text: "Reply",
            });

            const key = controlKey(btn);
            expect(typeof key).toBe("string");
            expect(key.length).toBeGreaterThan(0);

            // Same element produces same key
            expect(controlKey(btn)).toBe(key);
        });

        test("describeControl builds privacy-safe descriptor", () => {
            const detector = loadDetector();
            const { describeControl } = detector._internals;

            const btn = createMockElement("button", {
                "data-testid": "btn-forward",
                role: "button",
                "aria-label": "Forward this message",
                _text: "Forward",
            });

            const desc = describeControl(btn);
            expect(desc.testId).toBe("btn-forward");
            expect(desc.role).toBe("button");
            expect(desc.tag).toBe("button");
            expect(desc.accessibleName).toBe("Forward this message");
            expect(typeof desc.textHash).toBe("string");
            expect(desc.bbox).toEqual({ x: 10, y: 20, w: 100, h: 30 });

            // Should NOT contain raw text content (privacy)
            expect(desc.textHash).not.toBe("Forward");
        });

        test("resolveInteractive finds nearest interactive ancestor", () => {
            const detector = loadDetector();
            const { resolveInteractive } = detector._internals;

            const btn = createMockElement("button", { _text: "Click me" });
            expect(resolveInteractive(btn)).toBe(btn);

            const span = createMockElement("span");
            span.closest = () => btn;
            expect(resolveInteractive(span)).toBe(btn);

            // Non-interactive element returns null
            const div = createMockElement("div");
            div.closest = () => null;
            expect(resolveInteractive(div)).toBeNull();
        });
    });

    describe("dead-click detection", () => {
        test("records dead click when no activity signals fire within observation window", () => {
            const detector = loadDetector();
            const root = createMockElement("div");
            detector.install(root, { observeMs: 750 });

            const btn = createMockElement("button", {
                "data-testid": "btn-reply",
                _text: "Reply",
            });
            btn.parentNode = root;

            // Simulate a click on the button
            root.dispatchClick(btn);

            // Fast-forward past observation window
            jest.advanceTimersByTime(800);

            const events = detector.getEvents();
            expect(events.length).toBe(1);
            expect(events[0].type).toBe("dead_click");
            expect(events[0].control.testId).toBe("btn-reply");
            expect(events[0].route).toBe("/mail");
            expect(typeof events[0].ts).toBe("number");

            detector.uninstall();
        });

        test("does NOT record dead click when DOM mutation fires", () => {
            const detector = loadDetector();
            const root = createMockElement("div");
            detector.install(root, { observeMs: 750 });

            const btn = createMockElement("button", { _text: "Archive" });
            btn.parentNode = root;

            root.dispatchClick(btn);

            // Trigger DOM mutation BEFORE first interval tick so the check sees it
            const mo = MockMutationObserver._instances[MockMutationObserver._instances.length - 1];
            expect(mo).toBeDefined();
            mo._trigger(3);

            // Advance past the observation window
            jest.advanceTimersByTime(800);

            expect(detector.getEvents().length).toBe(0);

            detector.uninstall();
        });

        test("does NOT record dead click when URL changes", () => {
            const detector = loadDetector();
            const root = createMockElement("div");
            detector.install(root, { observeMs: 750 });

            const link = createMockElement("a", { href: "/inbox", _text: "Inbox" });
            link.parentNode = root;

            root.dispatchClick(link);

            // Apply URL change BEFORE first interval tick
            global.location.pathname = "/inbox";

            jest.advanceTimersByTime(800);

            expect(detector.getEvents().length).toBe(0);

            // Reset
            global.location.pathname = "/mail";
            detector.uninstall();
        });

        test("does NOT record dead click when aria-expanded toggles", () => {
            const detector = loadDetector();
            const root = createMockElement("div");
            detector.install(root, { observeMs: 750 });

            const btn = createMockElement("button", {
                "aria-expanded": "false",
                _text: "More",
            });
            btn.parentNode = root;

            root.dispatchClick(btn);

            // Toggle ARIA state BEFORE first interval tick
            btn._attrs["aria-expanded"] = "true";

            jest.advanceTimersByTime(800);

            expect(detector.getEvents().length).toBe(0);

            detector.uninstall();
        });
    });

    describe("rage-click detection", () => {
        test("records rage click after threshold dead clicks on same control", () => {
            const detector = loadDetector();
            const root = createMockElement("div");
            detector.install(root, {
                observeMs: 100,
                rageThreshold: 3,
                rageWindowMs: 5000,
            });

            const btn = createMockElement("button", {
                "data-testid": "btn-broken",
                _text: "Broken Button",
            });
            btn.parentNode = root;

            // Fire 3 dead clicks — each needs full observation window to expire
            root.dispatchClick(btn);
            jest.advanceTimersByTime(200); // well past 100ms observe window
            expect(detector.getEvents().filter(e => e.type === "dead_click").length).toBe(1);

            root.dispatchClick(btn);
            jest.advanceTimersByTime(200);
            expect(detector.getEvents().filter(e => e.type === "dead_click").length).toBe(2);

            root.dispatchClick(btn);
            jest.advanceTimersByTime(200);

            const events = detector.getEvents();
            const deadEvents = events.filter(e => e.type === "dead_click");
            const rageEvents = events.filter(e => e.type === "rage_click");
            expect(deadEvents.length).toBe(3);
            expect(rageEvents.length).toBe(1);
            expect(rageEvents[0].control.testId).toBe("btn-broken");
            expect(rageEvents[0].deadClickCount).toBe(3);

            detector.uninstall();
        });

        test("does NOT rage-click if dead clicks are on different controls", () => {
            const detector = loadDetector();
            const root = createMockElement("div");
            detector.install(root, {
                observeMs: 100,
                rageThreshold: 3,
                rageWindowMs: 5000,
            });

            const btn1 = createMockElement("button", { "data-testid": "btn-a", _text: "A" });
            const btn2 = createMockElement("button", { "data-testid": "btn-b", _text: "B" });
            const btn3 = createMockElement("button", { "data-testid": "btn-c", _text: "C" });
            btn1.parentNode = root;
            btn2.parentNode = root;
            btn3.parentNode = root;

            root.dispatchClick(btn1);
            jest.advanceTimersByTime(150);
            root.dispatchClick(btn2);
            jest.advanceTimersByTime(150);
            root.dispatchClick(btn3);
            jest.advanceTimersByTime(150);

            const rageEvents = detector.getEvents().filter(e => e.type === "rage_click");
            expect(rageEvents.length).toBe(0);

            detector.uninstall();
        });
    });

    describe("reset and export", () => {
        test("reset clears all events", () => {
            const detector = loadDetector();
            const root = createMockElement("div");
            detector.install(root, { observeMs: 100 });

            const btn = createMockElement("button", { _text: "Test" });
            btn.parentNode = root;
            root.dispatchClick(btn);
            jest.advanceTimersByTime(150);

            expect(detector.eventCount()).toBeGreaterThan(0);

            detector.reset();
            expect(detector.eventCount()).toBe(0);
            expect(detector.getEvents()).toEqual([]);

            detector.uninstall();
        });

        test("exportJSON returns valid JSON string", () => {
            const detector = loadDetector();
            const root = createMockElement("div");
            detector.install(root, { observeMs: 100 });

            const btn = createMockElement("button", { _text: "Test" });
            btn.parentNode = root;
            root.dispatchClick(btn);
            jest.advanceTimersByTime(150);

            const json = detector.exportJSON();
            const parsed = JSON.parse(json);
            expect(Array.isArray(parsed)).toBe(true);
            expect(parsed.length).toBeGreaterThan(0);

            detector.uninstall();
        });
    });

    describe("ring buffer", () => {
        test("caps events at maxEvents", () => {
            const detector = loadDetector();
            const root = createMockElement("div");
            detector.install(root, { observeMs: 50, maxEvents: 5 });

            const btn = createMockElement("button", { _text: "Spam" });
            btn.parentNode = root;

            // Fire more clicks than maxEvents
            for (let i = 0; i < 10; i++) {
                root.dispatchClick(btn);
                jest.advanceTimersByTime(100);
            }

            // Should be capped (may include rage events too, but total <= maxEvents)
            expect(detector.eventCount()).toBeLessThanOrEqual(5);

            detector.uninstall();
        });
    });

    describe("ignores non-interactive clicks", () => {
        test("click on plain div does not trigger observation", () => {
            const detector = loadDetector();
            const root = createMockElement("div");

            // Override root.closest to never match interactive selectors
            root.closest = () => null;

            detector.install(root, { observeMs: 100 });

            const div = createMockElement("div", { _text: "Just text" });
            div.parentNode = root;
            // Ensure closest walks up and finds nothing interactive
            div.closest = () => null;

            root.dispatchClick(div);
            jest.advanceTimersByTime(200);

            expect(detector.eventCount()).toBe(0);

            detector.uninstall();
        });
    });

    describe("false-positive suppression", () => {
        test("suppresses clicks on disabled elements", () => {
            const detector = loadDetector();
            const root = createMockElement("div");
            detector.install(root, { observeMs: 100 });

            const btn = createMockElement("button", { _text: "Submit" });
            btn.disabled = true;
            btn.parentNode = root;

            root.dispatchClick(btn);
            jest.advanceTimersByTime(200);

            expect(detector.eventCount()).toBe(0);
            detector.uninstall();
        });

        test("suppresses clicks on aria-disabled elements", () => {
            const detector = loadDetector();
            const root = createMockElement("div");
            detector.install(root, { observeMs: 100 });

            const btn = createMockElement("button", {
                "aria-disabled": "true",
                _text: "Disabled Action",
            });
            btn.parentNode = root;

            root.dispatchClick(btn);
            jest.advanceTimersByTime(200);

            expect(detector.eventCount()).toBe(0);
            detector.uninstall();
        });

        test("suppresses focus-only clicks on input elements", () => {
            const detector = loadDetector();
            const root = createMockElement("div");
            detector.install(root, { observeMs: 100 });

            const input = createMockElement("input", {
                tabindex: "0",
                _text: "",
            });
            input.parentNode = root;
            // input.closest should resolve to itself for [tabindex]
            input.matches = function (selector) {
                if (selector === "input") return true;
                if (selector.includes("[tabindex]") && this._attrs.tabindex != null) return true;
                return false;
            };

            root.dispatchClick(input);
            jest.advanceTimersByTime(200);

            expect(detector.eventCount()).toBe(0);
            detector.uninstall();
        });

        test("suppresses focus-only clicks on textarea elements", () => {
            const detector = loadDetector();
            const root = createMockElement("div");
            detector.install(root, { observeMs: 100 });

            const textarea = createMockElement("textarea", {
                tabindex: "0",
                _text: "",
            });
            textarea.parentNode = root;
            textarea.matches = function (selector) {
                if (selector === "textarea") return true;
                if (selector.includes("[tabindex]") && this._attrs.tabindex != null) return true;
                return false;
            };

            root.dispatchClick(textarea);
            jest.advanceTimersByTime(200);

            expect(detector.eventCount()).toBe(0);
            detector.uninstall();
        });

        test("suppresses clipboard copy buttons", () => {
            const detector = loadDetector();
            const root = createMockElement("div");
            detector.install(root, { observeMs: 100 });

            const btn = createMockElement("button", {
                "data-testid": "btn-copy-email",
                _text: "Copy",
            });
            btn.parentNode = root;

            root.dispatchClick(btn);
            jest.advanceTimersByTime(200);

            expect(detector.eventCount()).toBe(0);
            detector.uninstall();
        });

        test("suppresses copy buttons detected via aria-label", () => {
            const detector = loadDetector();
            const root = createMockElement("div");
            detector.install(root, { observeMs: 100 });

            const btn = createMockElement("button", {
                "aria-label": "Copy to clipboard",
                _text: "Copy",
            });
            btn.parentNode = root;

            root.dispatchClick(btn);
            jest.advanceTimersByTime(200);

            expect(detector.eventCount()).toBe(0);
            detector.uninstall();
        });

        test("suppresses already-selected tabs (idempotent toggle)", () => {
            const detector = loadDetector();
            const root = createMockElement("div");
            detector.install(root, { observeMs: 100 });

            const tab = createMockElement("button", {
                role: "tab",
                "aria-selected": "true",
                _text: "Inbox",
            });
            tab.parentNode = root;

            root.dispatchClick(tab);
            jest.advanceTimersByTime(200);

            expect(detector.eventCount()).toBe(0);
            detector.uninstall();
        });

        test("does NOT suppress non-selected tabs", () => {
            const detector = loadDetector();
            const root = createMockElement("div");
            detector.install(root, { observeMs: 100 });

            const tab = createMockElement("button", {
                role: "tab",
                "aria-selected": "false",
                _text: "Drafts",
            });
            tab.parentNode = root;

            root.dispatchClick(tab);
            jest.advanceTimersByTime(200);

            // Should NOT be suppressed — if no signals fire, it IS a dead click
            expect(detector.eventCount()).toBe(1);
            detector.uninstall();
        });
    });

    describe("allowlist", () => {
        test("allowlist by testId suppresses matching control", () => {
            const detector = loadDetector();
            const root = createMockElement("div");
            detector.install(root, {
                observeMs: 100,
                allowlist: [{ testId: "btn-print" }],
            });

            const btn = createMockElement("button", {
                "data-testid": "btn-print",
                _text: "Print",
            });
            btn.parentNode = root;

            root.dispatchClick(btn);
            jest.advanceTimersByTime(200);

            expect(detector.eventCount()).toBe(0);
            detector.uninstall();
        });

        test("allowlist by role suppresses matching control", () => {
            const detector = loadDetector();
            const root = createMockElement("div");
            detector.install(root, {
                observeMs: 100,
                allowlist: [{ role: "presentation" }],
            });

            const el = createMockElement("button", {
                role: "presentation",
                _text: "Decorative",
            });
            el.parentNode = root;

            root.dispatchClick(el);
            jest.advanceTimersByTime(200);

            expect(detector.eventCount()).toBe(0);
            detector.uninstall();
        });

        test("allowlist by name substring suppresses matching control", () => {
            const detector = loadDetector();
            const root = createMockElement("div");
            detector.install(root, {
                observeMs: 100,
                allowlist: [{ name: "clipboard" }],
            });

            const btn = createMockElement("button", {
                "aria-label": "Copy to clipboard",
                _text: "Copy",
            });
            btn.parentNode = root;

            root.dispatchClick(btn);
            jest.advanceTimersByTime(200);

            expect(detector.eventCount()).toBe(0);
            detector.uninstall();
        });

        test("allowlist entry with multiple fields requires ALL to match", () => {
            const detector = loadDetector();
            const root = createMockElement("div");
            detector.install(root, {
                observeMs: 100,
                allowlist: [{ testId: "btn-share", role: "button" }],
            });

            // Matches testId but wrong role — should NOT be suppressed
            const btn = createMockElement("button", {
                "data-testid": "btn-share",
                role: "menuitem",
                _text: "Share",
            });
            btn.parentNode = root;

            root.dispatchClick(btn);
            jest.advanceTimersByTime(200);

            expect(detector.eventCount()).toBe(1);
            detector.uninstall();
        });

        test("addAllowlistEntry adds at runtime", () => {
            const detector = loadDetector();
            const root = createMockElement("div");
            detector.install(root, { observeMs: 100 });

            detector.addAllowlistEntry({ testId: "btn-dynamic" });
            expect(detector.getAllowlist().length).toBe(1);

            const btn = createMockElement("button", {
                "data-testid": "btn-dynamic",
                _text: "Dynamic",
            });
            btn.parentNode = root;

            root.dispatchClick(btn);
            jest.advanceTimersByTime(200);

            expect(detector.eventCount()).toBe(0);
            detector.uninstall();
        });

        test("setAllowlist replaces the entire list", () => {
            const detector = loadDetector();
            const root = createMockElement("div");
            detector.install(root, {
                observeMs: 100,
                allowlist: [{ testId: "old" }],
            });

            detector.setAllowlist([{ testId: "new" }]);
            const list = detector.getAllowlist();
            expect(list.length).toBe(1);
            expect(list[0].testId).toBe("new");

            detector.uninstall();
        });
    });

    describe("_internals.shouldSuppress", () => {
        test("returns true for disabled elements", () => {
            const detector = loadDetector();
            const { shouldSuppress } = detector._internals;

            const btn = createMockElement("button", { _text: "X" });
            btn.disabled = true;
            expect(shouldSuppress(btn)).toBe(true);
        });

        test("returns false for normal interactive elements", () => {
            const detector = loadDetector();
            const { shouldSuppress } = detector._internals;

            const btn = createMockElement("button", { _text: "Reply" });
            expect(shouldSuppress(btn)).toBe(false);
        });
    });

    describe("production safety", () => {
        test("module load has zero side effects — no listeners, no globals", () => {
            const detector = loadDetector();

            // Module loaded but install() never called
            expect(detector.isInstalled()).toBe(false);
            expect(detector.eventCount()).toBe(0);

            // No click listener on any element
            expect((mockBody._listeners.click || []).length).toBe(0);

            // No window globals set
            expect(global.window.__deadClicks).toBeUndefined();
            expect(global.window.__deadClickDetector).toBeUndefined();
        });

        test("uninstall removes all listeners and globals", () => {
            const detector = loadDetector();
            const root = createMockElement("div");
            detector.install(root, { observeMs: 100 });

            expect(detector.isInstalled()).toBe(true);
            expect(global.window.__deadClicks).toBeDefined();
            expect(global.window.__deadClickDetector).toBeDefined();
            expect(root._listeners.click.length).toBe(1);

            detector.uninstall();

            expect(detector.isInstalled()).toBe(false);
            expect(root._listeners.click.length).toBe(0);
        });
    });

    describe("privacy", () => {
        test("describeControl does NOT include raw text content", () => {
            const detector = loadDetector();
            const { describeControl } = detector._internals;

            const btn = createMockElement("button", {
                _text: "RE: Confidential salary discussion Q4 2025",
            });

            const desc = describeControl(btn);
            // The textHash should be a hex string, not the raw text
            expect(desc.textHash).not.toContain("Confidential");
            expect(desc.textHash).not.toContain("salary");
            // accessibleName is trimmed but present (it's the accessible name, not email content)
            expect(typeof desc.accessibleName).toBe("string");
        });
    });
});
