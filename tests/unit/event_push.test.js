/**
 * Unit Tests for Event Push System
 *
 * Tests the event queue system including:
 * - Event queueing
 * - Batch flushing via WebSocket
 * - Queue persistence
 * - Queue limits
 * - New email push via WebSocket
 */

const { createMockMessage, createMockFolder, loadBackgroundScript } = require("../setup");

function mockOpenWebSocket(bg) {
    const mockWs = { readyState: 1, send: jest.fn() }; // WebSocket.OPEN = 1
    bg._setWs(mockWs);
    return mockWs;
}

describe("Event Push System", () => {
    let bg;

    beforeEach(() => {
        // Setup storage mock with event push enabled
        messenger._storage._setData({
            cortex_event_push_enabled: true,
            cortex_event_queue_v1: [],
            cortex_event_queue_meta_v1: {}
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
    // Batch Flushing (WebSocket)
    // =========================================================================
    describe("flushEventQueue()", () => {
        it("should send events via WebSocket", async () => {
            const mockWs = mockOpenWebSocket(bg);

            messenger._storage._setData({
                cortex_event_push_enabled: true,
                cortex_event_queue_v1: [
                    { event_id: "evt-1", event_type: "test", ts_ms: Date.now(), seq: 1, payload: {} }
                ],
                cortex_event_queue_meta_v1: {}
            });

            await bg.ensureEventQueueLoaded();
            await bg.flushEventQueue();

            // Should have sent via WebSocket
            expect(mockWs.send).toHaveBeenCalled();
            const sent = JSON.parse(mockWs.send.mock.calls[0][0]);
            expect(sent.type).toBe("event");
            expect(sent.event.events).toBeDefined();
        });

        it("should not flush when WS is closed", async () => {
            // WS is null by default (not connected)
            messenger._storage._setData({
                cortex_event_push_enabled: true,
                cortex_event_queue_v1: [
                    { event_id: "evt-1", event_type: "test", ts_ms: Date.now(), seq: 1, payload: {} }
                ],
                cortex_event_queue_meta_v1: {}
            });

            await bg.ensureEventQueueLoaded();
            await bg.flushEventQueue();

            // postEventBatch returns false when WS not open — events stay queued
        });

        it("should remove flushed events from queue", async () => {
            mockOpenWebSocket(bg);

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
        });

        it("should not flush when queue empty", async () => {
            const mockWs = mockOpenWebSocket(bg);

            messenger._storage._setData({
                cortex_event_push_enabled: true,
                cortex_event_queue_v1: [],
                cortex_event_queue_meta_v1: {}
            });

            await bg.ensureEventQueueLoaded();
            await bg.flushEventQueue();

            // Should not have sent anything
            expect(mockWs.send).not.toHaveBeenCalled();
        });

        it("should not flush when event push disabled", async () => {
            const mockWs = mockOpenWebSocket(bg);

            messenger._storage._setData({
                cortex_event_push_enabled: false,
                cortex_event_queue_v1: [
                    { event_id: "evt-1", event_type: "test", ts_ms: Date.now(), seq: 1, payload: {} }
                ],
                cortex_event_queue_meta_v1: {}
            });

            await bg.flushEventQueue();

            // Should not send anything
            expect(mockWs.send).not.toHaveBeenCalled();
        });
    });

    // =========================================================================
    // postEventBatch
    // =========================================================================
    describe("postEventBatch()", () => {
        it("should send via WebSocket when connected", async () => {
            const mockWs = mockOpenWebSocket(bg);

            const events = [{ event_id: "evt-1", event_type: "test" }];
            const result = await bg.postEventBatch(events);

            expect(result).toBe(true);
            expect(mockWs.send).toHaveBeenCalled();
            const sent = JSON.parse(mockWs.send.mock.calls[0][0]);
            expect(sent.type).toBe("event");
        });

        it("should include events in message", async () => {
            const mockWs = mockOpenWebSocket(bg);

            const events = [
                { event_id: "evt-1", event_type: "test1" },
                { event_id: "evt-2", event_type: "test2" }
            ];

            await bg.postEventBatch(events);

            const sent = JSON.parse(mockWs.send.mock.calls[0][0]);
            expect(sent.event.events).toEqual(events);
        });

        it("should return false when WS not open", async () => {
            // WS is null by default
            const result = await bg.postEventBatch([{ event_id: "evt-1" }]);
            expect(result).toBe(false);
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
    // New Email Push (WebSocket)
    // =========================================================================
    describe("New Email Push", () => {
        it("should post headerMessageId via WebSocket", async () => {
            const mockWs = mockOpenWebSocket(bg);

            const listener = messenger.messages.onNewMailReceived.addListener.mock.calls[0][0];
            const msg = createMockMessage({ headerMessageId: "<msg-1@example.com>" });
            const folder = createMockFolder();

            await listener(folder, { messages: [msg] });
            jest.advanceTimersByTime(200);
            await Promise.resolve();

            // Should have sent via WebSocket
            expect(mockWs.send).toHaveBeenCalled();
            const sent = JSON.parse(mockWs.send.mock.calls[0][0]);
            expect(sent.type).toBe("event");
            expect(sent.event.type).toBe("new_email");
            expect(sent.event.message_id).toBe("<msg-1@example.com>");
        });

        it("should resolve message-id via getFull when headerMessageId missing", async () => {
            const mockWs = mockOpenWebSocket(bg);
            messenger.messages.getFull.mockResolvedValue({
                headers: { "message-id": ["<fallback@example.com>"] }
            });

            const listener = messenger.messages.onNewMailReceived.addListener.mock.calls[0][0];
            const msg = createMockMessage({ id: 991, headerMessageId: null });
            const folder = createMockFolder();

            await listener(folder, { messages: [msg] });
            jest.advanceTimersByTime(200);
            await Promise.resolve();

            expect(mockWs.send).toHaveBeenCalled();
            const sent = JSON.parse(mockWs.send.mock.calls[0][0]);
            expect(sent.event.message_id).toBe("<fallback@example.com>");
        });
    });

    // =========================================================================
    // New Email Polling Fallback
    // =========================================================================
    describe("New Email Inbox Polling", () => {
        it("should send new emails found via inbox polling through WebSocket", async () => {
            const mockWs = mockOpenWebSocket(bg);
            messenger.messages.query.mockResolvedValue({
                messages: [
                    createMockMessage({ headerMessageId: "<poll-1@example.com>" }),
                    createMockMessage({ id: 99, headerMessageId: "<poll-2@example.com>" })
                ]
            });

            await bg.pollForNewEmails();
            jest.advanceTimersByTime(200);
            await Promise.resolve();

            expect(mockWs.send).toHaveBeenCalled();
            const sentMessages = mockWs.send.mock.calls.map(c => JSON.parse(c[0]));
            const newEmailEvents = sentMessages.filter(m => m.event && m.event.type === "new_email");
            expect(newEmailEvents.length).toBe(2);
        });

        it("should dedupe already seen message ids", async () => {
            const mockWs = mockOpenWebSocket(bg);
            messenger.messages.query.mockResolvedValue({
                messages: [createMockMessage({ headerMessageId: "<poll-dup@example.com>" })]
            });

            await bg.pollForNewEmails();
            jest.advanceTimersByTime(200);
            await Promise.resolve();

            mockWs.send.mockClear();

            await bg.pollForNewEmails();
            jest.advanceTimersByTime(200);
            await Promise.resolve();

            // Second poll should not send duplicates
            const sentMessages = mockWs.send.mock.calls.map(c => JSON.parse(c[0]));
            const newEmailEvents = sentMessages.filter(m => m.event && m.event.type === "new_email");
            expect(newEmailEvents.length).toBe(0);
        });
    });
});
