const { loadBackgroundScript } = require("../setup");

function mockOpenWebSocket(bg) {
    const mockWs = { readyState: 1, send: jest.fn() }; // WebSocket.OPEN = 1
    bg._setWs(mockWs);
    return mockWs;
}

function getSentResultIds(mockWs) {
    return mockWs.send.mock.calls
        .map((call) => JSON.parse(call[0]))
        .filter((payload) => payload && payload.type === "results")
        .flatMap((payload) => Array.isArray(payload.results) ? payload.results : [])
        .map((result) => String(result.id));
}

function createDeferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

async function flushPromises(count = 10) {
    for (let i = 0; i < count; i++) {
        await Promise.resolve();
    }
}

describe("Command Scheduling Priority", () => {
    let bg;

    beforeEach(() => {
        bg = loadBackgroundScript();
    });

    it("executes high priority next when normal commands are already queued", async () => {
        const mockWs = mockOpenWebSocket(bg);

        bg.enqueueCommands([
            { id: "normal-1", action: "list_folders" },
            { id: "normal-2", action: "list_folders" }
        ]);
        bg.enqueueCommands([
            { id: "high-1", action: "list_folders", priority: "high" }
        ]);

        await bg.runWorkerLoop();

        expect(getSentResultIds(mockWs)).toEqual(["high-1", "normal-1", "normal-2"]);
    });

    it("dedupes repeated pushes of the same command id", async () => {
        const mockWs = mockOpenWebSocket(bg);

        // enqueueCommands is the WS queueing path used by handleWebSocketMessage.
        bg.enqueueCommands([{ id: "dup-1", action: "list_folders" }]);
        bg.enqueueCommands([{ id: "dup-1", action: "list_folders" }]);

        await bg.runWorkerLoop();

        expect(getSentResultIds(mockWs)).toEqual(["dup-1"]);
    });

    it("lets a later high-priority accounts.list complete while slow backfill is still running", async () => {
        const mockWs = mockOpenWebSocket(bg);
        const slowAccounts = createDeferred();

        global.messenger.accounts.list
            .mockImplementationOnce(() => slowAccounts.promise)
            .mockResolvedValue([{ id: "fast-account", name: "Fast", folders: [] }]);

        bg.enqueueCommands([
            { id: "slow-backfill", action: "backfill_replied_forwarded" }
        ]);
        await bg.runWorkerLoop();

        bg.enqueueCommands([
            { id: "high-accounts", action: "rpc", method: "accounts.list", priority: "high" }
        ]);
        await bg.runWorkerLoop();

        expect(getSentResultIds(mockWs)).toEqual(["high-accounts"]);

        slowAccounts.resolve([{ id: "slow-account", name: "Slow", folders: [] }]);
        await flushPromises();
    });

    it("flushes slow backfill completion after the slow command eventually finishes", async () => {
        const mockWs = mockOpenWebSocket(bg);
        const slowAccounts = createDeferred();

        global.messenger.accounts.list.mockImplementationOnce(() => slowAccounts.promise);

        bg.enqueueCommands([
            { id: "slow-backfill", action: "backfill_replied_forwarded" }
        ]);
        await bg.runWorkerLoop();

        expect(getSentResultIds(mockWs)).toEqual([]);

        slowAccounts.resolve([{ id: "slow-account", name: "Slow", folders: [] }]);
        await flushPromises();

        expect(getSentResultIds(mockWs)).toEqual(["slow-backfill"]);
    });
});
