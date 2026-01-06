/**
 * Unit Tests for Error Handling Paths
 *
 * Tests various error scenarios:
 * - Network errors during fetch
 * - Invalid JSON in server response
 * - Timeout handling
 * - Message not found in Thunderbird
 * - Folder not found
 * - Permission errors
 * - API errors
 */

const { createMockMessage, createMockFolder, createMockAccount, loadBackgroundScript } = require("../setup");

describe("Error Handling", () => {
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
    // Message Not Found Errors
    // =========================================================================
    describe("Message Not Found", () => {
        beforeEach(() => {
            messenger.messages.query.mockResolvedValue({ messages: [] });
        });

        it("markAsRead should return error when message not found", async () => {
            const result = await bg.markAsRead("nonexistent@example.com");

            expect(result.success).toBe(false);
            expect(result.error).toBe("Message not found");
            expect(result.messageId).toBe("nonexistent@example.com");
        });

        it("markAsUnread should return error when message not found", async () => {
            const result = await bg.markAsUnread("nonexistent@example.com");

            expect(result.success).toBe(false);
            expect(result.error).toBe("Message not found");
        });

        it("setFlagged should return error when message not found", async () => {
            const result = await bg.setFlagged("nonexistent@example.com", true);

            expect(result.success).toBe(false);
            expect(result.error).toBe("Message not found");
        });

        it("openMessage should return error when message not found", async () => {
            const result = await bg.openMessage("nonexistent@example.com");

            expect(result.success).toBe(false);
            expect(result.error).toBe("Message not found");
        });

        it("getMessageStatus should return error when message not found", async () => {
            const result = await bg.getMessageStatus("nonexistent@example.com");

            expect(result.success).toBe(false);
            expect(result.error).toBe("Message not found");
        });

        it("createReplyDraft should return error when message not found", async () => {
            const result = await bg.createReplyDraft("nonexistent@example.com", "body");

            expect(result.success).toBe(false);
            expect(result.error).toBe("Message not found");
        });

        it("sendReply should return error when message not found", async () => {
            const result = await bg.sendReply("nonexistent@example.com", "body");

            expect(result.success).toBe(false);
            expect(result.error).toBe("Message not found");
        });
    });

    // =========================================================================
    // API Errors
    // =========================================================================
    describe("API Errors", () => {
        it("should handle messages.update error", async () => {
            messenger.messages.update.mockRejectedValue(new Error("Permission denied"));

            const result = await bg.markAsRead("test-msg-id@example.com");

            expect(result.success).toBe(false);
            expect(result.error).toBe("Permission denied");
        });

        it("should handle messages.archive error", async () => {
            messenger.messages.archive.mockRejectedValue(new Error("Archive failed"));

            const result = await bg.archiveMessages(["test-msg-id@example.com"]);

            expect(result.success).toBe(false);
            expect(result.failed.length).toBe(1);
            expect(result.failed[0].error).toBe("Archive failed");
        });

        it("should handle messages.move error", async () => {
            const targetFolder = createMockFolder({ path: "/Archive" });
            messenger.folders.query.mockResolvedValue([targetFolder]);
            messenger.messages.move.mockRejectedValue(new Error("Move failed"));

            const result = await bg.moveMessages(["test-msg-id@example.com"], "/Archive");

            expect(result.success).toBe(false);
            expect(result.failed.length).toBe(1);
        });

        it("should handle messageDisplay.open error", async () => {
            messenger.messageDisplay.open.mockRejectedValue(new Error("Cannot open message"));

            const result = await bg.openMessage("test-msg-id@example.com");

            expect(result.success).toBe(false);
            expect(result.error).toBe("Cannot open message");
        });

        it("should handle compose.beginReply error", async () => {
            messenger.compose.beginReply.mockRejectedValue(new Error("Compose error"));

            const result = await bg.createReplyDraft("test-msg-id@example.com", "body");

            expect(result.success).toBe(false);
            expect(result.error).toBe("Compose error");
        });

        it("should handle compose.sendMessage error", async () => {
            messenger.compose.beginReply.mockResolvedValue({ id: 1 });
            messenger.compose.sendMessage.mockRejectedValue(new Error("Send failed"));

            const result = await bg.sendReply("test-msg-id@example.com", "body");

            expect(result.success).toBe(false);
            expect(result.error).toBe("Send failed");
        });
    });

    // =========================================================================
    // Folder Not Found Errors
    // =========================================================================
    describe("Folder Not Found", () => {
        it("should return error when target folder not found for move", async () => {
            messenger.folders.query.mockResolvedValue([]);

            const result = await bg.moveMessages(["test-msg-id@example.com"], "/NonexistentFolder");

            expect(result.success).toBe(false);
            expect(result.error).toContain("Folder not found");
        });

        it("should handle case-insensitive folder matching", async () => {
            const targetFolder = createMockFolder({ path: "/Archive", name: "Archive" });
            messenger.folders.query.mockResolvedValue([targetFolder]);

            const result = await bg.moveMessages(["test-msg-id@example.com"], "/archive");

            // Should find folder with case-insensitive match
            expect(result.success).toBe(true);
        });
    });

    // =========================================================================
    // Bulk Operation Partial Failures
    // =========================================================================
    describe("Bulk Operation Partial Failures", () => {
        it("should track both success and failure in bulkMarkRead", async () => {
            messenger.messages.query
                .mockResolvedValueOnce({ messages: [mockMsg] })
                .mockResolvedValueOnce({ messages: [] });

            const result = await bg.bulkMarkRead([
                "test-msg-id@example.com",
                "nonexistent@example.com"
            ]);

            expect(result.success).toBe(false); // Has failures
            expect(result.marked.length).toBe(1);
            expect(result.failed.length).toBe(1);
        });

        it("should track both success and failure in bulkGetStatus", async () => {
            messenger.messages.query
                .mockResolvedValueOnce({ messages: [mockMsg] })
                .mockResolvedValueOnce({ messages: [] });

            const result = await bg.bulkGetStatus([
                "test-msg-id@example.com",
                "nonexistent@example.com"
            ]);

            expect(result.success).toBe(false); // Has failures
            expect(result.statuses.length).toBe(1);
            expect(result.failed.length).toBe(1);
        });

        it("should track failures in archive operation", async () => {
            messenger.messages.query
                .mockResolvedValueOnce({ messages: [mockMsg] })
                .mockResolvedValueOnce({ messages: [] });

            const result = await bg.archiveMessages([
                "test-msg-id@example.com",
                "nonexistent@example.com"
            ]);

            expect(result.archived.length).toBe(1);
            expect(result.failed.length).toBe(1);
            expect(result.failed[0].messageId).toBe("nonexistent@example.com");
        });

        it("should handle update errors in bulkMarkRead", async () => {
            messenger.messages.update.mockRejectedValue(new Error("Update failed"));

            const result = await bg.bulkMarkRead(["test-msg-id@example.com"]);

            expect(result.success).toBe(false);
            expect(result.failed.length).toBe(1);
            expect(result.failed[0].error).toBe("Update failed");
        });
    });

    // =========================================================================
    // Message ID Cleaning/Normalization
    // =========================================================================
    describe("Message ID Normalization", () => {
        it("should strip angle brackets from message ID", async () => {
            messenger.messages.query.mockResolvedValue({ messages: [mockMsg] });

            const result = await bg.findMessageByHeaderId("<test-msg-id@example.com>");

            expect(messenger.messages.query).toHaveBeenCalledWith({
                headerMessageId: "test-msg-id@example.com"
            });
        });

        it("should trim whitespace from message ID", async () => {
            messenger.messages.query.mockResolvedValue({ messages: [mockMsg] });

            const result = await bg.findMessageByHeaderId("  test-msg-id@example.com  ");

            expect(messenger.messages.query).toHaveBeenCalledWith({
                headerMessageId: "test-msg-id@example.com"
            });
        });
    });

    // =========================================================================
    // Tag Handling Errors
    // =========================================================================
    describe("Tag Handling Errors", () => {
        it("should return error for unknown tag mode", async () => {
            const result = await bg.handleSetTags({
                messageId: "test-msg-id@example.com",
                tags: ["tag"],
                mode: "invalid_mode"
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain("Unknown mode");
        });

        it("should return error when message not found for set_tags", async () => {
            messenger.messages.query.mockResolvedValue({ messages: [] });

            const result = await bg.handleSetTags({
                messageId: "nonexistent@example.com",
                tags: ["tag"],
                mode: "add"
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain("Message not found");
        });
    });

    // =========================================================================
    // RPC Error Handling
    // =========================================================================
    describe("RPC Error Handling", () => {
        it("should return error for disallowed RPC method", async () => {
            const result = await bg.executeRpcCommand({
                method: "runtime.getManifest",
                args: []
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain("Method not allowed");
        });

        it("should return error for unknown method path", async () => {
            const result = await bg.executeRpcCommand({
                method: "messages.unknownMethod",
                args: []
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain("Unknown method");
        });

        it("should capture and return API errors in RPC", async () => {
            messenger.messages.get.mockRejectedValue(new Error("API Error"));

            const result = await bg.executeRpcCommand({
                method: "messages.get",
                args: [12345]
            });

            expect(result.success).toBe(false);
            expect(result.error).toBe("API Error");
        });
    });

    // =========================================================================
    // Storage Errors
    // =========================================================================
    describe("Storage Errors", () => {
        it("should handle storage.local.get errors gracefully", async () => {
            messenger.storage.local.get.mockRejectedValue(new Error("Storage error"));

            // DebugLogger.init should not throw
            await expect(bg.DebugLogger.init()).resolves.not.toThrow();
        });

        it("should handle storage.local.set errors gracefully", async () => {
            messenger.storage.local.set.mockRejectedValue(new Error("Storage error"));

            // Logging should not throw even if storage fails
            expect(() => bg.DebugLogger.log("test", "message")).not.toThrow();
        });
    });

    // =========================================================================
    // Re-fetch After Update Errors
    // =========================================================================
    describe("Re-fetch After Update", () => {
        it("should handle get error after update in archive", async () => {
            messenger.messages.get
                .mockResolvedValueOnce(mockMsg) // First get succeeds
                .mockRejectedValueOnce(new Error("Get failed")); // Re-fetch fails

            const result = await bg.archiveMessages(["test-msg-id@example.com"]);

            // Should still succeed, but tb_state may be null
            expect(result.success).toBe(true);
            expect(result.tb_states[0].tb_state).toBeNull();
        });

        it("should handle get error after update in move", async () => {
            const targetFolder = createMockFolder({ path: "/Archive" });
            messenger.folders.query.mockResolvedValue([targetFolder]);
            messenger.messages.get
                .mockResolvedValueOnce(mockMsg)
                .mockRejectedValueOnce(new Error("Get failed"));

            const result = await bg.moveMessages(["test-msg-id@example.com"], "/Archive");

            expect(result.success).toBe(true);
            expect(result.tb_states[0].tb_state).toBeNull();
        });
    });

    // =========================================================================
    // Command Processing Errors
    // =========================================================================
    describe("Command Processing Errors", () => {
        it("should handle null command", async () => {
            const result = await bg.processCommand(null);

            expect(result.success).toBe(false);
            expect(result.error).toBe("Command missing action field");
        });

        it("should handle undefined command", async () => {
            const result = await bg.processCommand(undefined);

            expect(result.success).toBe(false);
            expect(result.error).toBe("Command missing action field");
        });

        it("should handle command without action", async () => {
            const result = await bg.processCommand({ messageId: "test@example.com" });

            expect(result.success).toBe(false);
            expect(result.error).toBe("Command missing action field");
        });

        it("should handle unknown action", async () => {
            const result = await bg.processCommand({ action: "unknown_action" });

            expect(result.success).toBe(false);
            expect(result.error).toContain("Unknown action");
        });
    });

    // =========================================================================
    // Sync State Errors
    // =========================================================================
    describe("Sync State Errors", () => {
        it("should handle empty messageIds array", async () => {
            const result = await bg.processCommand({
                action: "sync_state",
                messageIds: []
            });

            expect(result.success).toBe(true);
            expect(result.states).toEqual([]);
            expect(result.count).toBe(0);
        });

        it("should track errors during sync_state lookup", async () => {
            messenger.messages.query.mockRejectedValue(new Error("Query failed"));

            const result = await bg.processCommand({
                action: "sync_state",
                messageIds: ["test@example.com"]
            });

            expect(result.success).toBe(false);
            expect(result.failed.length).toBe(1);
            expect(result.failed[0].error).toBe("Query failed");
        });

        it("should track not found messages in sync_state", async () => {
            messenger.messages.query.mockResolvedValue({ messages: [] });

            const result = await bg.processCommand({
                action: "sync_state",
                messageIds: ["nonexistent@example.com"]
            });

            expect(result.success).toBe(false);
            expect(result.failed.length).toBe(1);
            expect(result.failed[0].error).toBe("Not found");
        });
    });
});
