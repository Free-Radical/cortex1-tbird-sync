/**
 * Load Tests for tbird-sync ↔ cortex_server communication.
 *
 * Uses stub_server.js to simulate cortex_server without external dependencies.
 *
 * Run with:
 *   npm test -- --testPathPattern=load
 */

const http = require("http");
const { spawn } = require("child_process");
const path = require("path");

const STUB_PORT = 5099;  // Use non-standard port to avoid conflicts
const STUB_URL = `http://localhost:${STUB_PORT}`;

// Helper to make HTTP requests
function request(method, urlPath, body = null) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlPath, STUB_URL);
        const options = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method,
            headers: body ? { "Content-Type": "application/json" } : {},
            timeout: 10000,
        };

        const req = http.request(options, (res) => {
            let data = "";
            res.on("data", chunk => data += chunk);
            res.on("end", () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(data) });
                } catch {
                    resolve({ status: res.statusCode, data });
                }
            });
        });

        req.on("error", reject);
        req.on("timeout", () => {
            req.destroy();
            reject(new Error("Request timeout"));
        });

        if (body) {
            req.write(JSON.stringify(body));
        }
        req.end();
    });
}

// Parallel request helper
async function parallelRequests(count, fn) {
    const promises = [];
    for (let i = 0; i < count; i++) {
        promises.push(fn(i));
    }
    return Promise.all(promises);
}

describe("Load Tests with Stub Server", () => {
    let stubProcess = null;

    beforeAll(async () => {
        // Start stub server
        const stubPath = path.join(__dirname, "..", "stub_server.js");
        stubProcess = spawn("node", [stubPath, STUB_PORT.toString()], {
            stdio: "pipe",
        });

        // Wait for server to start
        await new Promise((resolve, reject) => {
            let output = "";
            stubProcess.stdout.on("data", (data) => {
                output += data.toString();
                if (output.includes("running on")) {
                    resolve();
                }
            });
            stubProcess.stderr.on("data", (data) => {
                console.error("Stub server error:", data.toString());
            });
            stubProcess.on("error", reject);
            setTimeout(() => reject(new Error("Stub server start timeout")), 5000);
        });
    });

    afterAll(async () => {
        if (stubProcess) {
            stubProcess.kill("SIGTERM");
            // Wait for process to exit
            await new Promise(resolve => {
                stubProcess.on("exit", resolve);
                setTimeout(resolve, 500);  // Fallback timeout
            });
            stubProcess = null;
        }
    });

    beforeEach(async () => {
        // Clear state between tests
        await request("POST", "/test/clear");
    });

    // =========================================================================
    // New Email Load Tests
    // =========================================================================
    describe("New Email Heavy Load", () => {
        it("should handle 100 emails posted sequentially", async () => {
            const start = Date.now();
            let success = 0;
            let failed = 0;

            for (let i = 0; i < 100; i++) {
                try {
                    const resp = await request("POST", "/tbird-sync/new-email", {
                        message_id: `<seq-${i}@test.example.com>`,
                        account_id: "account1",
                        folder: "/INBOX",
                        subject: `Sequential email ${i}`,
                    });
                    if (resp.status === 200) success++;
                    else failed++;
                } catch {
                    failed++;
                }
            }

            const elapsed = Date.now() - start;
            const rate = (success / (elapsed / 1000)).toFixed(1);

            console.log(`\n100 emails sequential: ${success} ok, ${failed} failed in ${elapsed}ms (${rate}/s)`);

            expect(success).toBe(100);
            expect(failed).toBe(0);

            // Verify all received
            const stats = await request("GET", "/test/stats");
            expect(stats.data.emailsReceived).toBe(100);
        }, 30000);

        it("should handle 100 emails posted in parallel (20 concurrent)", async () => {
            const start = Date.now();
            const batchSize = 20;
            const totalEmails = 100;
            let success = 0;
            let failed = 0;

            // Process in batches of 20
            for (let batch = 0; batch < totalEmails / batchSize; batch++) {
                const results = await parallelRequests(batchSize, async (i) => {
                    const idx = batch * batchSize + i;
                    try {
                        return await request("POST", "/tbird-sync/new-email", {
                            message_id: `<par-${idx}@test.example.com>`,
                            account_id: "account1",
                            folder: "/INBOX",
                        });
                    } catch (e) {
                        return { status: 0, error: e.message };
                    }
                });

                results.forEach(r => {
                    if (r.status === 200) success++;
                    else failed++;
                });
            }

            const elapsed = Date.now() - start;
            const rate = (success / (elapsed / 1000)).toFixed(1);

            console.log(`\n100 emails parallel: ${success} ok, ${failed} failed in ${elapsed}ms (${rate}/s)`);

            expect(success).toBe(100);

            const stats = await request("GET", "/test/stats");
            expect(stats.data.emailsReceived).toBe(100);
        }, 30000);

        it("should handle 100 emails while polling /pending", async () => {
            const start = Date.now();
            let emailSuccess = 0;
            let pollSuccess = 0;

            for (let i = 0; i < 100; i++) {
                // Post email
                try {
                    const resp = await request("POST", "/tbird-sync/new-email", {
                        message_id: `<mixed-${i}@test.example.com>`,
                    });
                    if (resp.status === 200) emailSuccess++;
                } catch {
                    // ignore
                }

                // Poll every 3rd email
                if (i % 3 === 0) {
                    try {
                        const resp = await request("GET", "/tbird-sync/pending");
                        if (resp.status === 200) pollSuccess++;
                    } catch {
                        // ignore
                    }
                }
            }

            const elapsed = Date.now() - start;

            console.log(`\n100 emails + polling: ${emailSuccess} emails, ${pollSuccess} polls in ${elapsed}ms`);

            expect(emailSuccess).toBe(100);
            expect(pollSuccess).toBeGreaterThan(30);

            const stats = await request("GET", "/test/stats");
            expect(stats.data.emailsReceived).toBe(100);
            expect(stats.data.pendingPolls).toBeGreaterThan(30);
        }, 30000);
    });

    // =========================================================================
    // Command Processing Load Tests
    // =========================================================================
    describe("Command Processing Load", () => {
        it("should handle 100 commands queued and polled", async () => {
            // Add 100 commands
            const commands = [];
            for (let i = 0; i < 100; i++) {
                commands.push({
                    action: "get_status",
                    messageId: `<cmd-${i}@test.example.com>`,
                });
            }

            await request("POST", "/test/add-commands", { commands });

            // Poll to receive them
            const resp = await request("GET", "/tbird-sync/pending");
            expect(resp.status).toBe(200);
            expect(resp.data.commands.length).toBe(100);

            // Verify queue is now empty
            const resp2 = await request("GET", "/tbird-sync/pending");
            expect(resp2.data.commands.length).toBe(0);
        });

        it("should handle rapid command completion posts", async () => {
            const start = Date.now();
            let success = 0;

            for (let i = 0; i < 100; i++) {
                try {
                    const resp = await request("POST", "/tbird-sync/complete", {
                        results: [{
                            id: `cmd-${i}`,
                            action: "get_status",
                            success: true,
                            tb_state: { read: false, flagged: false },
                        }],
                    });
                    if (resp.status === 200) success++;
                } catch {
                    // ignore
                }
            }

            const elapsed = Date.now() - start;
            console.log(`\n100 completions: ${success} ok in ${elapsed}ms`);

            expect(success).toBe(100);

            const stats = await request("GET", "/test/stats");
            expect(stats.data.commandsCompleted).toBe(100);
        }, 30000);
    });

    // =========================================================================
    // Server Responsiveness Under Load
    // =========================================================================
    describe("Server Responsiveness", () => {
        it("should respond to /pending quickly even with many emails queued", async () => {
            // First, flood with emails
            await parallelRequests(50, (i) =>
                request("POST", "/tbird-sync/new-email", {
                    message_id: `<flood-${i}@test.example.com>`,
                })
            );

            // Now measure /pending response time
            const times = [];
            for (let i = 0; i < 10; i++) {
                const start = Date.now();
                await request("GET", "/tbird-sync/pending");
                times.push(Date.now() - start);
            }

            const avg = times.reduce((a, b) => a + b, 0) / times.length;
            const max = Math.max(...times);

            console.log(`\n/pending response: avg=${avg.toFixed(1)}ms, max=${max}ms`);

            // Should respond in under 100ms
            expect(max).toBeLessThan(100);
        });

        it("should respond to /status quickly", async () => {
            const times = [];
            for (let i = 0; i < 20; i++) {
                const start = Date.now();
                await request("GET", "/tbird-sync/status");
                times.push(Date.now() - start);
            }

            const avg = times.reduce((a, b) => a + b, 0) / times.length;
            const max = Math.max(...times);

            console.log(`\n/status response: avg=${avg.toFixed(1)}ms, max=${max}ms`);

            expect(max).toBeLessThan(100);
        });

        it("should accept delay configuration", async () => {
            // Verify the set-delay endpoint works
            const setResp = await request("POST", "/test/set-delay", { delay_ms: 50 });
            expect(setResp.status).toBe(200);
            expect(setResp.data.delay_ms).toBe(50);

            // Reset immediately (delay testing is best done manually)
            const resetResp = await request("POST", "/test/set-delay", { delay_ms: 0 });
            expect(resetResp.status).toBe(200);
            expect(resetResp.data.delay_ms).toBe(0);
        });
    });

    // =========================================================================
    // Event Batch Load Tests
    // =========================================================================
    describe("Event Batch Load", () => {
        it("should handle large event batches", async () => {
            const events = [];
            for (let i = 0; i < 50; i++) {
                events.push({
                    event_id: `evt-${i}`,
                    event_type: "messages.onUpdated",
                    ts_ms: Date.now(),
                    payload: { messageId: i },
                });
            }

            const resp = await request("POST", "/tbird-sync/events", { events });
            expect(resp.status).toBe(200);
            expect(resp.data.processed).toBe(50);

            const stats = await request("GET", "/test/stats");
            expect(stats.data.eventsReceived).toBe(50);
        });

        it("should handle multiple event batch posts", async () => {
            for (let batch = 0; batch < 10; batch++) {
                const events = [];
                for (let i = 0; i < 10; i++) {
                    events.push({
                        event_id: `evt-${batch}-${i}`,
                        event_type: "test",
                        ts_ms: Date.now(),
                    });
                }
                await request("POST", "/tbird-sync/events", { events });
            }

            const stats = await request("GET", "/test/stats");
            expect(stats.data.eventsReceived).toBe(100);
        }, 15000);
    });

    // =========================================================================
    // WebSocket Load Tests (NEW)
    // =========================================================================
    describe("WebSocket Command Push", () => {
        const WebSocket = require("ws");

        async function connectWebSocket() {
            return new Promise((resolve, reject) => {
                const ws = new WebSocket(`ws://localhost:${STUB_PORT}/tbird-sync/ws`);
                ws.on("open", () => resolve(ws));
                ws.on("error", reject);
                setTimeout(() => reject(new Error("WS connection timeout")), 5000);
            });
        }

        it("should push commands via WebSocket when added", async () => {
            const ws = await connectWebSocket();
            let receivedCommand = null;

            ws.on("message", (data) => {
                const msg = JSON.parse(data.toString());
                if (msg.type === "command") {
                    receivedCommand = msg.data;
                }
            });

            // Add command via HTTP
            await request("POST", "/test/add-command", {
                action: "fetch_unread",
                params: { limit: 10 }
            });

            // Wait for WS push
            await new Promise(resolve => setTimeout(resolve, 100));

            expect(receivedCommand).not.toBeNull();
            expect(receivedCommand.action).toBe("fetch_unread");

            ws.close();
        }, 10000);

        it("should receive results via WebSocket", async () => {
            const ws = await connectWebSocket();

            // Add command first
            const cmdResp = await request("POST", "/test/add-command", {
                action: "get_status"
            });
            const cmdId = cmdResp.data.command.id;

            // Wait for command push
            await new Promise(resolve => setTimeout(resolve, 100));

            // Send result via WS
            ws.send(JSON.stringify({
                type: "result",
                data: {
                    id: cmdId,
                    action: "get_status",
                    success: true,
                    result: { status: "ok" }
                }
            }));

            // Wait for processing
            await new Promise(resolve => setTimeout(resolve, 100));

            // Verify result was received
            const stats = await request("GET", "/test/stats");
            expect(stats.data.commandsCompleted).toBeGreaterThan(0);

            ws.close();
        }, 10000);

        it("should handle 50 commands via WebSocket rapidly", async () => {
            const ws = await connectWebSocket();
            const received = [];

            ws.on("message", (data) => {
                const msg = JSON.parse(data.toString());
                if (msg.type === "command") {
                    received.push(msg.data);
                    // Auto-respond with result
                    ws.send(JSON.stringify({
                        type: "result",
                        data: {
                            id: msg.data.id,
                            action: msg.data.action,
                            success: true
                        }
                    }));
                }
            });

            // Add 50 commands rapidly
            const start = Date.now();
            for (let i = 0; i < 50; i++) {
                await request("POST", "/test/add-command", {
                    action: `test_${i}`
                });
            }

            // Wait for all to process
            await new Promise(resolve => setTimeout(resolve, 500));

            const elapsed = Date.now() - start;
            const rate = (50 / (elapsed / 1000)).toFixed(1);

            console.log(`\n50 WS commands: ${received.length} received in ${elapsed}ms (${rate}/s)`);

            expect(received.length).toBeGreaterThanOrEqual(45); // Allow some to be in-flight

            ws.close();
        }, 15000);
    });
});
