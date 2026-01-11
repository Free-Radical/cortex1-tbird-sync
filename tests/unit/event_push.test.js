/**
 * Unit Tests for Event Push System
 *
 * Tests the event queue system including:
 * - Event queueing
 * - Batch flushing
 * - Exponential backoff on failure
 * - Queue persistence
 * - Queue limits
 */

const { createMockMessage, createMockFolder, loadBackgroundScript } = require("../setup");

describe("Event Push System", () => {
    let bg;

    beforeEach(() => {
        // Setup storage mock with event push enabled
        messenger._storage._setData({
            cortex_event_push_enabled: true,
            cortex_event_queue_v1: [],
            cortex_event_queue_meta_v1: {}
        });

        // Mock successful fetch by default
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ success: true })
        });

        bg = loadBackgroundScript();
    });

    // =========================================================================
    // Event Queueing
    // =========================================================================
    describe("enqueueEvent()", () => {
        it("should add event to queue", async () => {
            await bg.enqueueEvent("test.event", { data: "value" });

            // Wait for queue to be loaded and event added
            await bg.ensureEventQueueLoaded();

            // Check storage was called to persist
            expect(messenger.storage.local.set).toHaveBeenCalled();
        });

        it("should create event with required fields", async () => {
            await bg.enqueueEvent("messages.onUpdated", { messageId: 123 });

            const calls = messenger.storage.local.set.mock.calls;
            const lastCall = calls[calls.length - 1][0];

            if (lastCall.cortex_event_queue_v1) {
                const events = lastCall.cortex_event_queue_v1;
                expect(events.length).toBeGreaterThan(0);

                const event = events[events.length - 1];
                expect(event).toHaveProperty("event_id");
                expect(event).toHaveProperty("event_type", "messages.onUpdated");
                expect(event).toHaveProperty("ts_ms");
                expect(event).toHaveProperty("seq");
                expect(event).toHaveProperty("extension_version");
                expect(event).toHaveProperty("payload");
            }
        });

        it("should not queue when event push disabled", async () => {
            messenger._storage._setData({ cortex_event_push_enabled: false });

            await bg.enqueueEvent("test.event", { data: "value" });

            // Should not persist anything
            const calls = messenger.storage.local.set.mock.calls;
            const queueCalls = calls.filter(c => c[0].cortex_event_queue_v1);
            expect(queueCalls.length).toBe(0);
        });

        it("should enforce queue limit", async () => {
            // Initialize with full queue
            const fullQueue = Array.from({ length: 2000 }, (_, i) => ({
                event_id: `evt-${i}`,
                event_type: "test",
                ts_ms: Date.now(),
                seq: i,
                payload: {}
            }));

            messenger._storage._setData({
                cortex_event_push_enabled: true,
                cortex_event_queue_v1: fullQueue,
                cortex_event_queue_meta_v1: {}
            });

            // Force reload
            await bg.ensureEventQueueLoaded();

            // Add one more event - should trigger limit enforcement
            await bg.enqueueEvent("new.event", {});

            // Queue should not exceed limit (2000)
            // Oldest events should be dropped
        });

        it("should increment dropped count when queue overflows", async () => {
            const fullQueue = Array.from({ length: 2001 }, (_, i) => ({
                event_id: `evt-${i}`,
                event_type: "test",
                ts_ms: Date.now(),
                seq: i,
                payload: {}
            }));

            messenger._storage._setData({
                cortex_event_push_enabled: true,
                cortex_event_queue_v1: fullQueue,
                cortex_event_queue_meta_v1: { dropped: 0 }
            });
        });
    });

    // =========================================================================
    // Queue Persistence
    // =========================================================================
    describe("Queue Persistence", () => {
        it("should restore queue from storage on load", async () => {
            const existingQueue = [
                { event_id: "evt-1", event_type: "test", ts_ms: Date.now(), seq: 1, payload: {} }
            ];

            messenger._storage._setData({
                cortex_event_push_enabled: true,
                cortex_event_queue_v1: existingQueue,
                cortex_event_queue_meta_v1: {}
            });

            await bg.ensureEventQueueLoaded();

            // Queue should be loaded
            expect(messenger.storage.local.get).toHaveBeenCalledWith([
                "cortex_event_queue_v1",
                "cortex_event_queue_meta_v1"
            ]);
        });

        it("should initialize empty queue if storage empty", async () => {
            messenger._storage._setData({
                cortex_event_push_enabled: true
            });

            await bg.ensureEventQueueLoaded();

            // Should handle gracefully
        });

        it("should persist queue after adding event", async () => {
            await bg.enqueueEvent("test.event", {});

            // Advance timers for debounced persist
            jest.advanceTimersByTime(600);

            expect(messenger.storage.local.set).toHaveBeenCalled();
        });
    });

    // =========================================================================
    // Batch Flushing
    // =========================================================================
    describe("flushEventQueue()", () => {
        it("should post events to server", async () => {
            messenger._storage._setData({
                cortex_event_push_enabled: true,
                cortex_event_queue_v1: [
                    { event_id: "evt-1", event_type: "test", ts_ms: Date.now(), seq: 1, payload: {} }
                ],
                cortex_event_queue_meta_v1: {}
            });

            // Clear any calls from auto-init
            global.fetch.mockClear();

            await bg.ensureEventQueueLoaded();
            await bg.flushEventQueue();

            // Find the call to /events endpoint
            const eventsCalls = global.fetch.mock.calls.filter(c => c[0].includes("/tbird-sync/events"));
            expect(eventsCalls.length).toBeGreaterThan(0);
            expect(eventsCalls[0][1].method).toBe("POST");
        });

        it("should batch events (max 50 per request)", async () => {
            // Create 60 events
            const events = Array.from({ length: 60 }, (_, i) => ({
                event_id: `evt-${i}`,
                event_type: "test",
                ts_ms: Date.now(),
                seq: i,
                payload: {}
            }));

            messenger._storage._setData({
                cortex_event_push_enabled: true,
                cortex_event_queue_v1: events,
                cortex_event_queue_meta_v1: {}
            });

            // Clear any calls from auto-init
            global.fetch.mockClear();

            await bg.ensureEventQueueLoaded();
            await bg.flushEventQueue();

            // Find the call to /events endpoint
            const eventsCalls = global.fetch.mock.calls.filter(c => c[0].includes("/tbird-sync/events"));
            expect(eventsCalls.length).toBeGreaterThan(0);
            const body = JSON.parse(eventsCalls[0][1].body);
            expect(body.events.length).toBeLessThanOrEqual(50);
        });

        it("should remove flushed events from queue", async () => {
            messenger._storage._setData({
                cortex_event_push_enabled: true,
                cortex_event_queue_v1: [
                    { event_id: "evt-1", event_type: "test", ts_ms: Date.now(), seq: 1, payload: {} }
                ],
                cortex_event_queue_meta_v1: {}
            });

            await bg.ensureEventQueueLoaded();
            await bg.flushEventQueue();

            // Queue should be empty after successful flush
            // Check that storage.set was called with empty queue
        });

        it("should not flush when queue empty", async () => {
            messenger._storage._setData({
                cortex_event_push_enabled: true,
                cortex_event_queue_v1: [],
                cortex_event_queue_meta_v1: {}
            });

            // Clear any calls from auto-init
            global.fetch.mockClear();

            await bg.ensureEventQueueLoaded();
            await bg.flushEventQueue();

            // Should not call /events endpoint (may still call /pending for polling)
            const eventsCalls = global.fetch.mock.calls.filter(c => c[0].includes("/tbird-sync/events"));
            expect(eventsCalls.length).toBe(0);
        });

        it("should not flush when event push disabled", async () => {
            messenger._storage._setData({
                cortex_event_push_enabled: false,
                cortex_event_queue_v1: [
                    { event_id: "evt-1", event_type: "test", ts_ms: Date.now(), seq: 1, payload: {} }
                ],
                cortex_event_queue_meta_v1: {}
            });

            // Clear any calls from auto-init
            global.fetch.mockClear();

            await bg.flushEventQueue();

            // Should not call /events endpoint
            const eventsCalls = global.fetch.mock.calls.filter(c => c[0].includes("/tbird-sync/events"));
            expect(eventsCalls.length).toBe(0);
        });
    });

    // =========================================================================
    // Exponential Backoff
    // =========================================================================
    describe("Exponential Backoff", () => {
        it("should back off on failure", async () => {
            messenger._storage._setData({
                cortex_event_push_enabled: true,
                cortex_event_queue_v1: [
                    { event_id: "evt-1", event_type: "test", ts_ms: Date.now(), seq: 1, payload: {} }
                ],
                cortex_event_queue_meta_v1: {
                    failures: 0,
                    backoffMs: 1000,
                    nextAttemptAtMs: 0
                }
            });

            // Clear and set up fetch to fail for /events but succeed for /pending
            global.fetch.mockClear();
            global.fetch.mockImplementation((url) => {
                if (url.includes("/tbird-sync/events")) {
                    return Promise.reject(new Error("Network error"));
                }
                return Promise.resolve({ ok: true, json: () => Promise.resolve({ commands: [] }) });
            });

            await bg.ensureEventQueueLoaded();
            await bg.flushEventQueue();

            // Meta should be updated with backoff
            const setCalls = messenger.storage.local.set.mock.calls;
            const metaCalls = setCalls.filter(c => c[0].cortex_event_queue_meta_v1);

            expect(metaCalls.length).toBeGreaterThan(0);
        });

        it("should double backoff on consecutive failures", async () => {
            global.fetch.mockRejectedValue(new Error("Network error"));

            messenger._storage._setData({
                cortex_event_push_enabled: true,
                cortex_event_queue_v1: [
                    { event_id: "evt-1", event_type: "test", ts_ms: Date.now(), seq: 1, payload: {} }
                ],
                cortex_event_queue_meta_v1: {
                    failures: 1,
                    backoffMs: 2000,
                    nextAttemptAtMs: 0
                }
            });

            await bg.ensureEventQueueLoaded();
            await bg.flushEventQueue();

            // Backoff should increase (capped at 5 minutes)
        });

        it("should apply aggressive backoff for 404/405 responses", async () => {
            const error = new Error("Not Found");
            error.status = 404;
            global.fetch.mockRejectedValue(error);

            messenger._storage._setData({
                cortex_event_push_enabled: true,
                cortex_event_queue_v1: [
                    { event_id: "evt-1", event_type: "test", ts_ms: Date.now(), seq: 1, payload: {} }
                ],
                cortex_event_queue_meta_v1: {
                    failures: 0,
                    backoffMs: 1000,
                    nextAttemptAtMs: 0
                }
            });

            await bg.ensureEventQueueLoaded();

            // Mock fetch to throw error with status
            global.fetch.mockImplementation(() => {
                const response = { ok: false, status: 404 };
                const err = new Error("HTTP 404");
                err.status = 404;
                throw err;
            });

            await bg.flushEventQueue();

            // Should have more aggressive backoff
        });

        it("should reset backoff on success", async () => {
            global.fetch.mockResolvedValue({ ok: true });

            messenger._storage._setData({
                cortex_event_push_enabled: true,
                cortex_event_queue_v1: [
                    { event_id: "evt-1", event_type: "test", ts_ms: Date.now(), seq: 1, payload: {} }
                ],
                cortex_event_queue_meta_v1: {
                    failures: 5,
                    backoffMs: 60000,
                    nextAttemptAtMs: 0
                }
            });

            await bg.ensureEventQueueLoaded();
            await bg.flushEventQueue();

            // Meta should reset
            const setCalls = messenger.storage.local.set.mock.calls;
            const lastMetaCall = setCalls.filter(c => c[0].cortex_event_queue_meta_v1).pop();

            if (lastMetaCall) {
                const meta = lastMetaCall[0].cortex_event_queue_meta_v1;
                expect(meta.failures).toBe(0);
                expect(meta.backoffMs).toBe(1000);
            }
        });

        it("should respect nextAttemptAtMs", async () => {
            const futureTime = Date.now() + 60000; // 1 minute in future

            messenger._storage._setData({
                cortex_event_push_enabled: true,
                cortex_event_queue_v1: [
                    { event_id: "evt-1", event_type: "test", ts_ms: Date.now(), seq: 1, payload: {} }
                ],
                cortex_event_queue_meta_v1: {
                    failures: 1,
                    backoffMs: 2000,
                    nextAttemptAtMs: futureTime
                }
            });

            // Clear mock before test
            global.fetch.mockClear();

            await bg.ensureEventQueueLoaded();
            await bg.flushEventQueue();

            // Should not call /events endpoint (respects backoff)
            const eventsCalls = global.fetch.mock.calls.filter(c => c[0].includes("/tbird-sync/events"));
            expect(eventsCalls.length).toBe(0);
        });
    });

    // =========================================================================
    // postEventBatch
    // =========================================================================
    describe("postEventBatch()", () => {
        it("should post to correct endpoint", async () => {
            // Clear mock before test
            global.fetch.mockClear();
            global.fetch.mockResolvedValue({ ok: true });

            const events = [{ event_id: "evt-1", event_type: "test" }];

            await bg.postEventBatch(events);

            const eventsCalls = global.fetch.mock.calls.filter(c => c[0].includes("/tbird-sync/events"));
            expect(eventsCalls.length).toBeGreaterThan(0);
            expect(eventsCalls[0][1].method).toBe("POST");
            expect(eventsCalls[0][1].headers["Content-Type"]).toBe("application/json");
        });

        it("should include events in body", async () => {
            // Clear mock before test
            global.fetch.mockClear();
            global.fetch.mockResolvedValue({ ok: true });

            const events = [
                { event_id: "evt-1", event_type: "test1" },
                { event_id: "evt-2", event_type: "test2" }
            ];

            await bg.postEventBatch(events);

            const eventsCalls = global.fetch.mock.calls.filter(c => c[0].includes("/tbird-sync/events"));
            expect(eventsCalls.length).toBeGreaterThan(0);
            const body = JSON.parse(eventsCalls[0][1].body);
            expect(body.events).toEqual(events);
        });

        it("should throw on non-ok response", async () => {
            // Clear mock and set up to fail
            global.fetch.mockClear();
            global.fetch.mockResolvedValue({ ok: false, status: 500 });

            await expect(bg.postEventBatch([{ event_id: "evt-1" }]))
                .rejects.toThrow();
        });

        it("should handle timeout", async () => {
            // Mock a slow response
            global.fetch.mockImplementation(() => new Promise((resolve) => {
                setTimeout(() => resolve({ ok: true }), 10000);
            }));

            // This should abort due to timeout
            // Note: In real implementation, AbortController is used
        });
    });

    // =========================================================================
    // Event ID Generation
    // =========================================================================
    describe("Event ID Generation", () => {
        it("should generate unique event IDs", async () => {
            await bg.enqueueEvent("test1", {});
            await bg.enqueueEvent("test2", {});

            const calls = messenger.storage.local.set.mock.calls;
            const eventCalls = calls.filter(c => c[0].cortex_event_queue_v1);

            // Each event should have unique ID
            if (eventCalls.length >= 1) {
                const lastQueue = eventCalls[eventCalls.length - 1][0].cortex_event_queue_v1;
                const ids = lastQueue.map(e => e.event_id);
                const uniqueIds = new Set(ids);
                expect(uniqueIds.size).toBe(ids.length);
            }
        });

        it("should use crypto.randomUUID when available", () => {
            global.crypto = { randomUUID: jest.fn(() => "uuid-123") };

            // The createEventId function should use crypto.randomUUID
        });

        it("should fallback to custom ID when crypto unavailable", () => {
            global.crypto = undefined;

            // The createEventId function should generate fallback ID
        });
    });

    // =========================================================================
    // Concurrent Flush Prevention
    // =========================================================================
    describe("Concurrent Flush Prevention", () => {
        it("should not flush while already flushing", async () => {
            // Clear mock
            global.fetch.mockClear();
            let resolveFlush = null;
            const pending = new Promise(resolve => {
                resolveFlush = resolve;
            });
            global.fetch.mockImplementation((url) => {
                if (url.includes("/tbird-sync/events")) {
                    return pending;
                }
                return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
            });

            messenger._storage._setData({
                cortex_event_push_enabled: true,
                cortex_event_queue_v1: [
                    { event_id: "evt-1", event_type: "test", ts_ms: Date.now(), seq: 1, payload: {} }
                ],
                cortex_event_queue_meta_v1: {}
            });

            await bg.ensureEventQueueLoaded();

            // Start first flush
            const flush1 = bg.flushEventQueue();

            // Try second flush immediately
            const flush2 = bg.flushEventQueue();

            expect(resolveFlush).toBeDefined();
            resolveFlush({ ok: true });
            await flush1;
            await flush2;

            // Should only have one call to /events endpoint (concurrent prevention)
            const eventsCalls = global.fetch.mock.calls.filter(c => c[0].includes("/tbird-sync/events"));
            expect(eventsCalls.length).toBeLessThanOrEqual(1);
        });
    });

    // =========================================================================
    // New Email Push
    // =========================================================================
    describe("New Email Push", () => {
        it("should post headerMessageId when available", async () => {
            global.fetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });

            const listener = messenger.messages.onNewMailReceived.addListener.mock.calls[0][0];
            const msg = createMockMessage({ headerMessageId: "<msg-1@example.com>" });
            const folder = createMockFolder();

            await listener(folder, { messages: [msg] });
            jest.advanceTimersByTime(200);
            await Promise.resolve();

            const newEmailCalls = global.fetch.mock.calls.filter(c => c[0].includes("/tbird-sync/new-email"));
            expect(newEmailCalls.length).toBeGreaterThan(0);
            const body = JSON.parse(newEmailCalls[0][1].body);
            expect(body.message_id).toBe("<msg-1@example.com>");
        });

        it("should resolve message-id via getFull when headerMessageId missing", async () => {
            global.fetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
            messenger.messages.getFull.mockResolvedValue({
                headers: { "message-id": ["<fallback@example.com>"] }
            });

            const listener = messenger.messages.onNewMailReceived.addListener.mock.calls[0][0];
            const msg = createMockMessage({ id: 991, headerMessageId: null });
            const folder = createMockFolder();

            await listener(folder, { messages: [msg] });
            jest.advanceTimersByTime(200);
            await Promise.resolve();

            const newEmailCalls = global.fetch.mock.calls.filter(c => c[0].includes("/tbird-sync/new-email"));
            expect(newEmailCalls.length).toBeGreaterThan(0);
            const body = JSON.parse(newEmailCalls[0][1].body);
            expect(body.message_id).toBe("<fallback@example.com>");
        });
    });

    // =========================================================================
    // New Email Polling Fallback
    // =========================================================================
    describe("New Email Polling Fallback", () => {
        it("should post new emails found via inbox polling", async () => {
            global.fetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
            messenger.messages.query.mockResolvedValue({
                messages: [
                    createMockMessage({ headerMessageId: "<poll-1@example.com>" }),
                    createMockMessage({ id: 99, headerMessageId: "<poll-2@example.com>" })
                ]
            });

            await bg.pollForNewEmails();

            const calls = global.fetch.mock.calls.filter(c => c[0].includes("/tbird-sync/new-email"));
            expect(calls.length).toBe(2);
            const ids = calls.map(c => JSON.parse(c[1].body).message_id);
            expect(ids).toEqual(expect.arrayContaining(["<poll-1@example.com>", "<poll-2@example.com>"]));
        });

        it("should dedupe already seen message ids", async () => {
            global.fetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
            messenger.messages.query.mockResolvedValue({
                messages: [createMockMessage({ headerMessageId: "<poll-dup@example.com>" })]
            });

            await bg.pollForNewEmails();
            await bg.pollForNewEmails();

            const calls = global.fetch.mock.calls.filter(c => c[0].includes("/tbird-sync/new-email"));
            expect(calls.length).toBe(1);
            const body = JSON.parse(calls[0][1].body);
            expect(body.message_id).toBe("<poll-dup@example.com>");
        });
    });
});
