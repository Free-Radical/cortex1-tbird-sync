const { loadBackgroundScript } = require("../setup");

async function flushPromises(count = 3) {
    for (let i = 0; i < count; i++) {
        await Promise.resolve();
    }
}

function sentPayloads(ws) {
    return ws.send.mock.calls.map((call) => JSON.parse(call[0]));
}

describe("WebSocket transport lifecycle", () => {
    let OriginalWebSocket;

    class MockWebSocket {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;
        static instances = [];

        constructor(url) {
            this.url = url;
            this.readyState = MockWebSocket.CONNECTING;
            this.send = jest.fn();
            MockWebSocket.instances.push(this);
        }
    }

    beforeEach(() => {
        OriginalWebSocket = global.WebSocket;
        MockWebSocket.instances = [];
        global.WebSocket = MockWebSocket;
    });

    afterEach(() => {
        global.WebSocket = OriginalWebSocket;
    });

    test("connectWebSocket preserves LAN-hosted server URLs", async () => {
        messenger.storage.local.get.mockResolvedValue({
            cortex_server_url: "http://192.168.1.44:5001",
        });
        const bg = loadBackgroundScript();

        await bg.connectWebSocket();

        expect(MockWebSocket.instances).toHaveLength(1);
        expect(MockWebSocket.instances[0].url).toBe("ws://192.168.1.44:5001/tbird-sync/ws");
    });

    test("connectWebSocket preserves remote TLS hosts as WSS", async () => {
        messenger.storage.local.get.mockResolvedValue({
            cortex_server_url: "https://mail.example.com:7443",
        });
        const bg = loadBackgroundScript();

        await bg.connectWebSocket();

        expect(MockWebSocket.instances).toHaveLength(1);
        expect(MockWebSocket.instances[0].url).toBe("wss://mail.example.com:7443/tbird-sync/ws");
    });

    test("open socket reports connected and sends JSON frames", async () => {
        const bg = loadBackgroundScript();

        await bg.connectWebSocket();
        const ws = MockWebSocket.instances[0];
        ws.readyState = MockWebSocket.OPEN;
        ws.onopen();

        expect(bg._getConnectionState()).toBe("CONNECTED");
        expect(bg.isWebSocketOpen()).toBe(true);
        expect(bg.sendWebSocketMessage({ type: "ping" })).toBe(true);
        expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: "ping" }));
    });

    test("extension client id is stable and persisted", async () => {
        global.crypto.randomUUID.mockReturnValueOnce("stable-client");
        const bg = loadBackgroundScript();

        const first = await bg.getExtensionClientId();
        const second = await bg.getExtensionClientId();

        expect(first).toBe("tbird-sync-stable-client");
        expect(second).toBe(first);
        expect(messenger.storage.local.set).toHaveBeenCalledWith({
            cortex_tbird_sync_client_id_v1: first,
        });
    });

    test("open socket announces extension client identity", async () => {
        messenger._storage._setData({
            cortex_tbird_sync_client_id_v1: "client-existing",
        });
        const bg = loadBackgroundScript();

        await bg.connectWebSocket();
        const ws = MockWebSocket.instances[0];
        ws.readyState = MockWebSocket.OPEN;
        ws.onopen();
        await flushPromises();

        expect(sentPayloads(ws)).toContainEqual({
            type: "hello",
            client_id: "client-existing",
            clientId: "client-existing",
            extension_version: "1.6.7",
        });
    });

    test("completion batches include extension client identity", async () => {
        messenger._storage._setData({
            cortex_tbird_sync_client_id_v1: "client-results",
        });
        const bg = loadBackgroundScript();
        const ws = {
            readyState: MockWebSocket.OPEN,
            send: jest.fn(),
        };
        bg._setWs(ws);

        bg.enqueueCommands([{ id: "cmd-list-folders", action: "list_folders" }]);
        await bg.runWorkerLoop();
        await flushPromises();

        const resultsPayload = sentPayloads(ws).find((payload) => payload.type === "results");
        expect(resultsPayload).toMatchObject({
            type: "results",
            client_id: "client-results",
            clientId: "client-results",
        });
        expect(resultsPayload.results).toHaveLength(1);
        expect(resultsPayload.results[0]).toMatchObject({
            id: "cmd-list-folders",
            client_id: "client-results",
            clientId: "client-results",
        });
        expect(resultsPayload.data[0]).toMatchObject({
            client_id: "client-results",
            clientId: "client-results",
        });
    });

    test("closed socket schedules bounded reconnect and creates a new socket", async () => {
        const bg = loadBackgroundScript();

        await bg.connectWebSocket();
        const ws = MockWebSocket.instances[0];
        ws.readyState = MockWebSocket.CLOSED;
        ws.onclose();

        expect(bg._getConnectionState()).toBe("RECONNECTING");
        expect(bg._getReconnectAttempts()).toBe(1);

        await jest.advanceTimersByTimeAsync(1000);

        expect(MockWebSocket.instances).toHaveLength(2);
    });

    test("half-dead sockets are not treated as sendable", () => {
        const bg = loadBackgroundScript();
        const ws = {
            readyState: MockWebSocket.CLOSED,
            send: jest.fn(),
        };

        bg._setWs(ws);

        expect(bg.isWebSocketOpen()).toBe(false);
        expect(bg.sendWebSocketMessage({ type: "result", data: { id: "cmd-1" } })).toBe(false);
        expect(ws.send).not.toHaveBeenCalled();
    });
});
