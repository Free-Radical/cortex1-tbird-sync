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
});
