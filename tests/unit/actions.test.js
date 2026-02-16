/**
 * Unit Tests for Action Handlers
 *
 * Tests all action handlers in processCommand() switch statement:
 * mark_read, mark_unread, set_flagged, open_message, archive,
 * move, bulk_mark_read, create_draft, send_reply, get_status,
 * bulk_get_status, list_folders, rpc, backfill_replied_forwarded,
 * set_tags, sync_state, bulk_sync_state
 */

const { createMockMessage, createMockFolder, createMockAccount, loadBackgroundScript } = require("../setup");

describe("Action Handlers", () => {
    let bg;
    let mockMsg;

    beforeEach(() => {
        mockMsg = createMockMessage();

        // Setup default mock responses
        messenger.messages.query.mockResolvedValue({ messages: [mockMsg] });
        messenger.messages.get.mockResolvedValue(mockMsg);
        messenger.messages.update.mockResolvedValue();
        messenger.accounts.list.mockResolvedValue([createMockAccount()]);
        messenger.folders.query.mockResolvedValue([createMockFolder()]);

        // Load background script
        bg = loadBackgroundScript();
    });

    // =========================================================================
    // mark_read
    // =========================================================================
    describe("mark_read action", () => {
        it("should mark message as read successfully", async () => {
            const updatedMsg = { ...mockMsg, read: true };
            messenger.messages.get.mockResolvedValue(updatedMsg);

            const result = await bg.processCommand({
                action: "mark_read",
                messageId: "test-msg-id@example.com"
            });

            expect(result.success).toBe(true);
            expect(result.action).toBe("mark_read");
            expect(result.messageId).toBe("test-msg-id@example.com");
            expect(messenger.messages.update).toHaveBeenCalledWith(mockMsg.id, { read: true });
        });

        it("should include tb_state in response", async () => {
            const updatedMsg = { ...mockMsg, read: true };
            messenger.messages.get.mockResolvedValue(updatedMsg);

            const result = await bg.processCommand({
                action: "mark_read",
                messageId: "test-msg-id@example.com"
            });

            expect(result.tb_state).toBeDefined();
            expect(result.tb_state.read).toBe(true);
            expect(result.tb_state.folder).toBeDefined();
            expect(result.tb_state.stateReadAt).toBeDefined();
        });

        it("should return error when message not found", async () => {
            messenger.messages.query.mockResolvedValue({ messages: [] });

            const result = await bg.processCommand({
                action: "mark_read",
                messageId: "nonexistent@example.com"
            });

            expect(result.success).toBe(false);
            expect(result.error).toBe("Message not found");
        });

        it("should handle API errors gracefully", async () => {
            messenger.messages.update.mockRejectedValue(new Error("API Error"));

            const result = await bg.processCommand({
                action: "mark_read",
                messageId: "test-msg-id@example.com"
            });

            expect(result.success).toBe(false);
            expect(result.error).toBe("API Error");
        });
    });

    // =========================================================================
    // mark_unread
    // =========================================================================
    describe("mark_unread action", () => {
        it("should mark message as unread successfully", async () => {
            const updatedMsg = { ...mockMsg, read: false };
            messenger.messages.get.mockResolvedValue(updatedMsg);

            const result = await bg.processCommand({
                action: "mark_unread",
                messageId: "test-msg-id@example.com"
            });

            expect(result.success).toBe(true);
            expect(result.action).toBe("mark_unread");
            expect(messenger.messages.update).toHaveBeenCalledWith(mockMsg.id, { read: false });
        });

        it("should include tb_state with read=false", async () => {
            const updatedMsg = { ...mockMsg, read: false };
            messenger.messages.get.mockResolvedValue(updatedMsg);

            const result = await bg.processCommand({
                action: "mark_unread",
                messageId: "test-msg-id@example.com"
            });

            expect(result.tb_state).toBeDefined();
            expect(result.tb_state.read).toBe(false);
        });

        it("should return error when message not found", async () => {
            messenger.messages.query.mockResolvedValue({ messages: [] });

            const result = await bg.processCommand({
                action: "mark_unread",
                messageId: "nonexistent@example.com"
            });

            expect(result.success).toBe(false);
            expect(result.error).toBe("Message not found");
        });
    });

    // =========================================================================
    // set_flagged
    // =========================================================================
    describe("set_flagged action", () => {
        it("should set flagged to true", async () => {
            const updatedMsg = { ...mockMsg, flagged: true };
            messenger.messages.get.mockResolvedValue(updatedMsg);

            const result = await bg.processCommand({
                action: "set_flagged",
                messageId: "test-msg-id@example.com",
                flagged: true
            });

            expect(result.success).toBe(true);
            expect(result.action).toBe("set_flagged");
            expect(result.flagged).toBe(true);
            expect(messenger.messages.update).toHaveBeenCalledWith(mockMsg.id, { flagged: true });
        });

        it("should set flagged to false", async () => {
            const updatedMsg = { ...mockMsg, flagged: false };
            messenger.messages.get.mockResolvedValue(updatedMsg);

            const result = await bg.processCommand({
                action: "set_flagged",
                messageId: "test-msg-id@example.com",
                flagged: false
            });

            expect(result.success).toBe(true);
            expect(result.flagged).toBe(false);
            expect(messenger.messages.update).toHaveBeenCalledWith(mockMsg.id, { flagged: false });
        });

        it("should default to true when flagged not specified", async () => {
            const updatedMsg = { ...mockMsg, flagged: true };
            messenger.messages.get.mockResolvedValue(updatedMsg);

            const result = await bg.processCommand({
                action: "set_flagged",
                messageId: "test-msg-id@example.com"
            });

            expect(result.success).toBe(true);
            expect(result.flagged).toBe(true);
        });

        it("should include tb_state with flagged status", async () => {
            const updatedMsg = { ...mockMsg, flagged: true };
            messenger.messages.get.mockResolvedValue(updatedMsg);

            const result = await bg.processCommand({
                action: "set_flagged",
                messageId: "test-msg-id@example.com",
                flagged: true
            });

            expect(result.tb_state).toBeDefined();
            expect(result.tb_state.flagged).toBe(true);
        });
    });

    // =========================================================================
    // open_message
    // =========================================================================
    describe("open_message action", () => {
        it("should open message in new window", async () => {
            messenger.messages.get.mockResolvedValue(mockMsg);

            const result = await bg.processCommand({
                action: "open_message",
                messageId: "test-msg-id@example.com"
            });

            expect(result.success).toBe(true);
            expect(result.action).toBe("open_message");
            expect(messenger.messageDisplay.open).toHaveBeenCalledWith({
                messageId: mockMsg.id,
                location: "window"
            });
        });

        it("should include tb_state in response", async () => {
            messenger.messages.get.mockResolvedValue(mockMsg);

            const result = await bg.processCommand({
                action: "open_message",
                messageId: "test-msg-id@example.com"
            });

            expect(result.tb_state).toBeDefined();
        });

        it("should return error when message not found", async () => {
            messenger.messages.query.mockResolvedValue({ messages: [] });

            const result = await bg.processCommand({
                action: "open_message",
                messageId: "nonexistent@example.com"
            });

            expect(result.success).toBe(false);
            expect(result.error).toBe("Message not found");
        });
    });

    // =========================================================================
    // archive
    // =========================================================================
    describe("archive action", () => {
        it("should archive single message", async () => {
            messenger.messages.get.mockResolvedValue(mockMsg);

            const result = await bg.processCommand({
                action: "archive",
                messageId: "test-msg-id@example.com"
            });

            expect(result.success).toBe(true);
            expect(result.action).toBe("archive");
            expect(result.archived).toContain("test-msg-id@example.com");
            expect(result.count).toBe(1);
            expect(messenger.messages.archive).toHaveBeenCalledWith([mockMsg.id]);
        });

        it("should archive multiple messages", async () => {
            const msg2 = createMockMessage({ id: 12346, headerMessageId: "msg2@example.com" });
            messenger.messages.query
                .mockResolvedValueOnce({ messages: [mockMsg] })
                .mockResolvedValueOnce({ messages: [msg2] });
            messenger.messages.get
                .mockResolvedValueOnce(mockMsg)
                .mockResolvedValueOnce(msg2);

            const result = await bg.processCommand({
                action: "archive",
                messageIds: ["test-msg-id@example.com", "msg2@example.com"]
            });

            expect(result.success).toBe(true);
            expect(result.archived.length).toBe(2);
            expect(result.count).toBe(2);
        });

        it("should include tb_states array in response", async () => {
            messenger.messages.get.mockResolvedValue(mockMsg);

            const result = await bg.processCommand({
                action: "archive",
                messageId: "test-msg-id@example.com"
            });

            expect(result.tb_states).toBeDefined();
            expect(Array.isArray(result.tb_states)).toBe(true);
        });

        it("should handle partial failures", async () => {
            messenger.messages.query
                .mockResolvedValueOnce({ messages: [mockMsg] })
                .mockResolvedValueOnce({ messages: [] }); // Second message not found

            const result = await bg.processCommand({
                action: "archive",
                messageIds: ["test-msg-id@example.com", "nonexistent@example.com"]
            });

            expect(result.archived).toContain("test-msg-id@example.com");
            expect(result.failed.length).toBe(1);
            expect(result.failed[0].messageId).toBe("nonexistent@example.com");
        });
    });

    // =========================================================================
    // move
    // =========================================================================
    describe("move action", () => {
        it("should move message to folder", async () => {
            const targetFolder = createMockFolder({ path: "/Archive", name: "Archive" });
            messenger.folders.query.mockResolvedValue([targetFolder]);
            messenger.messages.get.mockResolvedValue(mockMsg);

            const result = await bg.processCommand({
                action: "move",
                messageId: "test-msg-id@example.com",
                folder: "/Archive"
            });

            expect(result.success).toBe(true);
            expect(result.action).toBe("move");
            expect(result.folder).toBe("/Archive");
            expect(result.moved).toContain("test-msg-id@example.com");
        });

        it("should include tb_states array in response", async () => {
            const targetFolder = createMockFolder({ path: "/Archive" });
            messenger.folders.query.mockResolvedValue([targetFolder]);
            messenger.messages.get.mockResolvedValue(mockMsg);

            const result = await bg.processCommand({
                action: "move",
                messageId: "test-msg-id@example.com",
                folder: "/Archive"
            });

            expect(result.tb_states).toBeDefined();
            expect(Array.isArray(result.tb_states)).toBe(true);
        });

        it("should return error when folder not found", async () => {
            messenger.folders.query.mockResolvedValue([]);

            const result = await bg.processCommand({
                action: "move",
                messageId: "test-msg-id@example.com",
                folder: "/NonexistentFolder"
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain("Folder not found");
        });
    });

    // =========================================================================
    // bulk_mark_read
    // =========================================================================
    describe("bulk_mark_read action", () => {
        it("should mark multiple messages as read", async () => {
            const msg2 = createMockMessage({ id: 12346, headerMessageId: "msg2@example.com" });
            messenger.messages.query
                .mockResolvedValueOnce({ messages: [mockMsg] })
                .mockResolvedValueOnce({ messages: [msg2] });

            const result = await bg.processCommand({
                action: "bulk_mark_read",
                messageIds: ["test-msg-id@example.com", "msg2@example.com"]
            });

            expect(result.success).toBe(true);
            expect(result.action).toBe("bulk_mark_read");
            expect(result.marked.length).toBe(2);
            expect(result.count).toBe(2);
        });

        it("should track failed messages", async () => {
            messenger.messages.query
                .mockResolvedValueOnce({ messages: [mockMsg] })
                .mockResolvedValueOnce({ messages: [] });

            const result = await bg.processCommand({
                action: "bulk_mark_read",
                messageIds: ["test-msg-id@example.com", "nonexistent@example.com"]
            });

            expect(result.marked).toContain("test-msg-id@example.com");
            expect(result.failed.length).toBe(1);
        });
    });

    // =========================================================================
    // create_draft
    // =========================================================================
    describe("create_draft action", () => {
        it("should create reply draft", async () => {
            messenger.compose.beginReply.mockResolvedValue({ id: 1 });

            const result = await bg.processCommand({
                action: "create_draft",
                messageId: "test-msg-id@example.com",
                body: "Reply body"
            });

            expect(result.success).toBe(true);
            expect(result.action).toBe("create_draft");
            expect(result.tabId).toBe(1);
            expect(messenger.compose.beginReply).toHaveBeenCalledWith(
                mockMsg.id,
                "replyToSender",
                { body: "Reply body" }
            );
        });

        it("should create reply-all draft when replyAll=true", async () => {
            messenger.compose.beginReply.mockResolvedValue({ id: 1 });

            const result = await bg.processCommand({
                action: "create_draft",
                messageId: "test-msg-id@example.com",
                body: "Reply body",
                replyAll: true
            });

            expect(result.success).toBe(true);
            expect(messenger.compose.beginReply).toHaveBeenCalledWith(
                mockMsg.id,
                "replyToAll",
                { body: "Reply body" }
            );
        });

        it("should return error when message not found", async () => {
            messenger.messages.query.mockResolvedValue({ messages: [] });

            const result = await bg.processCommand({
                action: "create_draft",
                messageId: "nonexistent@example.com",
                body: "Reply body"
            });

            expect(result.success).toBe(false);
            expect(result.error).toBe("Message not found");
        });
    });

    // =========================================================================
    // send_reply
    // =========================================================================
    describe("send_reply action", () => {
        it("should send reply immediately", async () => {
            messenger.compose.beginReply.mockResolvedValue({ id: 1 });
            messenger.compose.sendMessage.mockResolvedValue();

            const result = await bg.processCommand({
                action: "send_reply",
                messageId: "test-msg-id@example.com",
                body: "Reply body"
            });

            expect(result.success).toBe(true);
            expect(result.action).toBe("send_reply");
            expect(result.sent).toBe(true);
            expect(messenger.compose.sendMessage).toHaveBeenCalledWith(1, { mode: "sendNow" });
        });

        it("should handle send errors", async () => {
            messenger.compose.beginReply.mockResolvedValue({ id: 1 });
            messenger.compose.sendMessage.mockRejectedValue(new Error("Send failed"));

            const result = await bg.processCommand({
                action: "send_reply",
                messageId: "test-msg-id@example.com",
                body: "Reply body"
            });

            expect(result.success).toBe(false);
            expect(result.error).toBe("Send failed");
        });
    });

    // =========================================================================
    // get_status
    // =========================================================================
    describe("get_status action", () => {
        it("should return message status", async () => {
            const result = await bg.processCommand({
                action: "get_status",
                messageId: "test-msg-id@example.com"
            });

            expect(result.success).toBe(true);
            expect(result.action).toBe("get_status");
            expect(result.status).toBeDefined();
            expect(result.status.read).toBe(mockMsg.read);
            expect(result.status.flagged).toBe(mockMsg.flagged);
            expect(result.status.junk).toBe(false);
        });

        it("should include tb_state in response", async () => {
            const result = await bg.processCommand({
                action: "get_status",
                messageId: "test-msg-id@example.com"
            });

            expect(result.tb_state).toBeDefined();
            expect(result.tb_state.folder).toBeDefined();
            expect(result.tb_state.stateReadAt).toBeDefined();
        });

        it("should return error when message not found", async () => {
            messenger.messages.query.mockResolvedValue({ messages: [] });

            const result = await bg.processCommand({
                action: "get_status",
                messageId: "nonexistent@example.com"
            });

            expect(result.success).toBe(false);
            expect(result.error).toBe("Message not found");
        });
    });

    // =========================================================================
    // bulk_get_status
    // =========================================================================
    describe("bulk_get_status action", () => {
        it("should return status for multiple messages", async () => {
            const msg2 = createMockMessage({ id: 12346, headerMessageId: "msg2@example.com", read: true });
            messenger.messages.query
                .mockResolvedValueOnce({ messages: [mockMsg] })
                .mockResolvedValueOnce({ messages: [msg2] });

            const result = await bg.processCommand({
                action: "bulk_get_status",
                messageIds: ["test-msg-id@example.com", "msg2@example.com"]
            });

            expect(result.success).toBe(true);
            expect(result.action).toBe("bulk_get_status");
            expect(result.statuses.length).toBe(2);
            expect(result.count).toBe(2);
        });

        it("should include tb_state for each status", async () => {
            const result = await bg.processCommand({
                action: "bulk_get_status",
                messageIds: ["test-msg-id@example.com"]
            });

            expect(result.statuses[0].tb_state).toBeDefined();
        });

        it("should track failed lookups", async () => {
            messenger.messages.query
                .mockResolvedValueOnce({ messages: [mockMsg] })
                .mockResolvedValueOnce({ messages: [] });

            const result = await bg.processCommand({
                action: "bulk_get_status",
                messageIds: ["test-msg-id@example.com", "nonexistent@example.com"]
            });

            expect(result.statuses.length).toBe(1);
            expect(result.failed.length).toBe(1);
            expect(result.failed[0].messageId).toBe("nonexistent@example.com");
        });
    });

    // =========================================================================
    // list_folders
    // =========================================================================
    describe("list_folders action", () => {
        it("should list all folders", async () => {
            const folders = [
                createMockFolder({ path: "/INBOX", name: "Inbox" }),
                createMockFolder({ path: "/Sent", name: "Sent", type: "sent" }),
                createMockFolder({ path: "/Archive", name: "Archive" })
            ];
            messenger.folders.query.mockResolvedValue(folders);

            const result = await bg.processCommand({ action: "list_folders" });

            expect(result.success).toBe(true);
            expect(result.action).toBe("list_folders");
            expect(result.folders.length).toBe(3);
            expect(result.count).toBe(3);
        });

        it("should include folder details", async () => {
            const folders = [createMockFolder()];
            messenger.folders.query.mockResolvedValue(folders);

            const result = await bg.processCommand({ action: "list_folders" });

            expect(result.folders[0]).toHaveProperty("accountId");
            expect(result.folders[0]).toHaveProperty("path");
            expect(result.folders[0]).toHaveProperty("name");
            expect(result.folders[0]).toHaveProperty("type");
        });

        it("should handle errors gracefully", async () => {
            messenger.accounts.list.mockRejectedValue(new Error("API Error"));

            const result = await bg.processCommand({ action: "list_folders" });

            expect(result.success).toBe(false);
            expect(result.error).toBe("API Error");
        });
    });

    // =========================================================================
    // set_tags
    // =========================================================================
    describe("set_tags action", () => {
        it("should add tags in add mode", async () => {
            const result = await bg.processCommand({
                action: "set_tags",
                messageId: "test-msg-id@example.com",
                tags: ["important", "follow-up"],
                mode: "add"
            });

            expect(result.success).toBe(true);
            expect(result.action).toBe("set_tags");
            expect(result.tags).toContain("important");
            expect(result.tags).toContain("follow-up");
        });

        it("should remove tags in remove mode", async () => {
            const msgWithTags = createMockMessage({ tags: ["important", "urgent", "todo"] });
            messenger.messages.query.mockResolvedValue({ messages: [msgWithTags] });

            const result = await bg.processCommand({
                action: "set_tags",
                messageId: "test-msg-id@example.com",
                tags: ["important"],
                mode: "remove"
            });

            expect(result.success).toBe(true);
            expect(result.tags).not.toContain("important");
            expect(result.tags).toContain("urgent");
        });

        it("should replace tags in replace mode", async () => {
            const msgWithTags = createMockMessage({ tags: ["old-tag"] });
            messenger.messages.query.mockResolvedValue({ messages: [msgWithTags] });

            const result = await bg.processCommand({
                action: "set_tags",
                messageId: "test-msg-id@example.com",
                tags: ["new-tag"],
                mode: "replace"
            });

            expect(result.success).toBe(true);
            expect(result.tags).toEqual(["new-tag"]);
        });

        it("should default to add mode", async () => {
            const result = await bg.processCommand({
                action: "set_tags",
                messageId: "test-msg-id@example.com",
                tags: ["new-tag"]
            });

            expect(result.success).toBe(true);
        });

        it("should return error for unknown mode", async () => {
            const result = await bg.processCommand({
                action: "set_tags",
                messageId: "test-msg-id@example.com",
                tags: ["tag"],
                mode: "invalid"
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain("Unknown mode");
        });
    });

    // =========================================================================
    // sync_state / bulk_sync_state
    // =========================================================================
    describe("sync_state action", () => {
        it("should return state for multiple messages", async () => {
            const msg2 = createMockMessage({ id: 12346, headerMessageId: "msg2@example.com" });
            messenger.messages.query
                .mockResolvedValueOnce({ messages: [mockMsg] })
                .mockResolvedValueOnce({ messages: [msg2] });

            const result = await bg.processCommand({
                action: "sync_state",
                messageIds: ["test-msg-id@example.com", "msg2@example.com"]
            });

            expect(result.success).toBe(true);
            expect(result.action).toBe("sync_state");
            expect(result.states.length).toBe(2);
            expect(result.count).toBe(2);
        });

        it("should include tb_state for each message", async () => {
            const result = await bg.processCommand({
                action: "sync_state",
                messageIds: ["test-msg-id@example.com"]
            });

            expect(result.states[0].tb_state).toBeDefined();
            expect(result.states[0].tb_state.folder).toBeDefined();
        });

        it("should track failed lookups", async () => {
            messenger.messages.query
                .mockResolvedValueOnce({ messages: [mockMsg] })
                .mockResolvedValueOnce({ messages: [] });

            const result = await bg.processCommand({
                action: "sync_state",
                messageIds: ["test-msg-id@example.com", "nonexistent@example.com"]
            });

            expect(result.states.length).toBe(1);
            expect(result.failed.length).toBe(1);
            expect(result.failed[0].error).toBe("Not found");
        });

        it("should work with bulk_sync_state alias", async () => {
            const result = await bg.processCommand({
                action: "bulk_sync_state",
                messageIds: ["test-msg-id@example.com"]
            });

            expect(result.success).toBe(true);
            expect(result.action).toBe("sync_state");
        });
    });

    // =========================================================================
    // export_diagnostics
    // =========================================================================
    describe("export_diagnostics action", () => {
        it("should export diagnostics via downloads", async () => {
            messenger.downloads.download.mockResolvedValue(55);

            const result = await bg.processCommand({
                action: "export_diagnostics",
                format: "json"
            });

            expect(result.success).toBe(true);
            expect(result.action).toBe("export_diagnostics");
            expect(messenger.downloads.download).toHaveBeenCalled();
        });

        it("should return error when downloads API is missing", async () => {
            const saved = messenger.downloads;
            delete messenger.downloads;

            const result = await bg.processCommand({
                action: "export_diagnostics"
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain("downloads API not available");

            messenger.downloads = saved;
        });
    });

    // =========================================================================
    // Unknown action
    // =========================================================================
    describe("unknown action", () => {
        it("should return error for unknown action", async () => {
            const result = await bg.processCommand({
                action: "unknown_action"
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain("Unknown action");
        });

        it("should return error when action is missing", async () => {
            const result = await bg.processCommand({});

            expect(result.success).toBe(false);
            expect(result.error).toBe("Command missing action field");
        });

        it("should return error for null command", async () => {
            const result = await bg.processCommand(null);

            expect(result.success).toBe(false);
            expect(result.error).toBe("Command missing action field");
        });
    });
});
