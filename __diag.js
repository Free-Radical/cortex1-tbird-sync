/**
 * __diag.js — Diagnostics page logic for dead-click / rage-click events.
 *
 * Reads from:
 *   1. window.__deadClicks (live, if detector is installed in same window/context)
 *   2. window.opener?.__deadClicks (if opened from the app window)
 *   3. Manual JSON paste/import
 *
 * This page is designed to work:
 *   - As a Thunderbird extension page (moz-extension://.../__diag.html)
 *   - Opened directly in a browser alongside the app
 *   - With exported JSON data
 */
(function () {
    "use strict";

    var tbody = document.getElementById("event-tbody");
    var countEl = document.getElementById("event-count");
    var statusEl = document.getElementById("status");
    var emptyEl = document.getElementById("empty-state");
    var filterType = document.getElementById("filter-type");
    var filterSearch = document.getElementById("filter-search");

    var allEvents = [];

    // =========================================================================
    // Data sources
    // =========================================================================

    function readEvents() {
        // Try same-window first
        if (Array.isArray(window.__deadClicks) && window.__deadClicks.length > 0) {
            return window.__deadClicks.slice();
        }
        // Try opener (popup scenario)
        try {
            if (window.opener && Array.isArray(window.opener.__deadClicks)) {
                return window.opener.__deadClicks.slice();
            }
        } catch (e) { /* cross-origin — ignore */ }
        // Try parent (iframe scenario)
        try {
            if (window.parent !== window && Array.isArray(window.parent.__deadClicks)) {
                return window.parent.__deadClicks.slice();
            }
        } catch (e) { /* cross-origin — ignore */ }
        return [];
    }

    // =========================================================================
    // Rendering
    // =========================================================================

    function formatTs(ts) {
        try {
            var d = new Date(ts);
            return d.toISOString().substring(11, 23);
        } catch (e) {
            return String(ts);
        }
    }

    function escapeHtml(s) {
        var div = document.createElement("div");
        div.textContent = s;
        return div.innerHTML;
    }

    function matchesFilter(evt) {
        var typeVal = filterType.value;
        if (typeVal && evt.type !== typeVal) return false;

        var search = (filterSearch.value || "").toLowerCase().trim();
        if (!search) return true;

        var haystack = [
            evt.route || "",
            evt.control ? evt.control.testId || "" : "",
            evt.control ? evt.control.accessibleName || "" : "",
            evt.control ? evt.control.tag || "" : "",
            evt.control ? evt.control.role || "" : "",
            evt.type || ""
        ].join(" ").toLowerCase();

        return haystack.indexOf(search) !== -1;
    }

    function render() {
        var filtered = allEvents.filter(matchesFilter);
        var html = "";

        if (filtered.length === 0) {
            tbody.innerHTML = "";
            emptyEl.style.display = allEvents.length === 0 ? "block" : "none";
            countEl.textContent = allEvents.length + " events" + (allEvents.length !== filtered.length ? " (" + filtered.length + " shown)" : "");
            return;
        }

        emptyEl.style.display = "none";

        // Show newest first
        for (var i = filtered.length - 1; i >= 0; i--) {
            var evt = filtered[i];
            var c = evt.control || {};
            var badgeClass = evt.type === "rage_click" ? "badge-rage" : "badge-dead";
            var typeClass = "type-" + (evt.type || "dead_click");
            var bbox = c.bbox ? c.bbox.x + "," + c.bbox.y + " " + c.bbox.w + "x" + c.bbox.h : "";

            html +=
                "<tr>" +
                "<td>" + (i + 1) + "</td>" +
                '<td><span class="badge ' + badgeClass + '">' + escapeHtml(evt.type || "dead_click") + "</span></td>" +
                "<td>" + escapeHtml(formatTs(evt.ts)) + "</td>" +
                "<td>" + escapeHtml(evt.route || "") + "</td>" +
                "<td>" + escapeHtml((c.tag || "") + (c.role ? "[" + c.role + "]" : "") + " " + (c.accessibleName || "").substring(0, 50)) + "</td>" +
                "<td>" + escapeHtml(c.testId || "-") + "</td>" +
                "<td class='mono'>" + escapeHtml(bbox) + "</td>" +
                "</tr>";
        }

        tbody.innerHTML = html;
        countEl.textContent = allEvents.length + " events" + (allEvents.length !== filtered.length ? " (" + filtered.length + " shown)" : "");
    }

    function refresh() {
        allEvents = readEvents();
        render();
        statusEl.textContent = "refreshed " + new Date().toLocaleTimeString();
        setTimeout(function () { statusEl.textContent = ""; }, 2000);
    }

    // =========================================================================
    // Export
    // =========================================================================

    function exportJSON() {
        var json = JSON.stringify(allEvents, null, 2);
        var blob = new Blob([json], { type: "application/json" });
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url;
        a.download = "dead_clicks_" + new Date().toISOString().replace(/[:.]/g, "-") + ".json";
        a.click();
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }

    function clearEvents() {
        allEvents = [];
        // Also clear the source buffer if possible
        if (Array.isArray(window.__deadClicks)) {
            window.__deadClicks.length = 0;
        }
        try {
            if (window.opener && window.opener.__deadClickDetector) {
                window.opener.__deadClickDetector.reset();
            }
        } catch (e) { /* cross-origin */ }
        render();
    }

    // =========================================================================
    // Init
    // =========================================================================

    document.getElementById("btn-refresh").addEventListener("click", refresh);
    document.getElementById("btn-export").addEventListener("click", exportJSON);
    document.getElementById("btn-clear").addEventListener("click", clearEvents);
    filterType.addEventListener("change", render);
    filterSearch.addEventListener("input", render);

    // Auto-refresh every 2 seconds
    setInterval(refresh, 2000);

    // Initial load
    refresh();
})();
