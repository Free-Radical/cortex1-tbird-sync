const { loadBackgroundScript, createMockMessage, createMockFolder } = require("../setup");

function mockOpenWebSocket(bg) {
    const mockWs = { readyState: 1, send: jest.fn() };
    bg._setWs(mockWs);
    return mockWs;
}

function getSentResults(mockWs) {
    return mockWs.send.mock.calls
        .map((call) => JSON.parse(call[0]))
        .filter((payload) => payload && payload.type === "results")
        .flatMap((payload) => Array.isArray(payload.results) ? payload.results : []);
}

describe("cancel_job command", () => {
    let bg;

    beforeEach(() => {
        bg = loadBackgroundScript();
    });

    it("adds job_id to cancelledJobIds set", async () => {
        const result = await bg.processCommand({
            action: "cancel_job",
            job_id: "backfill-abc",
        });
        expect(result.success).toBe(true);
        expect(result.action).toBe("cancel_job");
        expect(result.job_id).toBe("backfill-abc");
        expect(bg.cancelledJobIds.has("backfill-abc")).toBe(true);
    });

    it("duplicate cancel does not break anything", async () => {
        await bg.processCommand({ action: "cancel_job", job_id: "dup-1" });
        const result = await bg.processCommand({ action: "cancel_job", job_id: "dup-1" });
        expect(result.success).toBe(true);
        // Map should still contain the id exactly once
        expect(bg.cancelledJobIds.has("dup-1")).toBe(true);
        expect(bg.cancelledJobIds.size).toBeGreaterThanOrEqual(1);
    });

    it("cancel_job with empty job_id returns success", async () => {
        const result = await bg.processCommand({ action: "cancel_job", job_id: "" });
        expect(result.success).toBe(true);
    });

    it("is routed via enqueue + runWorkerLoop at high priority", async () => {
        const mockWs = mockOpenWebSocket(bg);

        bg.enqueueCommands([
            { id: "slow-1", action: "list_folders", priority: "slow" },
            { id: "cancel-1", action: "cancel_job", job_id: "target-job", priority: "high" },
        ]);

        await bg.runWorkerLoop();

        const results = getSentResults(mockWs);
        const ids = results.map((r) => String(r.id));
        // High-priority cancel should execute before slow command
        expect(ids.indexOf("cancel-1")).toBeLessThan(ids.indexOf("slow-1"));
    });
});

describe("backfill scan cancellation", () => {
    let bg;

    beforeEach(() => {
        // Use real timers for backfill tests — fake timers interfere with
        // async generators and Date.now() inside the scan loop.
        jest.useRealTimers();
        bg = loadBackgroundScript();
    });

    afterEach(() => {
        jest.useFakeTimers();
    });

    /**
     * Helper: set up mock accounts + messenger so getSentFolders
     * returns a sent folder and query returns the given messages.
     */
    function setupSentFolderMock(sentFolder, sentMessages) {
        global.messenger.accounts.list.mockResolvedValue([{
            id: sentFolder.accountId || "account1",
            name: "Test",
            type: "imap",
            identities: [{ email: "test@example.com" }],
            folders: [sentFolder],
        }]);
        global.messenger.messages.query.mockResolvedValue({
            messages: sentMessages,
            id: null,
        });
    }

    it("stops scanning early when job is cancelled before loop", async () => {
        const sentFolder = createMockFolder({
            accountId: "account1",
            path: "/Sent",
            name: "Sent",
            type: "sent",
        });

        const sentMessages = [];
        for (let i = 0; i < 20; i++) {
            sentMessages.push(createMockMessage({
                id: 1000 + i,
                headerMessageId: `sent-${i}@example.com`,
                subject: `Test message ${i}`,
                date: new Date(),
                folder: sentFolder,
            }));
        }

        setupSentFolderMock(sentFolder, sentMessages);
        global.messenger.messages.getFull.mockResolvedValue({
            headers: { subject: ["Test"] },
        });

        // Pre-cancel the job before it starts scanning
        const commandId = "backfill-to-cancel";
        bg.cancelledJobIds.set(commandId, Date.now());

        const result = await bg.handleBackfillRepliedForwarded({
            id: commandId,
            action: "backfill_replied_forwarded",
            days_back: 30,
            limit: 500,
        });

        expect(result.success).toBe(true);
        expect(result.completed_reason).toBe("cancelled");
        // Cancelled before entering loop — 0 messages processed
        expect(result.processed).toBe(0);
        // cancelledJobIds should be cleaned up
        expect(bg.cancelledJobIds.has(commandId)).toBe(false);
    });

    it("stops mid-scan when cancel arrives during iteration", async () => {
        const sentFolder = createMockFolder({
            accountId: "account1",
            path: "/Sent",
            name: "Sent",
            type: "sent",
        });

        const sentMessages = [];
        for (let i = 0; i < 10; i++) {
            sentMessages.push(createMockMessage({
                id: 2000 + i,
                headerMessageId: `mid-${i}@example.com`,
                subject: `Msg ${i}`,
                date: new Date(),
                folder: sentFolder,
            }));
        }

        setupSentFolderMock(sentFolder, sentMessages);

        const commandId = "backfill-mid-cancel";
        let callCount = 0;

        // Cancel the job after getFull is called 3 times
        global.messenger.messages.getFull.mockImplementation(async () => {
            callCount++;
            if (callCount >= 3) {
                bg.cancelledJobIds.set(commandId, Date.now());
            }
            return { headers: { subject: ["Test"] } };
        });

        const result = await bg.handleBackfillRepliedForwarded({
            id: commandId,
            action: "backfill_replied_forwarded",
            days_back: 30,
            limit: 500,
        });

        expect(result.success).toBe(true);
        expect(result.completed_reason).toBe("cancelled");
        // Should have processed some but not all messages.
        // Cancel is checked AFTER processed++, so at least 3.
        expect(result.processed).toBeGreaterThanOrEqual(3);
        expect(result.processed).toBeLessThan(10);
    });
});

describe("cancelledJobIds pruning", () => {
    let bg;

    beforeEach(() => {
        jest.useRealTimers();
        bg = loadBackgroundScript();
    });

    afterEach(() => {
        jest.useFakeTimers();
    });

    it("prunes entries older than CANCEL_TTL_MS", () => {
        const now = Date.now();
        // Insert an expired entry (older than TTL)
        bg.cancelledJobIds.set("old-job", now - bg.CANCEL_TTL_MS - 1000);
        // Insert a fresh entry
        bg.cancelledJobIds.set("new-job", now);

        bg.pruneCancelledJobIds();

        expect(bg.cancelledJobIds.has("old-job")).toBe(false);
        expect(bg.cancelledJobIds.has("new-job")).toBe(true);
    });

    it("enforces CANCEL_MAX_SIZE by dropping oldest", () => {
        const now = Date.now();
        // Fill beyond the cap
        for (let i = 0; i < bg.CANCEL_MAX_SIZE + 50; i++) {
            bg.cancelledJobIds.set(`job-${i}`, now - (bg.CANCEL_MAX_SIZE + 50 - i));
        }
        expect(bg.cancelledJobIds.size).toBe(bg.CANCEL_MAX_SIZE + 50);

        bg.pruneCancelledJobIds();

        expect(bg.cancelledJobIds.size).toBe(bg.CANCEL_MAX_SIZE);
        // The newest entry should survive
        expect(bg.cancelledJobIds.has(`job-${bg.CANCEL_MAX_SIZE + 49}`)).toBe(true);
        // The oldest entries should be gone
        expect(bg.cancelledJobIds.has("job-0")).toBe(false);
    });

    it("completed scan clears cancelled job from map", async () => {
        const sentFolder = createMockFolder({
            accountId: "account1",
            path: "/Sent",
            name: "Sent",
            type: "sent",
        });

        global.messenger.accounts.list.mockResolvedValue([{
            id: "account1",
            name: "Test",
            type: "imap",
            identities: [{ email: "test@example.com" }],
            folders: [sentFolder],
        }]);
        global.messenger.messages.query.mockResolvedValue({
            messages: [createMockMessage({ id: 5000, date: new Date(), folder: sentFolder })],
            id: null,
        });
        global.messenger.messages.getFull.mockResolvedValue({
            headers: { subject: ["Test"] },
        });

        const commandId = "cleanup-test";
        bg.cancelledJobIds.set(commandId, Date.now());

        await bg.handleBackfillRepliedForwarded({
            id: commandId,
            action: "backfill_replied_forwarded",
            days_back: 30,
            limit: 500,
        });

        // After scan completes (cancelled), the entry should be cleaned up
        expect(bg.cancelledJobIds.has(commandId)).toBe(false);
    });
});

describe("cancel_job queue hygiene", () => {
    let bg;

    beforeEach(() => {
        bg = loadBackgroundScript();
    });

    it("removes queued commands with matching job_id from slow/fast queues", async () => {
        // Enqueue 3 slow backfill commands sharing the same id (job_id)
        bg.enqueueCommands([
            { id: "backfill-xyz", action: "backfill_replied_forwarded", priority: "slow" },
            { id: "backfill-xyz", action: "backfill_replied_forwarded", priority: "slow" },
            { id: "backfill-xyz", action: "backfill_replied_forwarded", priority: "slow" },
        ]);
        // dedupe means only 1 actually enqueued
        expect(bg.slowCommandQueue.length).toBe(1);
        expect(bg.knownCommandIds.has("backfill-xyz")).toBe(true);

        // Cancel the job
        const result = await bg.processCommand({
            action: "cancel_job",
            job_id: "backfill-xyz",
        });

        expect(result.success).toBe(true);
        // Queued command removed
        expect(bg.slowCommandQueue.length).toBe(0);
        // knownCommandIds cleared so future re-enqueue is possible
        expect(bg.knownCommandIds.has("backfill-xyz")).toBe(false);
        // cancelledJobIds still marked
        expect(bg.cancelledJobIds.has("backfill-xyz")).toBe(true);
    });

    it("does not remove commands for a different job_id", async () => {
        bg.enqueueCommands([
            { id: "keep-this", action: "list_folders", priority: "normal" },
            { id: "remove-this", action: "backfill_replied_forwarded", priority: "slow" },
        ]);

        expect(bg.fastCommandQueue.length).toBe(1);
        expect(bg.slowCommandQueue.length).toBe(1);

        await bg.processCommand({ action: "cancel_job", job_id: "remove-this" });

        // Only the matching command removed
        expect(bg.slowCommandQueue.length).toBe(0);
        // Unrelated command untouched
        expect(bg.fastCommandQueue.length).toBe(1);
        expect(bg.fastCommandQueue[0].id).toBe("keep-this");
    });

    it("removeQueuedCommandsForJob returns count of removed items", () => {
        // Bypass dedupe by inserting directly into queue
        bg.slowCommandQueue.push({ id: "job-A", action: "backfill_replied_forwarded" });
        bg.slowCommandQueue.push({ id: "job-A", action: "backfill_replied_forwarded" });
        bg.slowCommandQueue.push({ id: "job-B", action: "backfill_replied_forwarded" });
        bg.fastCommandQueue.push({ id: "job-A", action: "sync_state" });

        const removed = bg.removeQueuedCommandsForJob("job-A");

        expect(removed).toBe(3); // 2 slow + 1 fast
        expect(bg.slowCommandQueue.length).toBe(1);
        expect(bg.slowCommandQueue[0].id).toBe("job-B");
        expect(bg.fastCommandQueue.length).toBe(0);
    });

    it("high-priority queue is unaffected by cancel removal", async () => {
        // Put a high-priority command in the queue
        bg.enqueueCommands([
            { id: "high-cmd", action: "cancel_job", job_id: "other", priority: "high" },
            { id: "target-job", action: "backfill_replied_forwarded", priority: "slow" },
        ]);
        expect(bg.highCommandQueue.length).toBe(1);
        expect(bg.slowCommandQueue.length).toBe(1);

        // Cancel target-job — should only remove from slow, not high
        await bg.processCommand({ action: "cancel_job", job_id: "target-job" });

        expect(bg.slowCommandQueue.length).toBe(0);
        expect(bg.highCommandQueue.length).toBe(1);
        expect(bg.highCommandQueue[0].id).toBe("high-cmd");
    });

    it("dedupe still prevents duplicates after cancel + re-enqueue", async () => {
        bg.enqueueCommands([
            { id: "job-X", action: "backfill_replied_forwarded", priority: "slow" },
        ]);
        expect(bg.slowCommandQueue.length).toBe(1);

        // Cancel removes from queue AND clears knownCommandIds
        await bg.processCommand({ action: "cancel_job", job_id: "job-X" });
        expect(bg.slowCommandQueue.length).toBe(0);
        expect(bg.knownCommandIds.has("job-X")).toBe(false);

        // Re-enqueue same id — should succeed since dedupe was cleared
        const count = bg.enqueueCommands([
            { id: "job-X", action: "backfill_replied_forwarded", priority: "slow" },
        ]);
        expect(count).toBe(1);
        expect(bg.slowCommandQueue.length).toBe(1);

        // But a second push of the same id is still deduped
        const count2 = bg.enqueueCommands([
            { id: "job-X", action: "backfill_replied_forwarded", priority: "slow" },
        ]);
        expect(count2).toBe(0);
        expect(bg.slowCommandQueue.length).toBe(1);
    });

    it("removes commands matching cmd.job_id field", () => {
        // Commands with job_id field (not cmd.id) should also be removed
        bg.fastCommandQueue.push({ id: "unrelated-id", job_id: "target", action: "sync_state" });
        bg.slowCommandQueue.push({ id: "also-unrelated", job_id: "target", action: "backfill_replied_forwarded" });
        bg.slowCommandQueue.push({ id: "keep-me", job_id: "other", action: "backfill_replied_forwarded" });

        const removed = bg.removeQueuedCommandsForJob("target");

        expect(removed).toBe(2);
        expect(bg.fastCommandQueue.length).toBe(0);
        expect(bg.slowCommandQueue.length).toBe(1);
        expect(bg.slowCommandQueue[0].id).toBe("keep-me");
    });
});
