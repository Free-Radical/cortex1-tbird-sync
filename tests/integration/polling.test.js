/**
 * Integration Tests for Polling Behavior
 *
 * Tests the polling system including:
 * - Poll interval timing
 * - Pause/resume behavior
 * - Connection status tracking
 * - Multiple commands in single poll response
 * - Command processing and result posting
 */

const { createMockMessage, createMockFolder, createMockAccount, loadBackgroundScript } = require("../setup");

describe("Polling Behavior", () => {
    let bg;
    let mockMsg;

    beforeEach(() => {
        mockMsg = createMockMessage();

        // Setup default mock responses
        messenger.messages.query.mockResolvedValue({ messages: [mockMsg] });
        messenger.messages.get.mockResolvedValue(mockMsg);
        messenger.accounts.list.mockResolvedValue([createMockAccount()]);
        messenger.folders.query.mockResolvedValue([createMockFolder()]);

        // Default fetch mock - no pending commands
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ commands: [] })
        });

        bg = loadBackgroundScript();
    });

    // =========================================================================
    // Basic Polling
    // =========================================================================
    describe("pollForCommands()", () => {
        it("should fetch from /tbird-sync/pending endpoint", async () => {
            await bg.pollForCommands();

            expect(global.fetch).toHaveBeenCalledWith(
                expect.stringContaining("/tbird-sync/pending"),
                expect.objectContaining({
                    method: "GET",
                    headers: { "Accept": "application/json" }
                })
            );
        });

        it("should use configured server URL", async () => {
            messenger._storage._setData({
                cortex_server_url: "http://custom-server:8080"
            });

            // Need to reload to pick up new URL
            bg = loadBackgroundScript();
            await bg.pollForCommands();

            expect(global.fetch).toHaveBeenCalledWith(
                expect.stringContaining("http://custom-server:8080"),
                expect.any(Object)
            );
        });

        it("should use default server URL when not configured", async () => {
            messenger._storage._setData({});

            await bg.pollForCommands();

            expect(global.fetch).toHaveBeenCalledWith(
                expect.stringContaining("http://localhost:5001"),
                expect.any(Object)
            );
        });

        it("should do nothing when no commands pending", async () => {
            global.fetch.mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ commands: [] })
            });

            await bg.pollForCommands();

            // Should not post to /complete
            const completeCalls = global.fetch.mock.calls.filter(
                call => call[0].includes("/complete")
            );
            expect(completeCalls.length).toBe(0);
        });
    });

    // =========================================================================
    // Command Execution
    // =========================================================================
    describe("Command Execution", () => {
        it("should process single command", async () => {
            global.fetch
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve({
                        commands: [
                            { id: "cmd-1", action: "mark_read", messageId: "test@example.com" }
                        ]
                    })
                })
                .mockResolvedValueOnce({ ok: true }); // For /complete

            await bg.pollForCommands();

            // Should have called /complete
            const completeCalls = global.fetch.mock.calls.filter(
                call => call[0].includes("/complete")
            );
            expect(completeCalls.length).toBe(1);
        });

        it("should process multiple commands in single poll", async () => {
            global.fetch
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve({
                        commands: [
                            { id: "cmd-1", action: "mark_read", messageId: "test@example.com" },
                            { id: "cmd-2", action: "mark_unread", messageId: "test@example.com" },
                            { id: "cmd-3", action: "set_flagged", messageId: "test@example.com", flagged: true }
                        ]
                    })
                })
                .mockResolvedValueOnce({ ok: true });

            const updatedMsg = { ...mockMsg, read: true };
            messenger.messages.get.mockResolvedValue(updatedMsg);

            await bg.pollForCommands();

            // Check /complete was called with results for all 3 commands
            const completeCalls = global.fetch.mock.calls.filter(
                call => call[0].includes("/complete")
            );
            expect(completeCalls.length).toBe(1);

            const body = JSON.parse(completeCalls[0][1].body);
            expect(body.results.length).toBe(3);
        });

        it("should include command id and action in results", async () => {
            global.fetch
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve({
                        commands: [
                            { id: "cmd-123", action: "get_status", messageId: "test@example.com" }
                        ]
                    })
                })
                .mockResolvedValueOnce({ ok: true });

            await bg.pollForCommands();

            const completeCalls = global.fetch.mock.calls.filter(
                call => call[0].includes("/complete")
            );
            const body = JSON.parse(completeCalls[0][1].body);

            expect(body.results[0].id).toBe("cmd-123");
            expect(body.results[0].action).toBe("get_status");
        });

        it("should handle command processing errors", async () => {
            global.fetch
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve({
                        commands: [
                            { id: "cmd-1", action: "invalid_action" }
                        ]
                    })
                })
                .mockResolvedValueOnce({ ok: true });

            await bg.pollForCommands();

            const completeCalls = global.fetch.mock.calls.filter(
                call => call[0].includes("/complete")
            );
            const body = JSON.parse(completeCalls[0][1].body);

            expect(body.results[0].success).toBe(false);
            expect(body.results[0].error).toContain("Unknown action");
        });

        it("should handle exception during command processing", async () => {
            // Make messenger.messages.update throw
            messenger.messages.update.mockRejectedValue(new Error("Critical error"));

            global.fetch
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve({
                        commands: [
                            { id: "cmd-1", action: "mark_read", messageId: "test@example.com" }
                        ]
                    })
                })
                .mockResolvedValueOnce({ ok: true });

            await bg.pollForCommands();

            const completeCalls = global.fetch.mock.calls.filter(
                call => call[0].includes("/complete")
            );
            const body = JSON.parse(completeCalls[0][1].body);

            expect(body.results[0].success).toBe(false);
            expect(body.results[0].error).toContain("Critical error");
        });
    });

    // =========================================================================
    // Concurrent Polling Prevention
    // =========================================================================
    describe("Concurrent Polling Prevention", () => {
        it("should not start new poll while one is in progress", async () => {
            let resolvePoll;
            global.fetch.mockImplementation(() => new Promise(resolve => {
                resolvePoll = () => resolve({
                    ok: true,
                    json: () => Promise.resolve({ commands: [] })
                });
            }));

            // Start first poll
            const poll1 = bg.pollForCommands();

            // Try to start second poll immediately
            const poll2 = bg.pollForCommands();

            // Complete first poll
            resolvePoll();
            await poll1;
            await poll2;

            // Should only have made one fetch call
            expect(global.fetch).toHaveBeenCalledTimes(1);
        });

        it("should allow new poll after previous completes", async () => {
            global.fetch.mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ commands: [] })
            });

            await bg.pollForCommands();
            await bg.pollForCommands();

            expect(global.fetch).toHaveBeenCalledTimes(2);
        });
    });

    // =========================================================================
    // Error Handling
    // =========================================================================
    describe("Network Error Handling", () => {
        it("should handle fetch network error", async () => {
            global.fetch.mockRejectedValue(new Error("Network error"));

            // Should not throw
            await expect(bg.pollForCommands()).resolves.not.toThrow();
        });

        it("should handle non-ok response", async () => {
            global.fetch.mockResolvedValue({
                ok: false,
                status: 500
            });

            // Should not throw
            await expect(bg.pollForCommands()).resolves.not.toThrow();
        });

        it("should handle invalid JSON response", async () => {
            global.fetch.mockResolvedValue({
                ok: true,
                json: () => Promise.reject(new Error("Invalid JSON"))
            });

            // Should not throw
            await expect(bg.pollForCommands()).resolves.not.toThrow();
        });

        it("should handle missing commands array in response", async () => {
            global.fetch.mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({})  // No commands property
            });

            // Should not throw
            await expect(bg.pollForCommands()).resolves.not.toThrow();
        });

        it("should log poll errors to debug logger", async () => {
            bg.DebugLogger.logs = [];
            global.fetch.mockResolvedValue({
                ok: false,
                status: 503
            });

            await bg.pollForCommands();

            const pollLogs = bg.DebugLogger.logs.filter(l => l.cat === "poll");
            expect(pollLogs.length).toBeGreaterThan(0);
        });
    });

    // =========================================================================
    // Result Posting
    // =========================================================================
    describe("Result Posting", () => {
        it("should POST results to /tbird-sync/complete", async () => {
            global.fetch
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve({
                        commands: [
                            { id: "cmd-1", action: "get_status", messageId: "test@example.com" }
                        ]
                    })
                })
                .mockResolvedValueOnce({ ok: true });

            await bg.pollForCommands();

            const completeCalls = global.fetch.mock.calls.filter(
                call => call[0].includes("/complete")
            );
            expect(completeCalls.length).toBe(1);
            expect(completeCalls[0][1].method).toBe("POST");
            expect(completeCalls[0][1].headers["Content-Type"]).toBe("application/json");
        });

        it("should include results array in body", async () => {
            global.fetch
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve({
                        commands: [
                            { id: "cmd-1", action: "list_folders" }
                        ]
                    })
                })
                .mockResolvedValueOnce({ ok: true });

            await bg.pollForCommands();

            const completeCalls = global.fetch.mock.calls.filter(
                call => call[0].includes("/complete")
            );
            const body = JSON.parse(completeCalls[0][1].body);

            expect(body).toHaveProperty("results");
            expect(Array.isArray(body.results)).toBe(true);
        });

        it("should continue even if complete POST fails", async () => {
            global.fetch
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve({
                        commands: [
                            { id: "cmd-1", action: "get_status", messageId: "test@example.com" }
                        ]
                    })
                })
                .mockRejectedValueOnce(new Error("Complete POST failed"));

            // Should not throw
            await expect(bg.pollForCommands()).resolves.not.toThrow();
        });
    });

    // =========================================================================
    // Poll Interval
    // =========================================================================
    describe("Poll Interval", () => {
        it("should have correct poll interval constant", () => {
            expect(bg.POLL_INTERVAL_MS).toBe(3000);
        });
    });

    // =========================================================================
    // tb_state in Results
    // =========================================================================
    describe("tb_state in Poll Results", () => {
        it("should include tb_state for mark_read command", async () => {
            const updatedMsg = { ...mockMsg, read: true };
            messenger.messages.get.mockResolvedValue(updatedMsg);

            global.fetch
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve({
                        commands: [
                            { id: "cmd-1", action: "mark_read", messageId: "test@example.com" }
                        ]
                    })
                })
                .mockResolvedValueOnce({ ok: true });

            await bg.pollForCommands();

            const completeCalls = global.fetch.mock.calls.filter(
                call => call[0].includes("/complete")
            );
            const body = JSON.parse(completeCalls[0][1].body);

            expect(body.results[0].tb_state).toBeDefined();
            expect(body.results[0].tb_state.read).toBe(true);
        });

        it("should include tb_state for get_status command", async () => {
            global.fetch
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve({
                        commands: [
                            { id: "cmd-1", action: "get_status", messageId: "test@example.com" }
                        ]
                    })
                })
                .mockResolvedValueOnce({ ok: true });

            await bg.pollForCommands();

            const completeCalls = global.fetch.mock.calls.filter(
                call => call[0].includes("/complete")
            );
            const body = JSON.parse(completeCalls[0][1].body);

            expect(body.results[0].tb_state).toBeDefined();
            expect(body.results[0].tb_state.folder).toBeDefined();
        });

        it("should include tb_states array for archive command", async () => {
            messenger.messages.get.mockResolvedValue(mockMsg);

            global.fetch
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve({
                        commands: [
                            { id: "cmd-1", action: "archive", messageIds: ["test@example.com"] }
                        ]
                    })
                })
                .mockResolvedValueOnce({ ok: true });

            await bg.pollForCommands();

            const completeCalls = global.fetch.mock.calls.filter(
                call => call[0].includes("/complete")
            );
            const body = JSON.parse(completeCalls[0][1].body);

            expect(body.results[0].tb_states).toBeDefined();
            expect(Array.isArray(body.results[0].tb_states)).toBe(true);
        });
    });

    // =========================================================================
    // Complex Command Scenarios
    // =========================================================================
    describe("Complex Command Scenarios", () => {
        it("should handle mixed success/failure commands", async () => {
            messenger.messages.query
                .mockResolvedValueOnce({ messages: [mockMsg] })  // First message found
                .mockResolvedValueOnce({ messages: [] });         // Second message not found

            global.fetch
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve({
                        commands: [
                            { id: "cmd-1", action: "get_status", messageId: "test@example.com" },
                            { id: "cmd-2", action: "get_status", messageId: "nonexistent@example.com" }
                        ]
                    })
                })
                .mockResolvedValueOnce({ ok: true });

            await bg.pollForCommands();

            const completeCalls = global.fetch.mock.calls.filter(
                call => call[0].includes("/complete")
            );
            const body = JSON.parse(completeCalls[0][1].body);

            expect(body.results[0].success).toBe(true);
            expect(body.results[1].success).toBe(false);
        });

        it("should handle bulk commands", async () => {
            global.fetch
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve({
                        commands: [
                            {
                                id: "cmd-1",
                                action: "sync_state",
                                messageIds: ["test@example.com"]
                            }
                        ]
                    })
                })
                .mockResolvedValueOnce({ ok: true });

            await bg.pollForCommands();

            const completeCalls = global.fetch.mock.calls.filter(
                call => call[0].includes("/complete")
            );
            const body = JSON.parse(completeCalls[0][1].body);

            expect(body.results[0].action).toBe("sync_state");
            expect(body.results[0].states).toBeDefined();
        });

        it("should handle RPC commands", async () => {
            global.fetch
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve({
                        commands: [
                            {
                                id: "cmd-1",
                                action: "rpc",
                                method: "cortex.findMessageByHeaderId",
                                args: ["test@example.com"]
                            }
                        ]
                    })
                })
                .mockResolvedValueOnce({ ok: true });

            await bg.pollForCommands();

            const completeCalls = global.fetch.mock.calls.filter(
                call => call[0].includes("/complete")
            );
            const body = JSON.parse(completeCalls[0][1].body);

            expect(body.results[0].action).toBe("rpc");
            expect(body.results[0].method).toBe("cortex.findMessageByHeaderId");
        });
    });
});
