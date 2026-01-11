/**
 * Unit Tests for Debug Logger
 *
 * Tests the DebugLogger system including:
 * - Rolling buffer (max 5 entries)
 * - Persistence to storage
 * - Toggle on/off
 * - Log entry structure
 */

const { loadBackgroundScript } = require("../setup");

describe("Debug Logger", () => {
    let bg;

    beforeEach(() => {
        // Setup clean storage
        messenger._storage._clear();
        messenger._storage._setData({
            cortex_debug_enabled: false,
            cortex_debug_logs: []
        });

        bg = loadBackgroundScript();
    });

    // =========================================================================
    // Initialization
    // =========================================================================
    describe("init()", () => {
        it("should restore enabled state from storage", async () => {
            messenger._storage._setData({
                cortex_debug_enabled: true,
                cortex_debug_logs: []
            });

            await bg.DebugLogger.init();

            expect(bg.DebugLogger.enabled).toBe(true);
        });

        it("should restore logs from storage", async () => {
            const existingLogs = [
                { ts: "10:00:00.000", cat: "test", msg: "message1", data: null },
                { ts: "10:00:01.000", cat: "test", msg: "message2", data: null }
            ];

            messenger._storage._setData({
                cortex_debug_enabled: false,
                cortex_debug_logs: existingLogs
            });

            await bg.DebugLogger.init();

            expect(bg.DebugLogger.logs).toEqual(existingLogs);
        });

        it("should default to disabled on storage error", async () => {
            messenger.storage.local.get.mockRejectedValue(new Error("Storage error"));

            await bg.DebugLogger.init();

            expect(bg.DebugLogger.enabled).toBe(false);
            expect(bg.DebugLogger.logs).toEqual([]);
        });

        it("should handle empty storage", async () => {
            messenger._storage._setData({});

            await bg.DebugLogger.init();

            expect(bg.DebugLogger.enabled).toBe(false);
            expect(bg.DebugLogger.logs).toEqual([]);
        });

        it("should handle non-array logs in storage", async () => {
            messenger._storage._setData({
                cortex_debug_enabled: false,
                cortex_debug_logs: "invalid"
            });

            await bg.DebugLogger.init();

            expect(bg.DebugLogger.logs).toEqual([]);
        });
    });

    // =========================================================================
    // Logging
    // =========================================================================
    describe("log()", () => {
        it("should add entry to logs array", () => {
            bg.DebugLogger.logs = [];
            bg.DebugLogger.log("test", "Test message");

            expect(bg.DebugLogger.logs.length).toBe(1);
        });

        it("should create entry with correct structure", () => {
            bg.DebugLogger.logs = [];
            bg.DebugLogger.log("category", "Test message", { key: "value" });

            const entry = bg.DebugLogger.logs[0];
            expect(entry).toHaveProperty("ts");
            expect(entry).toHaveProperty("cat", "category");
            expect(entry).toHaveProperty("msg", "Test message");
            expect(entry).toHaveProperty("data", { key: "value" });
        });

        it("should format timestamp as HH:MM:SS.mmm", () => {
            bg.DebugLogger.logs = [];
            bg.DebugLogger.log("test", "message");

            const entry = bg.DebugLogger.logs[0];
            // Should match format: "10:30:45.123"
            expect(entry.ts).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
        });

        it("should default data to null", () => {
            bg.DebugLogger.logs = [];
            bg.DebugLogger.log("test", "message");

            const entry = bg.DebugLogger.logs[0];
            expect(entry.data).toBeNull();
        });

        it("should persist to storage after logging", () => {
            bg.DebugLogger.logs = [];
            bg.DebugLogger.log("test", "message");

            expect(messenger.storage.local.set).toHaveBeenCalledWith({
                cortex_debug_logs: expect.any(Array)
            });
        });

        it("should not console.log when disabled", () => {
            bg.DebugLogger.enabled = false;
            bg.DebugLogger.logs = [];
            // Clear mock from startup logs
            console.log.mockClear();

            bg.DebugLogger.log("test", "message");

            expect(console.log).not.toHaveBeenCalled();
        });

        it("should console.log when enabled", () => {
            bg.DebugLogger.enabled = true;
            bg.DebugLogger.logs = [];
            // Clear mock from startup logs
            console.log.mockClear();

            bg.DebugLogger.log("test", "message");

            expect(console.log).toHaveBeenCalled();
            expect(console.log).toHaveBeenCalledWith(
                expect.stringContaining("[DEBUG:test]")
            );
        });

        it("should include data in console output when present", () => {
            bg.DebugLogger.enabled = true;
            bg.DebugLogger.logs = [];
            bg.DebugLogger.log("test", "message", { key: "value" });

            expect(console.log).toHaveBeenCalledWith(
                expect.stringContaining('{"key":"value"}')
            );
        });
    });

    // =========================================================================
    // Rolling Buffer (Max Entries)
    // =========================================================================
    describe("Rolling Buffer", () => {
        it("should keep only last max entries", () => {
            bg.DebugLogger.logs = [];

            const maxEntries = bg.DEBUG_MAX_ENTRIES;
            const overflow = maxEntries + 2;

            // Add more than max entries
            for (let i = 1; i <= overflow; i++) {
                bg.DebugLogger.log("test", `message ${i}`);
            }

            expect(bg.DebugLogger.logs.length).toBe(maxEntries);
        });

        it("should drop oldest entries first", () => {
            bg.DebugLogger.logs = [];

            const maxEntries = bg.DEBUG_MAX_ENTRIES;
            const overflow = maxEntries + 2;

            // Add more than max entries
            for (let i = 1; i <= overflow; i++) {
                bg.DebugLogger.log("test", `message ${i}`);
            }

            const expectedStart = overflow - maxEntries + 1;
            const expectedEnd = overflow;

            expect(bg.DebugLogger.logs[0].msg).toBe(`message ${expectedStart}`);
            expect(bg.DebugLogger.logs[maxEntries - 1].msg).toBe(`message ${expectedEnd}`);
        });

        it("should maintain max entries even with multiple rapid logs", () => {
            bg.DebugLogger.logs = [];

            const maxEntries = bg.DEBUG_MAX_ENTRIES;
            const overflow = maxEntries * 2;

            // Add many entries
            for (let i = 1; i <= overflow; i++) {
                bg.DebugLogger.log("test", `message ${i}`);
            }

            expect(bg.DebugLogger.logs.length).toBe(maxEntries);
            expect(bg.DebugLogger.logs[maxEntries - 1].msg).toBe(`message ${overflow}`);
        });

        it("should persist truncated logs to storage", () => {
            bg.DebugLogger.logs = [];

            const maxEntries = bg.DEBUG_MAX_ENTRIES;
            const overflow = maxEntries + 2;

            // Add more than max entries
            for (let i = 1; i <= overflow; i++) {
                bg.DebugLogger.log("test", `message ${i}`);
            }

            // Last storage call should have max entries
            const lastCall = messenger.storage.local.set.mock.calls.pop();
            expect(lastCall[0].cortex_debug_logs.length).toBe(maxEntries);
        });
    });

    // =========================================================================
    // getLogs()
    // =========================================================================
    describe("getLogs()", () => {
        it("should return current logs array", () => {
            bg.DebugLogger.logs = [
                { ts: "10:00:00.000", cat: "test", msg: "msg1", data: null }
            ];

            const logs = bg.DebugLogger.getLogs();

            expect(logs).toEqual(bg.DebugLogger.logs);
        });

        it("should return empty array when no logs", () => {
            bg.DebugLogger.logs = [];

            const logs = bg.DebugLogger.getLogs();

            expect(logs).toEqual([]);
        });

        it("should return reference to internal array", () => {
            bg.DebugLogger.logs = [];
            bg.DebugLogger.log("test", "message");

            const logs = bg.DebugLogger.getLogs();

            expect(logs).toBe(bg.DebugLogger.logs);
        });
    });

    // =========================================================================
    // clear()
    // =========================================================================
    describe("clear()", () => {
        it("should clear all logs", () => {
            bg.DebugLogger.logs = [
                { ts: "10:00:00.000", cat: "test", msg: "msg1", data: null },
                { ts: "10:00:01.000", cat: "test", msg: "msg2", data: null }
            ];

            bg.DebugLogger.clear();

            expect(bg.DebugLogger.logs).toEqual([]);
        });

        it("should persist empty array to storage", () => {
            bg.DebugLogger.logs = [
                { ts: "10:00:00.000", cat: "test", msg: "msg1", data: null }
            ];

            bg.DebugLogger.clear();

            expect(messenger.storage.local.set).toHaveBeenCalledWith({
                cortex_debug_logs: []
            });
        });
    });

    // =========================================================================
    // toggle()
    // =========================================================================
    describe("toggle()", () => {
        it("should toggle from disabled to enabled", () => {
            bg.DebugLogger.enabled = false;

            const result = bg.DebugLogger.toggle();

            expect(result).toBe(true);
            expect(bg.DebugLogger.enabled).toBe(true);
        });

        it("should toggle from enabled to disabled", () => {
            bg.DebugLogger.enabled = true;

            const result = bg.DebugLogger.toggle();

            expect(result).toBe(false);
            expect(bg.DebugLogger.enabled).toBe(false);
        });

        it("should persist new state to storage", () => {
            bg.DebugLogger.enabled = false;

            bg.DebugLogger.toggle();

            expect(messenger.storage.local.set).toHaveBeenCalledWith({
                cortex_debug_enabled: true
            });
        });

        it("should log toggle action", () => {
            bg.DebugLogger.enabled = false;
            bg.DebugLogger.logs = [];

            bg.DebugLogger.toggle();

            // Should have logged the toggle
            expect(bg.DebugLogger.logs.length).toBeGreaterThan(0);
            expect(bg.DebugLogger.logs[0].msg).toContain("enabled");
        });

        it("should return new state", () => {
            bg.DebugLogger.enabled = false;

            expect(bg.DebugLogger.toggle()).toBe(true);
            expect(bg.DebugLogger.toggle()).toBe(false);
            expect(bg.DebugLogger.toggle()).toBe(true);
        });
    });

    // =========================================================================
    // Storage Error Handling
    // =========================================================================
    describe("Storage Error Handling", () => {
        it("should not throw on storage.set error during log", () => {
            messenger.storage.local.set.mockRejectedValue(new Error("Storage error"));
            bg.DebugLogger.logs = [];

            expect(() => bg.DebugLogger.log("test", "message")).not.toThrow();
        });

        it("should not throw on storage.set error during clear", () => {
            messenger.storage.local.set.mockRejectedValue(new Error("Storage error"));

            expect(() => bg.DebugLogger.clear()).not.toThrow();
        });

        it("should still add to memory log even if storage fails", () => {
            messenger.storage.local.set.mockRejectedValue(new Error("Storage error"));
            bg.DebugLogger.logs = [];

            bg.DebugLogger.log("test", "message");

            expect(bg.DebugLogger.logs.length).toBe(1);
        });
    });

    // =========================================================================
    // Log Categories
    // =========================================================================
    describe("Log Categories", () => {
        it("should support various category names", () => {
            bg.DebugLogger.logs = [];

            bg.DebugLogger.log("cmd", "command log");
            bg.DebugLogger.log("poll", "poll log");
            bg.DebugLogger.log("find", "find log");
            bg.DebugLogger.log("startup", "startup log");
            bg.DebugLogger.log("debug", "debug log");

            expect(bg.DebugLogger.logs[0].cat).toBe("cmd");
            expect(bg.DebugLogger.logs[1].cat).toBe("poll");
            expect(bg.DebugLogger.logs[2].cat).toBe("find");
            expect(bg.DebugLogger.logs[3].cat).toBe("startup");
            expect(bg.DebugLogger.logs[4].cat).toBe("debug");
        });
    });

    // =========================================================================
    // Integration with Command Processing
    // =========================================================================
    describe("Integration with Commands", () => {
        it("should log raw commands", async () => {
            bg.DebugLogger.logs = [];

            await bg.processCommand({ action: "get_status", messageId: "test@example.com" });

            // Should have logged the command
            const cmdLogs = bg.DebugLogger.logs.filter(l => l.cat === "cmd");
            expect(cmdLogs.length).toBeGreaterThan(0);
        });

        it("should log command results", async () => {
            bg.DebugLogger.logs = [];
            messenger.messages.query.mockResolvedValue({ messages: [] });

            await bg.processCommand({ action: "get_status", messageId: "test@example.com" });

            // Should have result log (success or fail)
            expect(bg.DebugLogger.logs.length).toBeGreaterThan(0);
        });
    });
});
