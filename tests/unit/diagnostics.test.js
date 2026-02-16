/**
 * Diagnostics Export Tests
 */

const { loadBackgroundScript } = require("../setup");

const decodeDataUrl = (url) => {
    const parts = String(url || "").split(",");
    return decodeURIComponent(parts.slice(1).join(","));
};

describe("Diagnostics Export", () => {
    let bg;

    beforeEach(() => {
        messenger._storage._clear();
        messenger._storage._setData({
            cortex_debug_enabled: false,
            cortex_debug_logs: [],
            cortex_recent_failures: []
        });

        bg = loadBackgroundScript();
    });

    it("should export JSON diagnostics with logs and failures", async () => {
        messenger.downloads.download.mockResolvedValue(101);
        bg.DebugLogger.logs = [];
        bg.FailureTracker.failures = [];

        bg.DebugLogger.log("poll", "Poll failed: HTTP 500", { error: "HTTP 500" });

        const result = await bg.exportDiagnostics();

        expect(result.success).toBe(true);
        expect(result.format).toBe("json");
        expect(result.filename).toMatch(/cortex1-diagnostics-.*\.json$/);
        expect(messenger.downloads.download).toHaveBeenCalled();

        const downloadArgs = messenger.downloads.download.mock.calls[0][0];
        expect(downloadArgs.saveAs).toBe(true);
        expect(downloadArgs.url).toMatch(/^data:application\/json/);

        const payload = JSON.parse(decodeDataUrl(downloadArgs.url));
        expect(payload.schemaVersion).toBe(1);
        expect(payload.debug.logs.length).toBeGreaterThan(0);
        expect(payload.recentFailures.length).toBeGreaterThan(0);
        expect(payload.eventQueue).toBeDefined();
    });

    it("should export JSONL diagnostics when requested", async () => {
        messenger.downloads.download.mockResolvedValue(202);
        bg.DebugLogger.logs = [];
        bg.FailureTracker.failures = [];

        bg.DebugLogger.log("cmd", "Result: FAIL", { error: "boom" });

        const result = await bg.exportDiagnostics({ format: "jsonl" });

        expect(result.success).toBe(true);
        expect(result.format).toBe("jsonl");
        expect(result.filename).toMatch(/cortex1-diagnostics-.*\.jsonl$/);

        const downloadArgs = messenger.downloads.download.mock.calls[0][0];
        expect(downloadArgs.url).toMatch(/^data:application\/x-ndjson/);

        const lines = decodeDataUrl(downloadArgs.url).trim().split("\n");
        const meta = JSON.parse(lines[0]);
        expect(meta.type).toBe("meta");
        const types = lines.map(line => JSON.parse(line).type);
        expect(types).toContain("log");
        expect(types).toContain("failure");
    });

    it("should export when logs and failures are empty", async () => {
        messenger.downloads.download.mockResolvedValue(303);
        bg.DebugLogger.logs = [];
        bg.FailureTracker.failures = [];

        const result = await bg.exportDiagnostics({ format: "unknown" });

        expect(result.success).toBe(true);
        expect(result.format).toBe("json");

        const downloadArgs = messenger.downloads.download.mock.calls[0][0];
        const payload = JSON.parse(decodeDataUrl(downloadArgs.url));
        expect(payload.debug.logs).toEqual([]);
        expect(payload.recentFailures).toEqual([]);
    });

    it("should return error when downloads API is missing", async () => {
        const saved = messenger.downloads;
        delete messenger.downloads;

        const result = await bg.exportDiagnostics();

        expect(result.success).toBe(false);
        expect(result.error).toContain("downloads API not available");

        messenger.downloads = saved;
    });

    it("should return error when download fails", async () => {
        messenger.downloads.download.mockRejectedValue(new Error("Download failed"));

        const result = await bg.exportDiagnostics();

        expect(result.success).toBe(false);
        expect(result.error).toBe("Download failed");
    });

    it("should register toolbar menu item", () => {
        expect(messenger.menus.create).toHaveBeenCalledWith({
            id: "export-diagnostics",
            title: "Export Diagnostics",
            contexts: ["browser_action"]
        });
    });

    it("should export via menu click", async () => {
        messenger.downloads.download.mockResolvedValue(404);

        const handler = messenger.menus.onClicked.addListener.mock.calls[0][0];
        await handler({ menuItemId: "export-diagnostics" });

        expect(messenger.downloads.download).toHaveBeenCalled();
    });

    it("should export via command", async () => {
        messenger.downloads.download.mockResolvedValue(505);

        const handler = messenger.commands.onCommand.addListener.mock.calls[0][0];
        await handler("export-diagnostics");

        expect(messenger.downloads.download).toHaveBeenCalled();
    });
});

describe("FailureTracker", () => {
    let bg;

    beforeEach(() => {
        messenger._storage._clear();
        messenger._storage._setData({
            cortex_recent_failures: []
        });

        bg = loadBackgroundScript();
    });

    it("should restore failures from storage", async () => {
        const existing = [
            { ts: "2025-01-01T00:00:00.000Z", cat: "poll", msg: "Poll failed", data: null }
        ];
        messenger._storage._setData({
            cortex_recent_failures: existing
        });

        await bg.FailureTracker.init();

        expect(bg.FailureTracker.getFailures()).toEqual(existing);
    });

    it("should record and trim failures", () => {
        bg.FailureTracker.failures = [];
        const maxEntries = bg.FAILURE_MAX_ENTRIES;
        const overflow = maxEntries + 5;

        for (let i = 0; i < overflow; i += 1) {
            bg.FailureTracker.record("poll", `Fail ${i}`, { error: "boom" });
        }

        expect(bg.FailureTracker.getFailures().length).toBe(maxEntries);
        expect(bg.FailureTracker.getFailures()[0].msg).toBe(`Fail ${overflow - maxEntries}`);
    });

    it("should record failures via DebugLogger", () => {
        bg.FailureTracker.failures = [];
        bg.DebugLogger.logs = [];

        bg.DebugLogger.log("poll", "Poll failed: HTTP 500");

        expect(bg.FailureTracker.getFailures().length).toBe(1);
        expect(bg.FailureTracker.getFailures()[0].cat).toBe("poll");
    });
});
