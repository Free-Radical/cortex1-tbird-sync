/**
 * Unit tests for the testid enforcement logic in scripts/check_testids.js.
 *
 * These tests validate the filtering/exclusion rules without requiring
 * Playwright.  They simulate the page.evaluate logic with fixture data.
 */
"use strict";

// ---------------------------------------------------------------------------
// Extract the filtering logic from check_testids.js into a testable function.
// This mirrors the page.evaluate callback.
// ---------------------------------------------------------------------------

/**
 * Simulate the testid check logic with mock control data.
 *
 * @param {Array} controls - Array of mock control descriptors.
 * @param {Object} opts    - { allowMissing: string[], bodyContainerIds: string[] }
 * @returns {{ missing: Array, total: number, covered: number }}
 */
function runTestidCheck(controls, opts = {}) {
    const allowMissing = opts.allowMissing || [];
    const bodyIds = new Set(opts.bodyContainerIds || []);

    const results = [];
    for (const c of controls) {
        // Skip invisible/disabled
        if (c.hidden || c.disabled) continue;
        // Skip elements inside email body
        if (c.parentId && bodyIds.has(c.parentId)) continue;

        let allowed = false;
        // Check allow list by simulated selector matching
        for (const pattern of allowMissing) {
            if (c._matchesPatterns && c._matchesPatterns.includes(pattern)) {
                allowed = true;
                break;
            }
        }

        results.push({
            tag: c.tag,
            role: c.role || "",
            testId: c.testId || "",
            name: c.name || "",
            allowed,
        });
    }

    const missing = results.filter(c => !c.testId && !c.allowed);
    const covered = results.filter(c => !!c.testId).length;
    return { missing, total: results.length, covered };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("check_testids logic", () => {
    test("passes when all controls have data-testid", () => {
        const controls = [
            { tag: "button", testId: "btn-reply", name: "Reply" },
            { tag: "button", testId: "btn-forward", name: "Forward" },
            { tag: "a", testId: "link-attachment", name: "Download" },
        ];
        const result = runTestidCheck(controls);
        expect(result.missing.length).toBe(0);
        expect(result.covered).toBe(3);
        expect(result.total).toBe(3);
    });

    test("flags controls missing data-testid", () => {
        const controls = [
            { tag: "button", testId: "btn-reply", name: "Reply" },
            { tag: "button", testId: "", name: "Mystery Button" },
            { tag: "a", testId: "", name: "Unknown Link" },
        ];
        const result = runTestidCheck(controls);
        expect(result.missing.length).toBe(2);
        expect(result.missing[0].name).toBe("Mystery Button");
        expect(result.missing[1].name).toBe("Unknown Link");
    });

    test("excludes elements inside email body container", () => {
        const controls = [
            { tag: "button", testId: "btn-reply", name: "Reply" },
            // This link is inside the email body — should be excluded
            { tag: "a", testId: "", name: "Click here for offer", parentId: "email-body" },
            // This link is in the toolbar — should be checked
            { tag: "a", testId: "", name: "Toolbar Link" },
        ];
        const result = runTestidCheck(controls, {
            bodyContainerIds: ["email-body"],
        });
        expect(result.total).toBe(2); // body link excluded
        expect(result.missing.length).toBe(1);
        expect(result.missing[0].name).toBe("Toolbar Link");
    });

    test("excludes mailto links via allowlist", () => {
        const controls = [
            { tag: "button", testId: "btn-reply", name: "Reply" },
            {
                tag: "a", testId: "", name: "user@example.com",
                _matchesPatterns: ["a[href^='mailto:']"],
            },
        ];
        const result = runTestidCheck(controls, {
            allowMissing: ["a[href^='mailto:']"],
        });
        expect(result.missing.length).toBe(0);
    });

    test("excludes tel links via allowlist", () => {
        const controls = [
            {
                tag: "a", testId: "", name: "+1-555-0100",
                _matchesPatterns: ["a[href^='tel:']"],
            },
        ];
        const result = runTestidCheck(controls, {
            allowMissing: ["a[href^='tel:']"],
        });
        expect(result.missing.length).toBe(0);
    });

    test("skips hidden elements", () => {
        const controls = [
            { tag: "button", testId: "", name: "Hidden", hidden: true },
            { tag: "button", testId: "", name: "Visible" },
        ];
        const result = runTestidCheck(controls);
        expect(result.total).toBe(1);
        expect(result.missing[0].name).toBe("Visible");
    });

    test("skips disabled elements", () => {
        const controls = [
            { tag: "button", testId: "", name: "Disabled", disabled: true },
            { tag: "button", testId: "", name: "Enabled" },
        ];
        const result = runTestidCheck(controls);
        expect(result.total).toBe(1);
        expect(result.missing[0].name).toBe("Enabled");
    });

    test("multiple exclusion patterns combine correctly", () => {
        const controls = [
            { tag: "button", testId: "btn-ok", name: "OK" },
            {
                tag: "a", testId: "", name: "Email me",
                _matchesPatterns: ["a[href^='mailto:']"],
            },
            {
                tag: "a", testId: "", name: "Call us",
                _matchesPatterns: ["a[href^='tel:']"],
            },
            { tag: "summary", testId: "", name: "Details",
                _matchesPatterns: ["summary"],
            },
            { tag: "button", testId: "", name: "No testid, not excluded" },
        ];
        const result = runTestidCheck(controls, {
            allowMissing: ["a[href^='mailto:']", "a[href^='tel:']", "summary"],
        });
        expect(result.missing.length).toBe(1);
        expect(result.missing[0].name).toBe("No testid, not excluded");
    });

    test("complex scenario: body exclusion + allowlist + missing", () => {
        const controls = [
            { tag: "button", testId: "btn-archive", name: "Archive" },
            { tag: "button", testId: "btn-delete", name: "Delete" },
            // Inside email body — excluded
            { tag: "a", testId: "", name: "Phishing link", parentId: "msg-body" },
            { tag: "button", testId: "", name: "Unsubscribe", parentId: "msg-body" },
            // Informational link — allowlisted
            { tag: "a", testId: "", name: "user@co.com",
                _matchesPatterns: ["a[href^='mailto:']"],
            },
            // Missing testid — should be flagged
            { tag: "button", testId: "", name: "Unmarked toolbar button" },
        ];
        const result = runTestidCheck(controls, {
            bodyContainerIds: ["msg-body"],
            allowMissing: ["a[href^='mailto:']"],
        });
        expect(result.total).toBe(4); // 2 with testid + 1 allowlisted + 1 missing
        expect(result.covered).toBe(2);
        expect(result.missing.length).toBe(1);
        expect(result.missing[0].name).toBe("Unmarked toolbar button");
    });
});
