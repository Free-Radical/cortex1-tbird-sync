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
    // cortex.messages.findByLocator
    // =========================================================================
    describe("cortex.messages.findByLocator", () => {
        it("should recover through message-id candidates using existing header lookup", async () => {
            const recovered = createMockMessage({
                id: 24680,
                headerMessageId: "current-msg-id@example.com"
            });
            messenger.messages.query
                .mockResolvedValueOnce({ messages: [] })
                .mockResolvedValueOnce({ messages: [recovered] });

            const result = await bg.executeRpcCommand({
                method: "cortex.messages.findByLocator",
                args: [{
                    message_id: "stale-msg-id@example.com",
                    messageId: "current-msg-id@example.com",
                    account_id: "account1",
                    folder_path: "/INBOX"
                }]
            });

            expect(result.success).toBe(true);
            expect(result.result.message.id).toBe(24680);
            expect(result.result.match).toEqual({
                strategy: "message_id",
                candidate: "current-msg-id@example.com"
            });
            expect(messenger.messages.query).toHaveBeenNthCalledWith(1, {
                headerMessageId: "stale-msg-id@example.com"
            });
            expect(messenger.messages.query).toHaveBeenNthCalledWith(2, {
                headerMessageId: "current-msg-id@example.com"
            });
            expect(messenger.messages.list).not.toHaveBeenCalled();
        });

        it("should fall back with a date-window query for unique account folder sender subject date match", async () => {
            const folder = createMockFolder({ accountId: "account1", path: "/INBOX" });
            const nearby = createMockMessage({
                id: 35791,
                headerMessageId: "rekeyed-msg-id@example.com",
                author: "Sender Name <sender@example.com>",
                subject: "Moved message",
                date: new Date("2026-05-20T14:03:00.000Z"),
                folder
            });
            const other = createMockMessage({
                id: 35792,
                author: "other@example.com",
                subject: "Moved message",
                date: new Date("2026-05-20T14:02:00.000Z"),
                folder
            });
            const newerNonmatching = createMockMessage({
                id: 35793,
                author: "newer@example.com",
                subject: "Newest unrelated",
                date: new Date("2026-05-20T14:09:00.000Z"),
                folder
            });
            messenger.accounts.list.mockResolvedValue([
                createMockAccount({ id: "account1", folders: [folder] })
            ]);
            messenger.messages.query
                .mockResolvedValueOnce({ messages: [] })
                .mockResolvedValueOnce({ messages: [newerNonmatching, other, nearby], id: null });

            const result = await bg.executeRpcCommand({
                method: "cortex.messages.findByLocator",
                args: [{
                    message_id: "stale-msg-id@example.com",
                    account_id: "account1",
                    folder_path: "/INBOX",
                    from_addr: "sender@example.com",
                    subject: "Moved message",
                    received_at: "2026-05-20T14:00:00.000Z",
                    window_seconds: 600,
                    max_scan: 20
                }]
            });

            expect(result.success).toBe(true);
            expect(result.result.message.id).toBe(35791);
            expect(result.result.match.strategy).toBe("folder_date_content");
            expect(result.result.match.folder_path).toBe("/INBOX");
            expect(messenger.messages.query).toHaveBeenNthCalledWith(2, {
                folder,
                fromDate: new Date("2026-05-20T13:50:00.000Z")
            });
            expect(messenger.messages.list).not.toHaveBeenCalled();
        });

        it("should honor a requested 7-day locator fallback window", async () => {
            const folder = createMockFolder({ accountId: "account1", path: "/INBOX" });
            const recovered = createMockMessage({
                id: 604800,
                headerMessageId: "seven-day-recovered@example.com",
                author: "Sender Name <sender@example.com>",
                subject: "Recovered after rekey",
                date: new Date("2026-05-14T14:00:00.000Z"),
                folder
            });
            messenger.accounts.list.mockResolvedValue([
                createMockAccount({ id: "account1", folders: [folder] })
            ]);
            messenger.messages.query
                .mockResolvedValueOnce({ messages: [] })
                .mockResolvedValueOnce({ messages: [recovered], id: null });

            const result = await bg.executeRpcCommand({
                method: "cortex.messages.findByLocator",
                args: [{
                    message_id: "stale-msg-id@example.com",
                    account_id: "account1",
                    folder_path: "/INBOX",
                    from_addr: "sender@example.com",
                    subject: "Recovered after rekey",
                    received_at: "2026-05-21T14:00:00.000Z",
                    window_seconds: 604800,
                    max_scan: 20
                }]
            });

            expect(result.success).toBe(true);
            expect(result.result.message.id).toBe(604800);
            expect(result.result.match.window_seconds).toBe(604800);
            expect(messenger.messages.query).toHaveBeenNthCalledWith(2, {
                folder,
                fromDate: new Date("2026-05-14T14:00:00.000Z")
            });
            expect(messenger.messages.list).not.toHaveBeenCalled();
        });

        it("should search saved folder path before fallback folder paths in order", async () => {
            const inbox = createMockFolder({ accountId: "account1", path: "/INBOX", name: "Inbox" });
            const archive = createMockFolder({ accountId: "account1", path: "/Archive", name: "Archive", specialUse: ["archive"] });
            const sent = createMockFolder({ accountId: "account1", path: "/Sent", name: "Sent", specialUse: ["sent"] });
            const recovered = createMockMessage({
                id: 52001,
                headerMessageId: "fallback-order@example.com",
                author: "sender@example.com",
                subject: "Fallback order",
                date: new Date("2026-05-20T14:00:00.000Z"),
                folder: sent
            });
            messenger.accounts.list.mockResolvedValue([
                createMockAccount({ id: "account1", folders: [inbox, archive, sent] })
            ]);
            messenger.messages.query
                .mockResolvedValueOnce({ messages: [] })
                .mockResolvedValueOnce({ messages: [], id: null })
                .mockResolvedValueOnce({ messages: [], id: null })
                .mockResolvedValueOnce({ messages: [recovered], id: null });

            const result = await bg.executeRpcCommand({
                method: "cortex.messages.findByLocator",
                args: [{
                    message_id: "stale-fallback-order@example.com",
                    account_id: "account1",
                    folder_path: "/INBOX",
                    fallback_folder_paths: ["/Archive", "/Sent"],
                    from_addr: "sender@example.com",
                    subject: "Fallback order",
                    received_at: "2026-05-20T14:00:00.000Z",
                    max_scan: 30
                }]
            });

            expect(result.success).toBe(true);
            expect(result.result.message.id).toBe(52001);
            expect(result.result.match.folder_path).toBe("/Sent");
            expect(result.result.match.source).toBe("fallback_folder_path");
            expect(messenger.messages.query).toHaveBeenNthCalledWith(2, {
                folder: inbox,
                fromDate: new Date("2026-05-20T08:00:00.000Z")
            });
            expect(messenger.messages.query).toHaveBeenNthCalledWith(3, {
                folder: archive,
                fromDate: new Date("2026-05-20T08:00:00.000Z")
            });
            expect(messenger.messages.query).toHaveBeenNthCalledWith(4, {
                folder: sent,
                fromDate: new Date("2026-05-20T08:00:00.000Z")
            });
        });

        it("should discover All Mail or archive folders only when requested", async () => {
            const inbox = createMockFolder({ accountId: "account1", path: "/INBOX", name: "Inbox" });
            const allMail = createMockFolder({ accountId: "account1", path: "/[Gmail]/All Mail", name: "All Mail", specialUse: ["archive"] });
            const spam = createMockFolder({ accountId: "account1", path: "/Spam", name: "Spam", specialUse: ["junk"] });
            const recovered = createMockMessage({
                id: 52002,
                author: "sender@example.com",
                subject: "All Mail recovery",
                date: new Date("2026-05-20T14:00:00.000Z"),
                folder: allMail
            });
            messenger.accounts.list.mockResolvedValue([
                createMockAccount({ id: "account1", folders: [inbox, allMail, spam] })
            ]);
            messenger.messages.query
                .mockResolvedValueOnce({ messages: [], id: null })
                .mockResolvedValueOnce({ messages: [recovered], id: null });

            const result = await bg.executeRpcCommand({
                method: "cortex.messages.findByLocator",
                args: [{
                    account_id: "account1",
                    folder_path: "/INBOX",
                    include_all_mail: true,
                    from_addr: "sender@example.com",
                    subject: "All Mail recovery",
                    received_at: "2026-05-20T14:00:00.000Z"
                }]
            });

            expect(result.success).toBe(true);
            expect(result.result.message.id).toBe(52002);
            expect(result.result.match.source).toBe("include_all_mail");
            expect(messenger.messages.query).toHaveBeenCalledTimes(2);
            expect(messenger.messages.query).not.toHaveBeenCalledWith(expect.objectContaining({ folder: spam }));
        });

        it("should not search Trash or Junk folders by default", async () => {
            const inbox = createMockFolder({ accountId: "account1", path: "/INBOX", name: "Inbox" });
            const trash = createMockFolder({ accountId: "account1", path: "/Trash", name: "Trash", specialUse: ["trash"] });
            messenger.accounts.list.mockResolvedValue([
                createMockAccount({ id: "account1", folders: [inbox, trash] })
            ]);
            messenger.messages.query.mockResolvedValue({ messages: [], id: null });

            const result = await bg.executeRpcCommand({
                method: "cortex.messages.findByLocator",
                args: [{
                    account_id: "account1",
                    folder_path: "/INBOX",
                    from_addr: "sender@example.com",
                    subject: "Trash gated",
                    received_at: "2026-05-20T14:00:00.000Z"
                }]
            });

            expect(result.success).toBe(true);
            expect(result.result.message).toBeNull();
            expect(result.result.match.reason).toBe("not_found");
            expect(messenger.messages.query).toHaveBeenCalledTimes(1);
            expect(messenger.messages.query).not.toHaveBeenCalledWith(expect.objectContaining({ folder: trash }));
        });

        it("should include Trash or Junk account folders when requested", async () => {
            const inbox = createMockFolder({ accountId: "account1", path: "/INBOX", name: "Inbox" });
            const junk = createMockFolder({ accountId: "account1", path: "/Junk", name: "Junk", specialUse: ["junk"] });
            const recovered = createMockMessage({
                id: 52003,
                author: "sender@example.com",
                subject: "Junk recovery",
                date: new Date("2026-05-20T14:00:00.000Z"),
                folder: junk
            });
            messenger.accounts.list.mockResolvedValue([
                createMockAccount({ id: "account1", folders: [inbox, junk] })
            ]);
            messenger.messages.query
                .mockResolvedValueOnce({ messages: [], id: null })
                .mockResolvedValueOnce({ messages: [recovered], id: null });

            const result = await bg.executeRpcCommand({
                method: "cortex.messages.findByLocator",
                args: [{
                    account_id: "account1",
                    folder_path: "/INBOX",
                    includeTrash: true,
                    from_addr: "sender@example.com",
                    subject: "Junk recovery",
                    received_at: "2026-05-20T14:00:00.000Z"
                }]
            });

            expect(result.success).toBe(true);
            expect(result.result.message.id).toBe(52003);
            expect(result.result.match.source).toBe("include_trash");
        });

        it("should use unique recipient evidence to resolve fallback ambiguity", async () => {
            const folder = createMockFolder({ accountId: "account1", path: "/INBOX" });
            const wrongRecipient = createMockMessage({
                id: 52004,
                author: "Sender Name <sender@example.com>",
                subject: "Recipient tie",
                recipients: ["other@example.com"],
                date: new Date("2026-05-20T14:01:00.000Z"),
                folder
            });
            const rightRecipient = createMockMessage({
                id: 52005,
                author: "sender@example.com",
                subject: "Recipient tie",
                recipients: ["Target Person <target@example.com>"],
                date: new Date("2026-05-20T14:02:00.000Z"),
                folder
            });
            messenger.accounts.list.mockResolvedValue([
                createMockAccount({ id: "account1", folders: [folder] })
            ]);
            messenger.messages.query.mockResolvedValue({ messages: [wrongRecipient, rightRecipient], id: null });

            const result = await bg.executeRpcCommand({
                method: "cortex.messages.findByLocator",
                args: [{
                    account_id: "account1",
                    folder_path: "/INBOX",
                    from_addr: "sender@example.com",
                    subject: "Recipient tie",
                    received_at: "2026-05-20T14:00:00.000Z",
                    to_addr: "target@example.com"
                }]
            });

            expect(result.success).toBe(true);
            expect(result.result.message.id).toBe(52005);
            expect(result.result.match.strategy).toBe("folder_date_content_recipient");
            expect(result.result.match.evidence).toBe("recipient_or_cc");
        });

        it("should fail closed when primary and fallback folders both have content matches", async () => {
            const inbox = createMockFolder({ accountId: "account1", path: "/INBOX", name: "Inbox" });
            const archive = createMockFolder({ accountId: "account1", path: "/Archive", name: "Archive", specialUse: ["archive"] });
            const primaryMatch = createMockMessage({
                id: 52008,
                author: "sender@example.com",
                subject: "Cross-folder ambiguity",
                date: new Date("2026-05-20T14:01:00.000Z"),
                folder: inbox
            });
            const fallbackMatch = createMockMessage({
                id: 52009,
                author: "Sender Name <sender@example.com>",
                subject: "Cross-folder ambiguity",
                date: new Date("2026-05-20T14:02:00.000Z"),
                folder: archive
            });
            messenger.accounts.list.mockResolvedValue([
                createMockAccount({ id: "account1", folders: [inbox, archive] })
            ]);
            messenger.messages.query
                .mockResolvedValueOnce({ messages: [primaryMatch], id: null })
                .mockResolvedValueOnce({ messages: [fallbackMatch], id: null });

            const result = await bg.executeRpcCommand({
                method: "cortex.messages.findByLocator",
                args: [{
                    account_id: "account1",
                    folder_path: "/INBOX",
                    fallback_folder_paths: ["/Archive"],
                    from_addr: "sender@example.com",
                    subject: "Cross-folder ambiguity",
                    received_at: "2026-05-20T14:00:00.000Z",
                    max_scan: 20
                }]
            });

            expect(result.success).toBe(true);
            expect(result.result.message).toBeNull();
            expect(result.result.match).toEqual({
                strategy: "none",
                reason: "ambiguous_locator"
            });
            expect(result.result.candidates_checked).toBe(2);
            expect(messenger.messages.query).toHaveBeenCalledTimes(2);
        });

        it("should use unique recipient evidence to select across different folders", async () => {
            const inbox = createMockFolder({ accountId: "account1", path: "/INBOX", name: "Inbox" });
            const archive = createMockFolder({ accountId: "account1", path: "/Archive", name: "Archive", specialUse: ["archive"] });
            const primaryMatch = createMockMessage({
                id: 52010,
                author: "sender@example.com",
                subject: "Cross-folder recipient tie",
                recipients: ["other@example.com"],
                date: new Date("2026-05-20T14:01:00.000Z"),
                folder: inbox
            });
            const fallbackMatch = createMockMessage({
                id: 52011,
                author: "Sender Name <sender@example.com>",
                subject: "Cross-folder recipient tie",
                recipients: ["Target Person <target@example.com>"],
                date: new Date("2026-05-20T14:02:00.000Z"),
                folder: archive
            });
            messenger.accounts.list.mockResolvedValue([
                createMockAccount({ id: "account1", folders: [inbox, archive] })
            ]);
            messenger.messages.query
                .mockResolvedValueOnce({ messages: [primaryMatch], id: null })
                .mockResolvedValueOnce({ messages: [fallbackMatch], id: null });

            const result = await bg.executeRpcCommand({
                method: "cortex.messages.findByLocator",
                args: [{
                    account_id: "account1",
                    folder_path: "/INBOX",
                    fallback_folder_paths: ["/Archive"],
                    from_addr: "sender@example.com",
                    subject: "Cross-folder recipient tie",
                    received_at: "2026-05-20T14:00:00.000Z",
                    to_addr: "target@example.com",
                    max_scan: 20
                }]
            });

            expect(result.success).toBe(true);
            expect(result.result.message.id).toBe(52011);
            expect(result.result.match.strategy).toBe("folder_date_content_recipient");
            expect(result.result.match.folder_path).toBe("/Archive");
            expect(result.result.match.source).toBe("fallback_folder_path");
            expect(result.result.match.evidence).toBe("recipient_or_cc");
            expect(result.result.candidates_checked).toBe(2);
            expect(messenger.messages.query).toHaveBeenCalledTimes(2);
        });

        it("should remain ambiguous when cc evidence does not uniquely select a match", async () => {
            const folder = createMockFolder({ accountId: "account1", path: "/INBOX" });
            const msg1 = createMockMessage({
                id: 52006,
                author: "sender@example.com",
                subject: "CC tie",
                ccList: ["team@example.com"],
                date: new Date("2026-05-20T14:01:00.000Z"),
                folder
            });
            const msg2 = createMockMessage({
                id: 52007,
                author: "sender@example.com",
                subject: "CC tie",
                ccList: ["Team <team@example.com>"],
                date: new Date("2026-05-20T14:02:00.000Z"),
                folder
            });
            messenger.accounts.list.mockResolvedValue([
                createMockAccount({ id: "account1", folders: [folder] })
            ]);
            messenger.messages.query.mockResolvedValue({ messages: [msg1, msg2], id: null });

            const result = await bg.executeRpcCommand({
                method: "cortex.messages.findByLocator",
                args: [{
                    account_id: "account1",
                    folder_path: "/INBOX",
                    from_addr: "sender@example.com",
                    subject: "CC tie",
                    received_at: "2026-05-20T14:00:00.000Z",
                    ccAddr: "team@example.com"
                }]
            });

            expect(result.success).toBe(true);
            expect(result.result.message).toBeNull();
            expect(result.result.match).toEqual({
                strategy: "none",
                reason: "ambiguous_locator"
            });
        });

        it("should return none instead of guessing when fallback is ambiguous", async () => {
            const folder = createMockFolder({ accountId: "account1", path: "/INBOX" });
            const msg1 = createMockMessage({
                id: 41001,
                author: "sender@example.com",
                subject: "Ambiguous message",
                date: new Date("2026-05-20T14:01:00.000Z"),
                folder
            });
            const msg2 = createMockMessage({
                id: 41002,
                author: "Sender Name <sender@example.com>",
                subject: "Ambiguous message",
                date: new Date("2026-05-20T14:02:00.000Z"),
                folder
            });
            messenger.accounts.list.mockResolvedValue([
                createMockAccount({ id: "account1", folders: [folder] })
            ]);
            messenger.messages.query.mockResolvedValue({ messages: [msg1, msg2], id: null });

            const result = await bg.executeRpcCommand({
                method: "cortex.messages.findByLocator",
                args: [{
                    accountId: "account1",
                    folderPath: "/INBOX",
                    from: "sender@example.com",
                    subject: "Ambiguous message",
                    date: "2026-05-20T14:00:00.000Z",
                    windowSeconds: 600
                }]
            });

            expect(result.success).toBe(true);
            expect(result.result.message).toBeNull();
            expect(result.result.match).toEqual({
                strategy: "none",
                reason: "ambiguous_locator"
            });
        });

        it("should stop fallback scans at the requested bounded cap", async () => {
            const folder = createMockFolder({ accountId: "account1", path: "/INBOX" });
            const messages = [
                createMockMessage({ id: 1, author: "first@example.com", subject: "Different", date: new Date("2026-05-20T14:00:00.000Z"), folder }),
                createMockMessage({ id: 2, author: "second@example.com", subject: "Different", date: new Date("2026-05-20T14:00:00.000Z"), folder }),
                createMockMessage({ id: 3, author: "third@example.com", subject: "Different", date: new Date("2026-05-20T14:00:00.000Z"), folder }),
                createMockMessage({ id: 4, author: "sender@example.com", subject: "Late match", date: new Date("2026-05-20T14:00:00.000Z"), folder })
            ];
            messenger.accounts.list.mockResolvedValue([
                createMockAccount({ id: "account1", folders: [folder] })
            ]);
            messenger.messages.query.mockResolvedValue({ messages, id: null });

            const result = await bg.executeRpcCommand({
                method: "cortex.messages.findByLocator",
                args: [{
                    account_id: "account1",
                    folder_path: "/INBOX",
                    from_addr: "sender@example.com",
                    subject: "Late match",
                    received_at: "2026-05-20T14:00:00.000Z",
                    max_scan: 3
                }]
            });

            expect(result.success).toBe(true);
            expect(result.result.message).toBeNull();
            expect(result.result.match).toEqual({
                strategy: "none",
                reason: "not_found"
            });
            expect(result.result.candidates_checked).toBe(3);
            expect(messenger.messages.continueList).not.toHaveBeenCalled();
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
    // cortex.messages.getStateAuditByHeaderId
    // =========================================================================
    describe("cortex.messages.getStateAuditByHeaderId", () => {
        it("should return explicit sync capabilities, canonical state, and attachment manifest", async () => {
            const message = createMockMessage({
                id: 9876,
                headerMessageId: "audit@example.com",
                read: true,
                flagged: true,
                junk: false,
                junkScore: 42,
                new: true,
                priority: "high",
                external: false,
                headersOnly: false,
                tags: ["work", "follow-up"],
            });
            messenger.messages.query.mockResolvedValue({ messages: [message] });
            messenger.messages.getFull.mockResolvedValue({
                contentType: "multipart/mixed",
                headers: {
                    subject: ["Audit message"],
                    "authentication-results": ["mx.example.com; spf=pass"],
                    "in-reply-to": ["<parent@example.com>"],
                },
                body: "root body",
                parts: [
                    {
                        partName: "1",
                        contentType: "text/plain",
                        body: "hello",
                    },
                    {
                        partName: "2",
                        contentType: "application/pdf",
                        name: "invoice.pdf",
                        size: 1234,
                        headers: {
                            "content-disposition": ["attachment; filename=\"invoice.pdf\""],
                        },
                    },
                    {
                        partName: "3",
                        contentType: "text/calendar",
                        name: "invite.ics",
                        size: 456,
                        headers: {
                            "content-disposition": ["attachment; filename=\"invite.ics\""],
                        },
                    },
                ],
            });
            messenger.messages.getHeaders.mockResolvedValue({
                subject: ["Audit message"],
                "x-custom-header": ["custom-value"],
            });
            messenger.messages.listAttachments.mockResolvedValue([
                {
                    contentType: "application/pdf",
                    name: "invoice.pdf",
                    partName: "2",
                    size: 1234,
                },
            ]);
            messenger.folders.getFolderInfo.mockResolvedValue({
                totalMessageCount: 10,
                unreadMessageCount: 2,
                newMessageCount: 1,
                favorite: false,
                lastUsed: "2026-05-01T00:00:00.000Z",
                lastUsedAsDestination: null,
                quota: null,
            });
            messenger.folders.getCapabilities.mockResolvedValue({
                canAddMessages: true,
                canAddSubfolders: true,
                canBeDeleted: false,
                canBeRenamed: false,
                canDeleteMessages: true,
            });

            const result = await bg.executeRpcCommand({
                method: "cortex.messages.getStateAuditByHeaderId",
                args: ["audit@example.com"],
            });

            expect(result.success).toBe(true);
            expect(result.result.schema_version).toBe("1.0");
            expect(result.result.headerMessageId).toBe("audit@example.com");
            expect(result.result.messageId).toBe(9876);
            expect(result.result.locator.durable).toBe("headerMessageId");
            expect(result.result.locator.internalMessageIdStable).toBe(false);
            expect(result.result.capabilities.canonical_state_fields).toContain("read");
            expect(result.result.capabilities.writable_commands).toContain("set_tags");
            expect(result.result.capabilities.unsupported_or_partial.map((x) => x.field))
                .toContain("replied/forwarded native flags");
            expect(result.result.message_header.junkScore).toBe(42);
            expect(result.result.message_header.new).toBe(true);
            expect(result.result.tb_state.read).toBe(true);
            expect(result.result.tb_state.tags).toEqual(["work", "follow-up"]);
            expect(result.result.raw_message_header.priority).toBe("high");
            expect(result.result.raw_folder.path).toBe("/INBOX");
            expect(result.result.full.available).toBe(true);
            expect(result.result.full.header_names).toContain("authentication-results");
            expect(result.result.full_message_part.contentType).toBe("multipart/mixed");
            expect(result.result.headers.available).toBe(true);
            expect(result.result.headers.names).toContain("x-custom-header");
            expect(result.result.attachments.available).toBe(true);
            expect(result.result.attachments.value[0].name).toBe("invoice.pdf");
            expect(result.result.folder_info.available).toBe(true);
            expect(result.result.folder_info.value.totalMessageCount).toBe(10);
            expect(result.result.folder_capabilities.available).toBe(true);
            expect(result.result.folder_capabilities.value.canDeleteMessages).toBe(true);
            expect(result.result.attachments_manifest.map((x) => x.name)).toEqual(["invoice.pdf", "invite.ics"]);
            expect(result.result.calendar_manifest).toHaveLength(1);
            expect(result.result.calendar_manifest[0].name).toBe("invite.ics");
            expect(result.result.missing_or_not_synced_attributes.missing_from_message_header_api).toEqual([]);
            expect(result.result.missing_or_not_synced_attributes.not_bidirectionally_synced[0].surface)
                .toBe("MessageHeader");
            expect(result.result.audit_notes[0]).toContain("not a claim");
        });

        it("should report getFull errors without hiding canonical state", async () => {
            messenger.messages.getFull.mockRejectedValue(new Error("full body unavailable"));
            messenger.messages.getHeaders.mockRejectedValue(new Error("headers unavailable"));

            const result = await bg.executeRpcCommand({
                method: "cortex.messages.getStateAuditByHeaderId",
                args: ["test-msg-id@example.com"],
            });

            expect(result.success).toBe(true);
            expect(result.result.tb_state.headerMessageId).toBe("test-msg-id@example.com");
            expect(result.result.full.available).toBe(false);
            expect(result.result.full.error).toBe("full body unavailable");
            expect(result.result.attachments_manifest).toEqual([]);
            expect(result.result.full_message_part).toBeNull();
            expect(result.result.headers.available).toBe(false);
            expect(result.result.headers.error).toBe("headers unavailable");
            expect(result.result.missing_or_not_synced_attributes.missing_from_full_api)
                .toContain("contentType");
        });

        it("should report optional Thunderbird audit APIs as unavailable when absent", async () => {
            messenger.messages.getFull.mockResolvedValue({
                contentType: "text/plain",
                headers: {},
                body: "hello",
            });
            messenger.messages.getHeaders = undefined;
            messenger.messages.listAttachments = undefined;
            messenger.folders.getFolderInfo = undefined;
            messenger.folders.getCapabilities = undefined;

            const result = await bg.executeRpcCommand({
                method: "cortex.messages.getStateAuditByHeaderId",
                args: ["test-msg-id@example.com"],
            });

            expect(result.success).toBe(true);
            expect(result.result.headers.available).toBe(false);
            expect(result.result.headers.error).toBe("api not available");
            expect(result.result.attachments.available).toBe(false);
            expect(result.result.folder_info.available).toBe(false);
            expect(result.result.folder_capabilities.available).toBe(false);
            expect(result.result.missing_or_not_synced_attributes.missing_from_getHeaders_api)
                .toEqual(["messages.getHeaders"]);
            expect(result.result.missing_or_not_synced_attributes.missing_from_listAttachments_api)
                .toEqual(["messages.listAttachments"]);
            expect(result.result.missing_or_not_synced_attributes.missing_from_getFolderInfo_api)
                .toEqual(["folders.getFolderInfo"]);
            expect(result.result.missing_or_not_synced_attributes.missing_from_getCapabilities_api)
                .toEqual(["folders.getCapabilities"]);
        });

        it("should fail when message is not found", async () => {
            messenger.messages.query.mockResolvedValue({ messages: [] });

            const result = await bg.executeRpcCommand({
                method: "cortex.messages.getStateAuditByHeaderId",
                args: ["missing@example.com"],
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

    describe("critical cortex aggregate RPCs", () => {
        it("cortex.getInboxCounts uses live folder info per account", async () => {
            messenger.accounts.list.mockResolvedValue([
                createMockAccount({
                    id: "account1",
                    name: "Primary",
                    folders: [
                        createMockFolder({
                            accountId: "account1",
                            path: "/INBOX",
                            specialUse: ["inbox"],
                        }),
                    ],
                }),
            ]);
            messenger.folders.getFolderInfo.mockResolvedValue({
                totalMessageCount: 42,
                unreadMessageCount: 7,
            });

            const result = await bg.executeRpcCommand({
                method: "cortex.getInboxCounts",
                args: [],
            });

            expect(result.success).toBe(true);
            expect(result.result.account1.totalMessageCount).toBe(42);
            expect(result.result.account1.unreadMessageCount).toBe(7);
            expect(result.result.account1.method).toBe("getFolderInfo");
            expect(messenger.folders.getFolderInfo).toHaveBeenCalledTimes(1);
        });

        it("cortex.getInboxCounts falls back to paginated messages.list", async () => {
            messenger.accounts.list.mockResolvedValue([
                createMockAccount({
                    id: "account1",
                    folders: [
                        createMockFolder({
                            accountId: "account1",
                            path: "/INBOX",
                            specialUse: ["inbox"],
                        }),
                    ],
                }),
            ]);
            messenger.folders.getFolderInfo.mockRejectedValue(new Error("folder info unavailable"));
            messenger.messages.list.mockResolvedValue({
                id: "page-2",
                messages: [
                    createMockMessage({ id: 1, read: false }),
                    createMockMessage({ id: 2, read: true }),
                ],
            });
            messenger.messages.continueList.mockResolvedValueOnce({
                id: null,
                messages: [createMockMessage({ id: 3, read: false })],
            });

            const result = await bg.executeRpcCommand({
                method: "cortex.getInboxCounts",
                args: [],
            });

            expect(result.success).toBe(true);
            expect(result.result.account1.totalMessageCount).toBe(3);
            expect(result.result.account1.unreadMessageCount).toBe(2);
            expect(result.result.account1.method).toBe("messages.list(2pg)");
            expect(messenger.messages.continueList).toHaveBeenCalledWith("page-2");
        });

        it("cortex.getNewestInboxMessageByAccount samples newest inbox dates per account", async () => {
            messenger.accounts.list.mockResolvedValue([
                createMockAccount({
                    id: "account1",
                    name: "Primary",
                    folders: [
                        createMockFolder({
                            accountId: "account1",
                            path: "/INBOX",
                            specialUse: ["inbox"],
                        }),
                    ],
                }),
            ]);
            messenger.messages.list.mockResolvedValue({
                id: null,
                messages: [
                    createMockMessage({ id: 1, date: new Date("2026-01-01T00:00:00.000Z") }),
                    createMockMessage({ id: 2, date: new Date("2026-01-03T00:00:00.000Z") }),
                ],
            });

            const result = await bg.executeRpcCommand({
                method: "cortex.getNewestInboxMessageByAccount",
                args: [],
            });

            expect(result.success).toBe(true);
            expect(result.result.account1.newestDate).toBe("2026-01-03T00:00:00.000Z");
            expect(result.result.account1.sampled).toBe(2);
        });

        it("cortex.messages.getFullByHeaderId returns full body plus current state", async () => {
            const message = createMockMessage({
                id: 9876,
                headerMessageId: "full-body@example.com",
                read: true,
                flagged: true,
            });
            messenger.messages.query.mockResolvedValue({ messages: [message] });
            messenger.messages.getFull.mockResolvedValue({
                headers: { subject: ["Full Body"] },
                body: "hello",
            });

            const result = await bg.executeRpcCommand({
                method: "cortex.messages.getFullByHeaderId",
                args: ["full-body@example.com"],
            });

            expect(result.success).toBe(true);
            expect(result.result.headerMessageId).toBe("full-body@example.com");
            expect(result.result.messageId).toBe(9876);
            expect(result.result.full.body).toBe("hello");
            expect(result.result.state.read).toBe(true);
            expect(result.result.state.flagged).toBe(true);
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
    // Audit helper sanitization
    // =========================================================================
    describe("audit helper sanitization", () => {
        it("safeAuditValue should preserve JSON-safe values and mark circular references", () => {
            const obj = {
                date: new Date("2026-05-15T12:00:00.000Z"),
                missing: undefined,
                count: BigInt(7),
                nested: { keep: true },
                fn: () => "skip",
            };
            obj.self = obj;

            const result = bg.safeAuditValue(obj);

            expect(result.date).toBe("2026-05-15T12:00:00.000Z");
            expect(result.missing).toBeNull();
            expect(result.count).toBe("7");
            expect(result.nested).toEqual({ keep: true });
            expect(result.fn).toBeUndefined();
            expect(result.self).toBe("[Circular]");
        });

        it("listMissingFields should report only absent expected properties", () => {
            const result = bg.listMissingFields({ read: false, tags: [] }, ["read", "flagged", "tags"]);

            expect(result).toEqual(["flagged"]);
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

        it("should support messages.tags.list through legacy messages.listTags", async () => {
            messenger.messages.listTags.mockResolvedValue([{ key: "$label1", tag: "Important" }]);

            const result = await bg.executeRpcCommand({
                method: "messages.tags.list",
                args: []
            });

            expect(result.success).toBe(true);
            expect(result.method).toBe("messages.tags.list");
            expect(result.result).toEqual([{ key: "$label1", tag: "Important" }]);
            expect(messenger.messages.listTags).toHaveBeenCalledTimes(1);
            expect(messenger.messages.tags.list).not.toHaveBeenCalled();
        });

        it("should support messages.tags.list through modern messages.tags.list when legacy is unavailable", async () => {
            messenger.messages.listTags = undefined;
            messenger.messages.tags.list.mockResolvedValue([{ key: "$label2", tag: "Work" }]);

            const result = await bg.executeRpcCommand({
                method: "messages.tags.list",
                args: []
            });

            expect(result.success).toBe(true);
            expect(result.method).toBe("messages.tags.list");
            expect(result.result).toEqual([{ key: "$label2", tag: "Work" }]);
            expect(messenger.messages.tags.list).toHaveBeenCalledTimes(1);
        });

        it("should fall back to modern messages.tags.list when legacy listTags fails", async () => {
            messenger.messages.listTags.mockRejectedValue(new Error("legacy API failed"));
            messenger.messages.tags.list.mockResolvedValue([{ key: "$label3", tag: "Personal" }]);

            const result = await bg.executeRpcCommand({
                method: "messages.tags.list",
                args: []
            });

            expect(result.success).toBe(true);
            expect(result.result).toEqual([{ key: "$label3", tag: "Personal" }]);
            expect(messenger.messages.listTags).toHaveBeenCalledTimes(1);
            expect(messenger.messages.tags.list).toHaveBeenCalledTimes(1);
        });

        it("should create C1 tag definitions through legacy messages.createTag", async () => {
            messenger.messages.createTag.mockResolvedValue("c1_needs_you");

            const result = await bg.executeRpcCommand({
                method: "messages.createTag",
                args: ["c1_needs_you", "C1-Needs You", "#B42318"]
            });

            expect(result.success).toBe(true);
            expect(result.result).toBe("c1_needs_you");
            expect(messenger.messages.createTag).toHaveBeenCalledWith(
                "c1_needs_you",
                "C1-Needs You",
                "#B42318"
            );
        });

        it("should create C1 tag definitions through modern messages.tags.create", async () => {
            messenger.messages.tags.create.mockResolvedValue("c1_needs_you");

            const result = await bg.executeRpcCommand({
                method: "messages.tags.create",
                args: ["c1_needs_you", "C1-Needs You", "#B42318"]
            });

            expect(result.success).toBe(true);
            expect(result.result).toBe("c1_needs_you");
            expect(messenger.messages.tags.create).toHaveBeenCalledWith(
                "c1_needs_you",
                "C1-Needs You",
                "#B42318"
            );
        });

        it("should update C1 tag definitions through legacy messages.updateTag", async () => {
            messenger.messages.updateTag.mockResolvedValue(undefined);

            const result = await bg.executeRpcCommand({
                method: "messages.updateTag",
                args: ["c1_work", { tag: "C1-Work", color: "#6D28D9" }]
            });

            expect(result.success).toBe(true);
            expect(result.result).toBeNull();
            expect(messenger.messages.updateTag).toHaveBeenCalledWith(
                "c1_work",
                { tag: "C1-Work", color: "#6D28D9" }
            );
        });

        it("should update C1 tag definitions through modern messages.tags.update", async () => {
            messenger.messages.tags.update.mockResolvedValue(undefined);

            const result = await bg.executeRpcCommand({
                method: "messages.tags.update",
                args: ["c1_work", { tag: "C1-Work", color: "#6D28D9" }]
            });

            expect(result.success).toBe(true);
            expect(result.result).toBeNull();
            expect(messenger.messages.tags.update).toHaveBeenCalledWith(
                "c1_work",
                { tag: "C1-Work", color: "#6D28D9" }
            );
        });

        it("should preserve rpc method on timeout results", async () => {
            const result = bg.ensureValidCommandResult({
                id: "timeout-1",
                action: "rpc",
                method: "messages.tags.list",
                args: []
            }, {
                success: false,
                error: "Timeout after 30000ms"
            });

            expect(result.success).toBe(false);
            expect(result.error).toBe("Timeout after 30000ms");
            expect(result.method).toBe("messages.tags.list");
        });
    });
});
