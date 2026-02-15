/**
 * Unit Tests for RPC Method Execution
 *
 * Tests all cortex.* RPC methods and the generic RPC executor.
 */

const { createMockMessage, createMockFolder, createMockAccount, loadBackgroundScript } = require("../setup");

describe("RPC Method Execution", () => {
    let bg;
    let mockMsg;

    beforeEach(() => {
        mockMsg = createMockMessage();
        messenger.messages.query.mockResolvedValue({ messages: [mockMsg] });
        messenger.messages.get.mockResolvedValue(mockMsg);
        messenger.accounts.list.mockResolvedValue([createMockAccount()]);
        messenger.folders.query.mockResolvedValue([createMockFolder()]);

        bg = loadBackgroundScript();
    });

    // =========================================================================
    // isAllowedRpcMethodPath
    // =========================================================================
    describe("isAllowedRpcMethodPath()", () => {
        it("should allow cortex.* methods", () => {
            expect(bg.isAllowedRpcMethodPath("cortex.findMessageByHeaderId")).toBe(true);
            expect(bg.isAllowedRpcMethodPath("cortex.resolveMessageIds")).toBe(true);
            expect(bg.isAllowedRpcMethodPath("cortex.messages.updateByHeaderId")).toBe(true);
        });

        it("should allow messages.* methods", () => {
            expect(bg.isAllowedRpcMethodPath("messages.get")).toBe(true);
            expect(bg.isAllowedRpcMethodPath("messages.update")).toBe(true);
            expect(bg.isAllowedRpcMethodPath("messages.archive")).toBe(true);
        });

        it("should allow folders.* methods", () => {
            expect(bg.isAllowedRpcMethodPath("folders.get")).toBe(true);
            expect(bg.isAllowedRpcMethodPath("folders.query")).toBe(true);
        });

        it("should allow accounts.* methods", () => {
            expect(bg.isAllowedRpcMethodPath("accounts.list")).toBe(true);
            expect(bg.isAllowedRpcMethodPath("accounts.get")).toBe(true);
        });

        it("should allow compose.* methods", () => {
            expect(bg.isAllowedRpcMethodPath("compose.beginReply")).toBe(true);
            expect(bg.isAllowedRpcMethodPath("compose.sendMessage")).toBe(true);
        });

        it("should allow identities.* methods", () => {
            expect(bg.isAllowedRpcMethodPath("identities.list")).toBe(true);
            expect(bg.isAllowedRpcMethodPath("identities.get")).toBe(true);
        });

        it("should allow addressBooks.* methods", () => {
            expect(bg.isAllowedRpcMethodPath("addressBooks.list")).toBe(true);
        });

        it("should reject disallowed prefixes", () => {
            expect(bg.isAllowedRpcMethodPath("runtime.getManifest")).toBe(false);
            expect(bg.isAllowedRpcMethodPath("storage.local.get")).toBe(false);
            expect(bg.isAllowedRpcMethodPath("tabs.query")).toBe(false);
        });

        it("should reject event listener methods", () => {
            expect(bg.isAllowedRpcMethodPath("messages.onUpdated.addListener")).toBe(false);
            expect(bg.isAllowedRpcMethodPath("messages.onMoved.removeListener")).toBe(false);
            expect(bg.isAllowedRpcMethodPath("folders.onCreated.hasListener")).toBe(false);
        });

        it("should reject methods starting with on", () => {
            expect(bg.isAllowedRpcMethodPath("messages.onNewMailReceived")).toBe(false);
            expect(bg.isAllowedRpcMethodPath("folders.onFolderInfoChanged")).toBe(false);
        });

        it("should reject empty or invalid paths", () => {
            expect(bg.isAllowedRpcMethodPath("")).toBe(false);
            expect(bg.isAllowedRpcMethodPath(null)).toBe(false);
            expect(bg.isAllowedRpcMethodPath(undefined)).toBe(false);
            expect(bg.isAllowedRpcMethodPath("   ")).toBe(false);
        });
    });

    // =========================================================================
    // cortex.findMessageByHeaderId
    // =========================================================================
    describe("cortex.findMessageByHeaderId", () => {
        it("should find message and return minified header", async () => {
            const result = await bg.executeRpcCommand({
                method: "cortex.findMessageByHeaderId",
                args: ["test-msg-id@example.com"]
            });

            expect(result.success).toBe(true);
            expect(result.result).not.toBeNull();
            expect(result.result.headerMessageId).toBe("test-msg-id@example.com");
        });

        it("should return null when message not found", async () => {
            messenger.messages.query.mockResolvedValue({ messages: [] });

            const result = await bg.executeRpcCommand({
                method: "cortex.findMessageByHeaderId",
                args: ["nonexistent@example.com"]
            });

            expect(result.success).toBe(true);
            expect(result.result).toBeNull();
        });
    });

    // =========================================================================
    // cortex.resolveMessageIds
    // =========================================================================
    describe("cortex.resolveMessageIds", () => {
        it("should resolve multiple message IDs", async () => {
            const msg2 = createMockMessage({ id: 12346, headerMessageId: "msg2@example.com" });
            messenger.messages.query
                .mockResolvedValueOnce({ messages: [mockMsg] })
                .mockResolvedValueOnce({ messages: [msg2] });

            const result = await bg.executeRpcCommand({
                method: "cortex.resolveMessageIds",
                args: [["test-msg-id@example.com", "msg2@example.com"]]
            });

            expect(result.success).toBe(true);
            expect(result.result.resolved.length).toBe(2);
            expect(result.result.failed.length).toBe(0);
        });

        it("should track failed resolutions", async () => {
            messenger.messages.query
                .mockResolvedValueOnce({ messages: [mockMsg] })
                .mockResolvedValueOnce({ messages: [] });

            const result = await bg.executeRpcCommand({
                method: "cortex.resolveMessageIds",
                args: [["test-msg-id@example.com", "nonexistent@example.com"]]
            });

            expect(result.result.resolved.length).toBe(1);
            expect(result.result.failed.length).toBe(1);
            expect(result.result.failed[0].headerMessageId).toBe("nonexistent@example.com");
        });
    });

    // =========================================================================
    // cortex.messages.updateByHeaderId
    // =========================================================================
    describe("cortex.messages.updateByHeaderId", () => {
        it("should update message properties", async () => {
            const result = await bg.executeRpcCommand({
                method: "cortex.messages.updateByHeaderId",
                args: ["test-msg-id@example.com", { read: true, flagged: true }]
            });

            expect(result.success).toBe(true);
            expect(result.result.updated).toBe(true);
            expect(messenger.messages.update).toHaveBeenCalledWith(mockMsg.id, { read: true, flagged: true });
        });

        it("should throw when message not found", async () => {
            messenger.messages.query.mockResolvedValue({ messages: [] });

            const result = await bg.executeRpcCommand({
                method: "cortex.messages.updateByHeaderId",
                args: ["nonexistent@example.com", { read: true }]
            });

            expect(result.success).toBe(false);
            expect(result.error).toBe("Message not found");
        });
    });

    // =========================================================================
    // cortex.messages.archiveByHeaderId
    // =========================================================================
    describe("cortex.messages.archiveByHeaderId", () => {
        it("should archive messages by header ID", async () => {
            const result = await bg.executeRpcCommand({
                method: "cortex.messages.archiveByHeaderId",
                args: [["test-msg-id@example.com"]]
            });

            expect(result.success).toBe(true);
            expect(result.result.archived.length).toBe(1);
            expect(messenger.messages.archive).toHaveBeenCalledWith([mockMsg.id]);
        });

        it("should track failed archives", async () => {
            messenger.messages.query
                .mockResolvedValueOnce({ messages: [mockMsg] })
                .mockResolvedValueOnce({ messages: [] });

            const result = await bg.executeRpcCommand({
                method: "cortex.messages.archiveByHeaderId",
                args: [["test-msg-id@example.com", "nonexistent@example.com"]]
            });

            expect(result.result.archived.length).toBe(1);
            expect(result.result.failed.length).toBe(1);
        });
    });

    // =========================================================================
    // cortex.messages.deleteByHeaderId
    // =========================================================================
    describe("cortex.messages.deleteByHeaderId", () => {
        it("should delete messages", async () => {
            const result = await bg.executeRpcCommand({
                method: "cortex.messages.deleteByHeaderId",
                args: [["test-msg-id@example.com"]]
            });

            expect(result.success).toBe(true);
            expect(result.result.deleted.length).toBe(1);
            // skipTrash defaults to false when not specified
            expect(messenger.messages.delete).toHaveBeenCalledWith([mockMsg.id], false);
        });

        it("should support skipTrash option", async () => {
            const result = await bg.executeRpcCommand({
                method: "cortex.messages.deleteByHeaderId",
                args: [["test-msg-id@example.com"], true]
            });

            expect(result.success).toBe(true);
            expect(result.result.skipTrash).toBe(true);
            expect(messenger.messages.delete).toHaveBeenCalledWith([mockMsg.id], true);
        });
    });

    // =========================================================================
    // cortex.messages.moveByHeaderId
    // =========================================================================
    describe("cortex.messages.moveByHeaderId", () => {
        it("should move messages to folder", async () => {
            const targetFolder = createMockFolder({ path: "/Archive" });
            messenger.folders.query.mockResolvedValue([targetFolder]);

            const result = await bg.executeRpcCommand({
                method: "cortex.messages.moveByHeaderId",
                args: [["test-msg-id@example.com"], "/Archive"]
            });

            expect(result.success).toBe(true);
            expect(result.result.moved.length).toBe(1);
            expect(result.result.folder).toBeDefined();
        });

        it("should throw when folder not found", async () => {
            messenger.folders.query.mockResolvedValue([]);

            const result = await bg.executeRpcCommand({
                method: "cortex.messages.moveByHeaderId",
                args: [["test-msg-id@example.com"], "/NonexistentFolder"]
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain("Folder not found");
        });

        it("should throw when folderPath missing", async () => {
            const result = await bg.executeRpcCommand({
                method: "cortex.messages.moveByHeaderId",
                args: [["test-msg-id@example.com"]]
            });

            expect(result.success).toBe(false);
            expect(result.error).toBe("Missing folderPath");
        });
    });

    // =========================================================================
    // cortex.messages.copyByHeaderId
    // =========================================================================
    describe("cortex.messages.copyByHeaderId", () => {
        it("should copy messages to folder", async () => {
            const targetFolder = createMockFolder({ path: "/Backup" });
            messenger.folders.query.mockResolvedValue([targetFolder]);

            const result = await bg.executeRpcCommand({
                method: "cortex.messages.copyByHeaderId",
                args: [["test-msg-id@example.com"], "/Backup"]
            });

            expect(result.success).toBe(true);
            expect(result.result.copied.length).toBe(1);
            expect(messenger.messages.copy).toHaveBeenCalled();
        });

        it("should throw when folder not found", async () => {
            messenger.folders.query.mockResolvedValue([]);

            const result = await bg.executeRpcCommand({
                method: "cortex.messages.copyByHeaderId",
                args: [["test-msg-id@example.com"], "/NonexistentFolder"]
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain("Folder not found");
        });
    });

    // =========================================================================
    // cortex.messages.getFullByHeaderId
    // =========================================================================
    describe("cortex.messages.getFullByHeaderId", () => {
        it("should return full message content", async () => {
            const fullMsg = {
                contentType: "text/plain",
                headers: { "content-type": ["text/plain"] },
                parts: []
            };
            messenger.messages.getFull.mockResolvedValue(fullMsg);

            const result = await bg.executeRpcCommand({
                method: "cortex.messages.getFullByHeaderId",
                args: ["test-msg-id@example.com"]
            });

            expect(result.success).toBe(true);
            expect(result.result.full).toEqual(fullMsg);
            expect(result.result.headerMessageId).toBe("test-msg-id@example.com");
        });

        it("should throw when message not found", async () => {
            messenger.messages.query.mockResolvedValue({ messages: [] });

            const result = await bg.executeRpcCommand({
                method: "cortex.messages.getFullByHeaderId",
                args: ["nonexistent@example.com"]
            });

            expect(result.success).toBe(false);
            expect(result.error).toBe("Message not found");
        });
    });

    // =========================================================================
    // cortex.messages.getRawByHeaderId
    // =========================================================================
    describe("cortex.messages.getRawByHeaderId", () => {
        it("should return raw message content", async () => {
            const rawContent = "From: test@example.com\r\nSubject: Test\r\n\r\nBody";
            messenger.messages.getRaw.mockResolvedValue(rawContent);

            const result = await bg.executeRpcCommand({
                method: "cortex.messages.getRawByHeaderId",
                args: ["test-msg-id@example.com"]
            });

            expect(result.success).toBe(true);
            expect(result.result.raw).toBe(rawContent);
        });

        it("should throw when message not found", async () => {
            messenger.messages.query.mockResolvedValue({ messages: [] });

            const result = await bg.executeRpcCommand({
                method: "cortex.messages.getRawByHeaderId",
                args: ["nonexistent@example.com"]
            });

            expect(result.success).toBe(false);
            expect(result.error).toBe("Message not found");
        });
    });

    // =========================================================================
    // Unknown cortex method
    // =========================================================================
    describe("unknown cortex method", () => {
        it("should return error for unknown cortex.* method", async () => {
            const result = await bg.executeRpcCommand({
                method: "cortex.unknownMethod",
                args: []
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain("Unknown cortex RPC method");
        });
    });

    // =========================================================================
    // Generic RPC execution
    // =========================================================================
    describe("generic RPC execution", () => {
        it("should execute allowed messenger.* methods", async () => {
            messenger.messages.list.mockResolvedValue({ messages: [] });

            const result = await bg.executeRpcCommand({
                method: "messages.list",
                args: [{ accountId: "account1", path: "/INBOX" }]
            });

            expect(result.success).toBe(true);
            expect(messenger.messages.list).toHaveBeenCalled();
        });

        it("should reject disallowed methods", async () => {
            const result = await bg.executeRpcCommand({
                method: "runtime.getManifest",
                args: []
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain("Method not allowed");
        });

        it("should sanitize result values", async () => {
            messenger.accounts.list.mockResolvedValue([
                { id: "account1", name: "Test", date: new Date("2025-01-01") }
            ]);

            const result = await bg.executeRpcCommand({
                method: "accounts.list",
                args: []
            });

            expect(result.success).toBe(true);
            // Date should be serialized
            expect(typeof result.result[0].date).toBe("string");
        });
    });

    // =========================================================================
    // messages.query compatibility behavior
    // =========================================================================
    describe("messages.query compatibility", () => {
        it("should resolve /INBOX case and apply fromDate via folder scan", async () => {
            messenger.folders.query.mockResolvedValue([
                { path: "/Inbox", name: "Inbox" } // accountId intentionally omitted
            ]);
            const oldMsg = createMockMessage({
                id: 1,
                date: new Date("2025-01-01T00:00:00.000Z"),
                folder: { accountId: "account1", path: "/Inbox" }
            });
            const newMsg = createMockMessage({
                id: 2,
                date: new Date("2026-02-10T12:00:00.000Z"),
                folder: { accountId: "account1", path: "/Inbox" }
            });
            messenger.messages.list.mockResolvedValue({ messages: [oldMsg, newMsg], id: null });

            const result = await bg.executeRpcCommand({
                method: "messages.query",
                args: [{
                    accountId: "account1",
                    folder: { accountId: "account1", path: "/INBOX" },
                    fromDate: "2026-02-01T00:00:00.000Z",
                    limit: 50
                }]
            });

            expect(result.success).toBe(true);
            expect(messenger.messages.query).not.toHaveBeenCalled();
            expect(messenger.messages.list).toHaveBeenCalled();
            expect(result.result.messages).toHaveLength(1);
            expect(result.result.messages[0].id).toBe(2);
            expect(messenger.messages.list.mock.calls[0][0].path).toMatch(/^\/inbox$/i);
        });

        it("should accept unreadOnly/limit/includeBody without native query type errors", async () => {
            messenger.folders.query.mockResolvedValue([createMockFolder({ path: "/INBOX" })]);
            const unreadMsg = createMockMessage({
                id: 10,
                read: false,
                folder: { accountId: "account1", path: "/INBOX" }
            });
            const readMsg = createMockMessage({
                id: 11,
                read: true,
                folder: { accountId: "account1", path: "/INBOX" }
            });
            messenger.messages.list.mockResolvedValue({ messages: [readMsg, unreadMsg], id: null });

            const result = await bg.executeRpcCommand({
                method: "messages.query",
                args: [{
                    accountId: "account1",
                    folder: { accountId: "account1", path: "/INBOX" },
                    unreadOnly: true,
                    includeBody: false,
                    limit: 1
                }]
            });

            expect(result.success).toBe(true);
            expect(messenger.messages.query).not.toHaveBeenCalled();
            expect(messenger.messages.list).toHaveBeenCalled();
            expect(result.result.messages).toHaveLength(1);
            expect(result.result.messages[0].id).toBe(10);
        });

        it("should fail scoped queries when folder resolution fails (no unscoped fallback)", async () => {
            messenger.accounts.list.mockResolvedValue([
                createMockAccount({ id: "account1", folders: [] }),
                createMockAccount({ id: "account3", folders: [createMockFolder({ accountId: "account3", path: "/INBOX" })] }),
            ]);
            messenger.folders.query.mockResolvedValue([
                createMockFolder({ accountId: "account3", path: "/INBOX" }),
            ]);

            const result = await bg.executeRpcCommand({
                method: "messages.query",
                args: [{
                    accountId: "account1",
                    folder: { accountId: "account1", path: "/INBOX" },
                    fromDate: "2026-02-01T00:00:00.000Z",
                }],
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain("Unable to resolve folder scope");
            expect(messenger.messages.query).not.toHaveBeenCalled();
            expect(messenger.messages.list).not.toHaveBeenCalled();
        });

        it("should fail when scoped query returns only out-of-scope messages", async () => {
            messenger.accounts.list.mockResolvedValue([
                createMockAccount({
                    id: "account1",
                    folders: [createMockFolder({ accountId: "account1", path: "/INBOX", name: "Inbox" })],
                }),
            ]);
            messenger.messages.list.mockResolvedValue({
                id: null,
                messages: [
                    createMockMessage({
                        id: 99,
                        folder: { accountId: "account3", path: "/INBOX", name: "Inbox" },
                        date: new Date("2026-02-10T12:00:00.000Z"),
                    }),
                ],
            });

            const result = await bg.executeRpcCommand({
                method: "messages.query",
                args: [{
                    accountId: "account1",
                    folder: { accountId: "account1", path: "/INBOX" },
                    fromDate: "2026-02-01T00:00:00.000Z",
                }],
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain("Scope mismatch");
        });
    });

    describe("folders.query scoping", () => {
        it("should return only requested account folders from account tree", async () => {
            messenger.accounts.list.mockResolvedValue([
                createMockAccount({
                    id: "account1",
                    folders: [
                        createMockFolder({ accountId: "account1", path: "/INBOX", specialUse: ["inbox"] }),
                        createMockFolder({ accountId: "account1", path: "/Archive", specialUse: [] }),
                    ],
                }),
                createMockAccount({
                    id: "account3",
                    folders: [createMockFolder({ accountId: "account3", path: "/INBOX", specialUse: ["inbox"] })],
                }),
            ]);
            messenger.folders.query.mockResolvedValue([
                createMockFolder({ accountId: "account3", path: "/INBOX", specialUse: ["inbox"] }),
            ]);

            const result = await bg.executeRpcCommand({
                method: "folders.query",
                args: [{ accountId: "account1", specialUse: ["inbox"] }],
            });

            expect(result.success).toBe(true);
            expect(Array.isArray(result.result)).toBe(true);
            expect(result.result.length).toBe(1);
            expect(result.result[0].accountId).toBe("account1");
            expect(result.result[0].path).toBe("/INBOX");
            expect(messenger.folders.query).not.toHaveBeenCalled();
        });
    });

    // =========================================================================
    // sanitizeRpcResult
    // =========================================================================
    describe("sanitizeRpcResult()", () => {
        it("should return null for undefined", () => {
            expect(bg.sanitizeRpcResult(undefined)).toBeNull();
        });

        it("should return null for null", () => {
            expect(bg.sanitizeRpcResult(null)).toBeNull();
        });

        it("should convert Date to ISO string", () => {
            const date = new Date("2025-01-05T10:30:00.000Z");
            expect(bg.sanitizeRpcResult(date)).toBe("2025-01-05T10:30:00.000Z");
        });

        it("should recursively sanitize arrays", () => {
            const arr = [new Date("2025-01-05T10:30:00.000Z"), null, "string"];
            const result = bg.sanitizeRpcResult(arr);

            expect(result[0]).toBe("2025-01-05T10:30:00.000Z");
            expect(result[1]).toBeNull();
            expect(result[2]).toBe("string");
        });

        it("should handle objects with JSON serialization", () => {
            const obj = { name: "test", value: 123 };
            const result = bg.sanitizeRpcResult(obj);

            expect(result).toEqual({ name: "test", value: 123 });
        });

        it("should pass through primitive values", () => {
            expect(bg.sanitizeRpcResult("string")).toBe("string");
            expect(bg.sanitizeRpcResult(123)).toBe(123);
            expect(bg.sanitizeRpcResult(true)).toBe(true);
        });
    });

    // =========================================================================
    // RPC via processCommand
    // =========================================================================
    describe("rpc action via processCommand", () => {
        it("should handle rpc action", async () => {
            const result = await bg.processCommand({
                action: "rpc",
                method: "cortex.findMessageByHeaderId",
                args: ["test-msg-id@example.com"]
            });

            expect(result.success).toBe(true);
            expect(result.action).toBe("rpc");
            expect(result.method).toBe("cortex.findMessageByHeaderId");
        });

        it("should handle empty args array", async () => {
            messenger.accounts.list.mockResolvedValue([]);

            const result = await bg.processCommand({
                action: "rpc",
                method: "accounts.list"
            });

            expect(result.success).toBe(true);
        });
    });
});
