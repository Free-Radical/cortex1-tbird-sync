/**
 * Stress tests for cancel_job responsiveness during backfill scans.
 *
 * Uses a local VM loader (same reason as stress_scheduler.test.js — the
 * setup.js wrappedScript export list is missing queue/cancel symbols).
 */

const fs   = require("fs");
const path = require("path");
const vm   = require("vm");

const { createMockMessage, createMockFolder } = require("../setup");

function loadBg() {
    const scriptPath = path.join(__dirname, "..", "..", "background.js");
    const scriptContent = fs.readFileSync(scriptPath, "utf8");

    const sandbox = {
        messenger:      global.messenger,
        fetch:          global.fetch,
        console:        global.console,
        crypto:         global.crypto,
        Date:           global.Date,
        setTimeout:     global.setTimeout,
        setInterval:    global.setInterval,
        clearTimeout:   global.clearTimeout,
        clearInterval:  global.clearInterval,
        Math:           global.Math,
        JSON:           global.JSON,
        Array:          global.Array,
        Object:         global.Object,
        String:         global.String,
        Number:         global.Number,
        Boolean:        global.Boolean,
        Error:          global.Error,
        Promise:        global.Promise,
        Map:            global.Map,
        Set:            global.Set,
        AbortController: global.AbortController,
        AbortSignal:    global.AbortSignal,
        WebSocket:      { OPEN: 1, CONNECTING: 0, CLOSING: 2, CLOSED: 3 },
        CORTEX_TEST_MODE: true,
        __exports__: {},
    };

    const context = vm.createContext(sandbox);

    const wrappedScript = `
        ${scriptContent}

        Object.assign(__exports__, {
            processCommand,
            enqueueCommands,
            runWorkerLoop,
            handleBackfillRepliedForwarded,
            highCommandQueue,
            fastCommandQueue,
            slowCommandQueue,
            knownCommandIds,
            cancelledJobIds,
            pruneCancelledJobIds,
            removeQueuedCommandsForJob,
            CANCEL_TTL_MS,
            CANCEL_MAX_SIZE,
            isWebSocketOpen,
            sendWebSocketMessage,
            _setWs: function(mockWs) { ws = mockWs; },
        });
    `;

    vm.runInContext(wrappedScript, context);
    return context.__exports__;
}

// ---------------------------------------------------------------------------
describe("Stress: cancel_job scan responsiveness", () => {
    let bg;
    let sentFolder;
    const N = 5000;

    beforeEach(() => {
        // Real timers: the backfill async generator uses setTimeout(resolve, 0)
        // to yield to the event loop, which hangs under fake timers.
        jest.useRealTimers();

        bg = loadBg();

        sentFolder = createMockFolder({
            accountId: "account1",
            path: "/Sent",
            name: "Sent",
            type: "sent",
        });

        // Build N mock messages
        const sentMessages = [];
        for (let i = 0; i < N; i++) {
            sentMessages.push(createMockMessage({
                id: 10000 + i,
                headerMessageId: `stress-${i}@example.com`,
                subject: `Stress message ${i}`,
                date: new Date(),
                folder: sentFolder,
            }));
        }

        // Mock accounts → sent folder discovery
        global.messenger.accounts.list.mockResolvedValue([{
            id: "account1",
            name: "Stress Account",
            type: "imap",
            identities: [{ email: "stress@example.com" }],
            folders: [sentFolder],
        }]);

        // Mock messages.query → all N messages in one page
        global.messenger.messages.query.mockResolvedValue({
            messages: sentMessages,
            id: null,
        });

        // Mock messages.get (for addTagPreservingExisting)
        global.messenger.messages.get.mockImplementation(async (msgId) => ({
            id: msgId,
            tags: [],
        }));

        // Mock messages.update → no-op
        global.messenger.messages.update.mockResolvedValue();

        // Speed up: mock Date.now to auto-increment so the rate limiter
        // (100 ms interval) never sleeps.
        let fakeNow = Date.now();
        jest.spyOn(Date, "now").mockImplementation(() => {
            fakeNow += 200;
            return fakeNow;
        });
    });

    afterEach(() => {
        jest.restoreAllMocks();
        jest.useFakeTimers();
    });

    // -----------------------------------------------------------------------
    it("cancel at item 50 — scan stops within 5 further iterations", async () => {
        const commandId = "stress-cancel-early";
        let getFullCalls = 0;

        global.messenger.messages.getFull.mockImplementation(async () => {
            getFullCalls++;
            if (getFullCalls >= 50) {
                bg.cancelledJobIds.set(commandId, Date.now());
            }
            return { headers: { subject: ["Stress test"] } };
        });

        const result = await bg.handleBackfillRepliedForwarded({
            id: commandId,
            action: "backfill_replied_forwarded",
            days_back: 30,
            limit: N,
        });

        expect(result.success).toBe(true);
        expect(result.completed_reason).toBe("cancelled");
        expect(result.processed).toBeGreaterThanOrEqual(50);
        expect(result.processed).toBeLessThanOrEqual(55);
        expect(bg.cancelledJobIds.has(commandId)).toBe(false);
    }, 15000);

    // -----------------------------------------------------------------------
    it("cancel at item 2500 — scan stops within 5 further iterations", async () => {
        const commandId = "stress-cancel-mid";
        let getFullCalls = 0;

        global.messenger.messages.getFull.mockImplementation(async () => {
            getFullCalls++;
            if (getFullCalls >= 2500) {
                bg.cancelledJobIds.set(commandId, Date.now());
            }
            return { headers: { subject: ["Stress test"] } };
        });

        const result = await bg.handleBackfillRepliedForwarded({
            id: commandId,
            action: "backfill_replied_forwarded",
            days_back: 30,
            limit: N,
        });

        expect(result.success).toBe(true);
        expect(result.completed_reason).toBe("cancelled");
        expect(result.processed).toBeGreaterThanOrEqual(2500);
        expect(result.processed).toBeLessThanOrEqual(2505);
        expect(bg.cancelledJobIds.has(commandId)).toBe(false);
    }, 15000);

    // -----------------------------------------------------------------------
    it("cancelled scan posts final 'cancelled' status exactly once", async () => {
        const commandId = "stress-cancel-status";
        let getFullCalls = 0;

        const mockWs = { readyState: 1, send: jest.fn() };
        bg._setWs(mockWs);

        global.messenger.messages.getFull.mockImplementation(async () => {
            getFullCalls++;
            if (getFullCalls >= 100) {
                bg.cancelledJobIds.set(commandId, Date.now());
            }
            return { headers: { subject: ["Stress test"] } };
        });

        await bg.handleBackfillRepliedForwarded({
            id: commandId,
            action: "backfill_replied_forwarded",
            days_back: 30,
            limit: N,
        });

        const progressMessages = mockWs.send.mock.calls
            .map((call) => JSON.parse(call[0]))
            .filter((msg) => msg.type === "progress");

        const cancelledStatuses = progressMessages.filter(
            (msg) => msg.data && msg.data.status === "cancelled"
        );

        expect(cancelledStatuses.length).toBe(1);
        expect(cancelledStatuses[0].data.command_id).toBe(commandId);
    }, 15000);

    // -----------------------------------------------------------------------
    it("cancel removes queued commands for the cancelled job_id", async () => {
        bg.enqueueCommands([
            { id: "cancel-target", action: "backfill_replied_forwarded", priority: "slow" },
        ]);
        bg.enqueueCommands([
            { id: "keep-this", action: "list_folders" },
        ]);

        expect(bg.slowCommandQueue.length).toBe(1);
        expect(bg.fastCommandQueue.length).toBe(1);

        const result = await bg.processCommand({
            action: "cancel_job",
            job_id: "cancel-target",
        });

        expect(result.success).toBe(true);
        expect(bg.slowCommandQueue.length).toBe(0);
        expect(bg.fastCommandQueue.length).toBe(1);
        expect(bg.fastCommandQueue[0].id).toBe("keep-this");
        expect(bg.knownCommandIds.has("cancel-target")).toBe(false);
    });

    // -----------------------------------------------------------------------
    it("soak: random cancel timing across 10 seeds — invariants hold", async () => {
        function mulberry32(seed) {
            let s = seed | 0;
            return function () {
                s = (s + 0x6D2B79F5) | 0;
                let t = Math.imul(s ^ (s >>> 15), 1 | s);
                t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
                return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
            };
        }

        const SOAK_N = 200;
        const soakMessages = [];
        for (let i = 0; i < SOAK_N; i++) {
            soakMessages.push(createMockMessage({
                id: 50000 + i,
                headerMessageId: `soak-${i}@example.com`,
                subject: `Soak ${i}`,
                date: new Date(),
                folder: sentFolder,
            }));
        }

        for (let seed = 1; seed <= 10; seed++) {
            const rng = mulberry32(seed);
            const cancelAt = Math.floor(rng() * (SOAK_N - 10)) + 5;
            const commandId = `soak-seed-${seed}`;
            let getFullCalls = 0;

            global.messenger.messages.query.mockResolvedValue({
                messages: soakMessages,
                id: null,
            });

            global.messenger.messages.getFull.mockImplementation(async () => {
                getFullCalls++;
                if (getFullCalls >= cancelAt) {
                    bg.cancelledJobIds.set(commandId, Date.now());
                }
                return { headers: { subject: ["Soak"] } };
            });

            const result = await bg.handleBackfillRepliedForwarded({
                id: commandId,
                action: "backfill_replied_forwarded",
                days_back: 30,
                limit: SOAK_N,
            });

            expect(result.completed_reason).toBe("cancelled");
            expect(result.success).toBe(true);
            expect(result.processed).toBeGreaterThanOrEqual(cancelAt);
            expect(result.processed).toBeLessThanOrEqual(cancelAt + 5);
            expect(bg.cancelledJobIds.has(commandId)).toBe(false);
        }
    }, 30000);
});
