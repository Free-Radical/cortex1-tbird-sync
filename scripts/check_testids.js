#!/usr/bin/env node
/**
 * check_testids.js — CI enforcement for data-testid on interactive controls.
 *
 * This script uses Playwright to open the email view and verify that every
 * visible, enabled interactive control inside the email view container has
 * a `data-testid` attribute.
 *
 * Usage:
 *   node scripts/check_testids.js
 *
 * Environment variables:
 *   EMAIL_VIEW_BASE_URL          – target email app URL (required).
 *   EMAIL_VIEW_CONTAINER_SELECTOR – container CSS selector.
 *   EMAIL_VIEW_BODY_SELECTOR     – email body content selector(s) to EXCLUDE.
 *   EMAIL_VIEW_LIST_PATH         – path to email list page.
 *   EMAIL_VIEW_HEADLESS          – "1"/"true" for headless (default true).
 *   TESTID_ALLOW_MISSING         – comma-separated CSS selectors to skip
 *                                   (e.g. "a[href^='mailto:'],summary").
 *   TESTID_EXIT_ZERO             – "1" to always exit 0 (dry-run / advisory).
 *
 * Exit codes:
 *   0 – all controls have data-testid (or TESTID_EXIT_ZERO=1).
 *   1 – one or more controls missing data-testid.
 *   2 – setup error (Playwright not installed, URL not set, etc.).
 */
"use strict";

const INTERACTIVE_SELECTOR =
    "button, a[href], [role='button'], [role='menuitem'], [role='tab'], " +
    "[role='option'], [role='link'], [onclick], input, select, textarea, " +
    "summary, [tabindex]:not([tabindex='-1'])";

async function main() {
    const baseUrl = (process.env.EMAIL_VIEW_BASE_URL || "").trim();
    if (!baseUrl) {
        console.log("[check_testids] EMAIL_VIEW_BASE_URL not set — skipping.");
        process.exit(0);
    }

    let playwright;
    try {
        playwright = require("playwright");
    } catch (e) {
        console.error("[check_testids] Playwright not installed. npm i -D playwright to enable.");
        process.exit(2);
    }

    const containerSelector = process.env.EMAIL_VIEW_CONTAINER_SELECTOR ||
        "[data-testid='email-view'], [data-testid='message-view'], main";
    const bodySelector = process.env.EMAIL_VIEW_BODY_SELECTOR ||
        "[data-testid='email-body'], [data-testid='message-body'], article, .message-body, .email-body";
    const listPath = process.env.EMAIL_VIEW_LIST_PATH || "/mail";
    const headless = (process.env.EMAIL_VIEW_HEADLESS || "1").trim().toLowerCase() !== "0";
    const exitZero = (process.env.TESTID_EXIT_ZERO || "").trim().toLowerCase() === "1";
    // Built-in exclusions: informational links (mailto, tel), elements inside
    // rendered email body content, and user-provided selectors.
    const builtinExclusions = [
        "a[href^='mailto:']",
        "a[href^='tel:']",
    ];
    const userExclusions = (process.env.TESTID_ALLOW_MISSING || "")
        .split(",").map(s => s.trim()).filter(Boolean);
    const allowMissing = builtinExclusions.concat(userExclusions);

    const browser = await playwright.chromium.launch({ headless });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
        // Navigate to email list and open first message
        const entryUrl = baseUrl.replace(/\/+$/, "") + "/" + listPath.replace(/^\/+/, "");
        await page.goto(entryUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

        const messageRowSelector =
            process.env.EMAIL_VIEW_MESSAGE_ROW_SELECTOR ||
            "[data-testid='email-list-item'], [role='row'][data-message-id], [role='listitem']";
        await page.locator(messageRowSelector).first().waitFor({ state: "visible", timeout: 20000 });
        await page.locator(messageRowSelector).first().click({ timeout: 5000 });

        const subjectSelector =
            process.env.EMAIL_VIEW_SUBJECT_SELECTOR ||
            "[data-testid='email-subject'], [data-testid='message-subject'], h1, [role='heading']";
        await page.locator(subjectSelector).first().waitFor({ state: "visible", timeout: 20000 });

        // Collect interactive controls (ONLY inside email view container,
        // EXCLUDING rendered email body content)
        const results = await page.evaluate(
            ({ containerSelector, bodySelector, interactiveSelector, allowMissing }) => {
                const container = document.querySelector(containerSelector);
                if (!container) return { error: "Container not found: " + containerSelector, controls: [] };

                // Find email body containers to exclude
                const bodyContainers = bodySelector
                    ? Array.from(container.querySelectorAll(bodySelector))
                    : [];

                const nodes = Array.from(container.querySelectorAll(interactiveSelector));
                const controls = [];

                for (const el of nodes) {
                    // Skip elements inside rendered email body content
                    let insideBody = false;
                    for (const bc of bodyContainers) {
                        if (bc.contains(el)) { insideBody = true; break; }
                    }
                    if (insideBody) continue;

                    const style = window.getComputedStyle(el);
                    if (style.display === "none" || style.visibility === "hidden") continue;
                    const rect = el.getBoundingClientRect();
                    if (rect.width <= 0 || rect.height <= 0) continue;
                    if (el.disabled || el.getAttribute("aria-disabled") === "true") continue;

                    const tag = (el.tagName || "").toLowerCase();
                    const role = el.getAttribute("role") || "";
                    const testId = el.getAttribute("data-testid") || "";
                    const name = (el.getAttribute("aria-label") || el.innerText || "").trim().substring(0, 60);

                    // Check allow list (built-in + user-provided exclusions)
                    const outerHTML = el.outerHTML.substring(0, 200);
                    let allowed = false;
                    for (const pattern of allowMissing) {
                        try {
                            if (el.matches(pattern)) { allowed = true; break; }
                        } catch (e) { /* invalid selector — skip */ }
                    }

                    controls.push({
                        tag,
                        role,
                        testId,
                        name,
                        allowed,
                        insideBody: false,
                        snippet: outerHTML,
                    });
                }

                return { error: null, controls };
            },
            { containerSelector, bodySelector, interactiveSelector: INTERACTIVE_SELECTOR, allowMissing }
        );

        if (results.error) {
            console.error("[check_testids] " + results.error);
            process.exit(2);
        }

        const missing = results.controls.filter(c => !c.testId && !c.allowed);
        const total = results.controls.length;
        const covered = results.controls.filter(c => !!c.testId).length;

        console.log(`[check_testids] ${total} interactive controls found, ${covered} have data-testid.`);

        if (missing.length > 0) {
            console.error(`[check_testids] ${missing.length} control(s) MISSING data-testid:`);
            for (const c of missing) {
                console.error(`  - <${c.tag}${c.role ? " role=" + c.role : ""}> "${c.name}"`);
                console.error(`    ${c.snippet}`);
            }

            if (exitZero) {
                console.log("[check_testids] TESTID_EXIT_ZERO=1 — exiting 0 (advisory mode).");
                process.exit(0);
            }
            process.exit(1);
        }

        console.log("[check_testids] All interactive controls have data-testid.");
    } finally {
        await context.close();
        await browser.close();
    }
}

main().catch(err => {
    console.error("[check_testids] Unexpected error:", err.message || err);
    process.exit(2);
});
