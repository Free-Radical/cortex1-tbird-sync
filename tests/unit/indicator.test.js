/**
 * Tests for toolbar badge indicator (setIndicator)
 */

const { getMockMessenger, loadBackgroundScript } = require("../setup");

describe("setIndicator - toolbar badge", () => {
    let bg;
    let mockAction;

    beforeEach(() => {
        jest.useFakeTimers();
        bg = loadBackgroundScript();
        mockAction = getMockMessenger().action;
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    function advancePastThrottle() {
        // Advance past the 1-second throttle window
        jest.advanceTimersByTime(1100);
    }

    test("connected + idle => badge 'OK', green background", () => {
        advancePastThrottle();
        bg.setIndicator({ connected: true, queueDepth: 0 });

        expect(mockAction.setBadgeText).toHaveBeenCalledWith({ text: "OK" });
        expect(mockAction.setBadgeBackgroundColor).toHaveBeenCalledWith({ color: "#2ecc71" });
        expect(mockAction.setTitle).toHaveBeenCalledWith({ title: "Cortex: Connected | Idle" });
    });

    test("connected + busy (queueDepth > 0) => badge shows numeric depth, yellow", () => {
        advancePastThrottle();
        bg.setIndicator({ connected: true, busy: true, queueDepth: 5 });

        expect(mockAction.setBadgeText).toHaveBeenCalledWith({ text: "5" });
        expect(mockAction.setBadgeBackgroundColor).toHaveBeenCalledWith({ color: "#f1c40f" });
        expect(mockAction.setTitle).toHaveBeenCalledWith({ title: "Cortex: Connected | Queue: 5" });
    });

    test("connected + busy (queueDepth 0, busy flag) => badge ellipsis, yellow", () => {
        advancePastThrottle();
        bg.setIndicator({ connected: true, busy: true, queueDepth: 0 });

        expect(mockAction.setBadgeText).toHaveBeenCalledWith({ text: "\u2026" });
        expect(mockAction.setBadgeBackgroundColor).toHaveBeenCalledWith({ color: "#f1c40f" });
    });

    test("connected + queueDepth > 99 => badge '99+'", () => {
        advancePastThrottle();
        bg.setIndicator({ connected: true, busy: true, queueDepth: 150 });

        expect(mockAction.setBadgeText).toHaveBeenCalledWith({ text: "99+" });
    });

    test("disconnected => badge '!', red background", () => {
        advancePastThrottle();
        bg.setIndicator({ connected: false });

        expect(mockAction.setBadgeText).toHaveBeenCalledWith({ text: "!" });
        expect(mockAction.setBadgeBackgroundColor).toHaveBeenCalledWith({ color: "#e74c3c" });
        expect(mockAction.setTitle).toHaveBeenCalledWith({ title: "Cortex: Disconnected" });
    });

    test("error => badge '!', red background, tooltip shows error", () => {
        advancePastThrottle();
        bg.setIndicator({ connected: true, error: "WS timeout" });

        expect(mockAction.setBadgeText).toHaveBeenCalledWith({ text: "!" });
        expect(mockAction.setBadgeBackgroundColor).toHaveBeenCalledWith({ color: "#e74c3c" });
        expect(mockAction.setTitle).toHaveBeenCalledWith(
            expect.objectContaining({ title: expect.stringContaining("WS timeout") })
        );
    });

    test("throttles updates to at most 1/sec", () => {
        advancePastThrottle();
        // Clear any calls from script init (setIndicator at startup)
        mockAction.setBadgeText.mockClear();

        // First call goes through immediately
        bg.setIndicator({ connected: true, queueDepth: 0 });
        expect(mockAction.setBadgeText).toHaveBeenCalledTimes(1);

        // Second call within 1s is throttled
        mockAction.setBadgeText.mockClear();
        bg.setIndicator({ connected: true, queueDepth: 3 });
        expect(mockAction.setBadgeText).not.toHaveBeenCalled();

        // After 1s, the deferred update fires
        jest.advanceTimersByTime(1100);
        expect(mockAction.setBadgeText).toHaveBeenCalledWith({ text: "3" });
    });

    test("getQueueDepth sums all three lanes", () => {
        bg.highCommandQueue.length = 0;
        bg.fastCommandQueue.length = 0;
        bg.slowCommandQueue.length = 0;

        bg.fastCommandQueue.push({ id: "1", action: "test" });
        bg.slowCommandQueue.push({ id: "2", action: "backfill_replied_forwarded" });
        bg.highCommandQueue.push({ id: "3", action: "test", priority: "high" });

        expect(bg.getQueueDepth()).toBe(3);
    });
});
