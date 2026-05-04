const { loadBackgroundScript } = require("../setup");

describe("loopback server URL normalization", () => {
    it("defaults to IPv4 loopback for cortex server", () => {
        const bg = loadBackgroundScript();
        expect(bg.DEFAULT_CORTEX_SERVER).toBe("http://127.0.0.1:5001");
    });

    it("normalizes stored localhost server URLs to IPv4 loopback", async () => {
        const bg = loadBackgroundScript();
        messenger.storage.local.get.mockResolvedValue({
            cortex_server_url: "http://localhost:5001"
        });

        await expect(bg.getCortexServerUrl()).resolves.toBe("http://127.0.0.1:5001");
        await expect(bg.getWebSocketUrl()).resolves.toBe("ws://127.0.0.1:5001/tbird-sync/ws");
    });

    it("preserves non-localhost server URLs", async () => {
        const bg = loadBackgroundScript();
        messenger.storage.local.get.mockResolvedValue({
            cortex_server_url: "https://mail.example.com:7443"
        });

        await expect(bg.getCortexServerUrl()).resolves.toBe("https://mail.example.com:7443");
        await expect(bg.getWebSocketUrl()).resolves.toBe("wss://mail.example.com:7443/tbird-sync/ws");
    });
});
