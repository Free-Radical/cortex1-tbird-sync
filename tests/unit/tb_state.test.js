/**
 * Unit Tests for tb_state Response Construction
 *
 * Verifies that buildTbState() correctly constructs the tb_state object
 * with all required fields populated properly.
 */

const { createMockMessage, createMockFolder, loadBackgroundScript } = require("../setup");

describe("tb_state Construction", () => {
    let bg;

    beforeEach(() => {
        bg = loadBackgroundScript();
    });

    describe("buildTbState()", () => {
        it("should return null for null message", () => {
            const result = bg.buildTbState(null);
            expect(result).toBeNull();
        });

        it("should return null for undefined message", () => {
            const result = bg.buildTbState(undefined);
            expect(result).toBeNull();
        });

        it("should include all required fields", () => {
            const msg = createMockMessage();
            const result = bg.buildTbState(msg);

            // Message state
            expect(result).toHaveProperty("read");
            expect(result).toHaveProperty("flagged");
            expect(result).toHaveProperty("junk");
            expect(result).toHaveProperty("tags");

            // Folder info
            expect(result).toHaveProperty("folder");

            // Message metadata
            expect(result).toHaveProperty("date");
            expect(result).toHaveProperty("subject");
            expect(result).toHaveProperty("author");
            expect(result).toHaveProperty("headerMessageId");
            expect(result).toHaveProperty("size");

            // Timestamp
            expect(result).toHaveProperty("stateReadAt");
        });

        describe("Message State Fields", () => {
            it("should correctly set read status", () => {
                const readMsg = createMockMessage({ read: true });
                const unreadMsg = createMockMessage({ read: false });

                expect(bg.buildTbState(readMsg).read).toBe(true);
                expect(bg.buildTbState(unreadMsg).read).toBe(false);
            });

            it("should correctly set flagged status", () => {
                const flaggedMsg = createMockMessage({ flagged: true });
                const unflaggedMsg = createMockMessage({ flagged: false });

                expect(bg.buildTbState(flaggedMsg).flagged).toBe(true);
                expect(bg.buildTbState(unflaggedMsg).flagged).toBe(false);
            });

            it("should correctly set junk status", () => {
                const junkMsg = createMockMessage({ junk: true });
                const notJunkMsg = createMockMessage({ junk: false });

                expect(bg.buildTbState(junkMsg).junk).toBe(true);
                expect(bg.buildTbState(notJunkMsg).junk).toBe(false);
            });

            it("should default junk to false when undefined", () => {
                const msg = createMockMessage();
                delete msg.junk;

                const result = bg.buildTbState(msg);
                expect(result.junk).toBe(false);
            });

            it("should correctly copy tags array", () => {
                const msg = createMockMessage({ tags: ["important", "follow-up"] });

                const result = bg.buildTbState(msg);
                expect(result.tags).toEqual(["important", "follow-up"]);
            });

            it("should handle empty tags array", () => {
                const msg = createMockMessage({ tags: [] });

                const result = bg.buildTbState(msg);
                expect(result.tags).toEqual([]);
            });

            it("should default tags to empty array when not an array", () => {
                const msg = createMockMessage();
                msg.tags = null;

                const result = bg.buildTbState(msg);
                expect(result.tags).toEqual([]);
            });

            it("should handle undefined tags", () => {
                const msg = createMockMessage();
                delete msg.tags;

                const result = bg.buildTbState(msg);
                expect(result.tags).toEqual([]);
            });
        });

        describe("Folder Info", () => {
            it("should include all folder properties", () => {
                const msg = createMockMessage({
                    folder: {
                        accountId: "account1",
                        path: "/INBOX",
                        name: "Inbox",
                        type: "inbox",
                        specialUse: ["inbox"],
                        isFavorite: true,
                        isRoot: false
                    }
                });

                const result = bg.buildTbState(msg);

                expect(result.folder.accountId).toBe("account1");
                expect(result.folder.path).toBe("/INBOX");
                expect(result.folder.name).toBe("Inbox");
                expect(result.folder.type).toBe("inbox");
                expect(result.folder.specialUse).toEqual(["inbox"]);
                expect(result.folder.isFavorite).toBe(true);
                expect(result.folder.isRoot).toBe(false);
            });

            it("should return null for missing folder", () => {
                const msg = createMockMessage();
                delete msg.folder;

                const result = bg.buildTbState(msg);
                expect(result.folder).toBeNull();
            });

            it("should handle null folder", () => {
                const msg = createMockMessage({ folder: null });

                const result = bg.buildTbState(msg);
                expect(result.folder).toBeNull();
            });

            it("should default folder accountId to null when missing", () => {
                const msg = createMockMessage({
                    folder: { path: "/INBOX", name: "Inbox" }
                });

                const result = bg.buildTbState(msg);
                expect(result.folder.accountId).toBeNull();
            });

            it("should default folder path to empty string when missing", () => {
                const msg = createMockMessage({
                    folder: { accountId: "account1", name: "Inbox" }
                });

                const result = bg.buildTbState(msg);
                expect(result.folder.path).toBe("");
            });

            it("should default folder type to null when missing", () => {
                const msg = createMockMessage({
                    folder: { accountId: "account1", path: "/Test" }
                });

                const result = bg.buildTbState(msg);
                expect(result.folder.type).toBeNull();
            });

            it("should default specialUse to empty array when not an array", () => {
                const msg = createMockMessage({
                    folder: { accountId: "account1", path: "/Test", specialUse: null }
                });

                const result = bg.buildTbState(msg);
                expect(result.folder.specialUse).toEqual([]);
            });

            it("should default isFavorite to false when missing", () => {
                const msg = createMockMessage({
                    folder: { accountId: "account1", path: "/Test" }
                });

                const result = bg.buildTbState(msg);
                expect(result.folder.isFavorite).toBe(false);
            });

            it("should default isRoot to false when missing", () => {
                const msg = createMockMessage({
                    folder: { accountId: "account1", path: "/Test" }
                });

                const result = bg.buildTbState(msg);
                expect(result.folder.isRoot).toBe(false);
            });
        });

        describe("Message Metadata", () => {
            it("should include message date", () => {
                const testDate = new Date("2025-01-05T10:30:00.000Z");
                const msg = createMockMessage({ date: testDate });

                const result = bg.buildTbState(msg);
                expect(result.date).toEqual(testDate);
            });

            it("should include subject", () => {
                const msg = createMockMessage({ subject: "Test Subject Line" });

                const result = bg.buildTbState(msg);
                expect(result.subject).toBe("Test Subject Line");
            });

            it("should include author", () => {
                const msg = createMockMessage({ author: "sender@example.com" });

                const result = bg.buildTbState(msg);
                expect(result.author).toBe("sender@example.com");
            });

            it("should include headerMessageId", () => {
                const msg = createMockMessage({ headerMessageId: "unique-id@example.com" });

                const result = bg.buildTbState(msg);
                expect(result.headerMessageId).toBe("unique-id@example.com");
            });

            it("should include size when present", () => {
                const msg = createMockMessage({ size: 54321 });

                const result = bg.buildTbState(msg);
                expect(result.size).toBe(54321);
            });

            it("should default size to null when missing", () => {
                const msg = createMockMessage();
                delete msg.size;

                const result = bg.buildTbState(msg);
                expect(result.size).toBeNull();
            });
        });

        describe("stateReadAt Timestamp", () => {
            it("should include ISO timestamp", () => {
                const msg = createMockMessage();

                const result = bg.buildTbState(msg);
                expect(result.stateReadAt).toBeDefined();
                expect(typeof result.stateReadAt).toBe("string");
            });

            it("should be a valid ISO 8601 format", () => {
                const msg = createMockMessage();

                const result = bg.buildTbState(msg);
                const parsed = new Date(result.stateReadAt);
                expect(parsed.toISOString()).toBe(result.stateReadAt);
            });

            it("should reflect current time", () => {
                const before = new Date().toISOString();
                const msg = createMockMessage();
                const result = bg.buildTbState(msg);
                const after = new Date().toISOString();

                expect(result.stateReadAt >= before).toBe(true);
                expect(result.stateReadAt <= after).toBe(true);
            });
        });
    });

    describe("minifyMessageHeader()", () => {
        it("should return null for null message", () => {
            const result = bg.minifyMessageHeader(null);
            expect(result).toBeNull();
        });

        it("should include all header properties", () => {
            const msg = createMockMessage();
            const result = bg.minifyMessageHeader(msg);

            expect(result).toHaveProperty("id");
            expect(result).toHaveProperty("headerMessageId");
            expect(result).toHaveProperty("subject");
            expect(result).toHaveProperty("author");
            expect(result).toHaveProperty("recipients");
            expect(result).toHaveProperty("ccList");
            expect(result).toHaveProperty("bccList");
            expect(result).toHaveProperty("date");
            expect(result).toHaveProperty("read");
            expect(result).toHaveProperty("flagged");
            expect(result).toHaveProperty("junk");
            expect(result).toHaveProperty("tags");
            expect(result).toHaveProperty("folder");
        });

        it("should include minified folder", () => {
            const msg = createMockMessage();
            const result = bg.minifyMessageHeader(msg);

            expect(result.folder).not.toBeNull();
            expect(result.folder).toHaveProperty("accountId");
            expect(result.folder).toHaveProperty("path");
        });

        it("should handle null folder", () => {
            const msg = createMockMessage({ folder: null });
            const result = bg.minifyMessageHeader(msg);

            expect(result.folder).toBeNull();
        });
    });

    describe("minifyFolder()", () => {
        it("should return null for null folder", () => {
            const result = bg.minifyFolder(null);
            expect(result).toBeNull();
        });

        it("should include all folder properties", () => {
            const folder = createMockFolder();
            const result = bg.minifyFolder(folder);

            expect(result).toHaveProperty("accountId");
            expect(result).toHaveProperty("path");
            expect(result).toHaveProperty("name");
            expect(result).toHaveProperty("type");
            expect(result).toHaveProperty("specialUse");
            expect(result).toHaveProperty("isFavorite");
            expect(result).toHaveProperty("isRoot");
        });

        it("should default specialUse to empty array", () => {
            const folder = createMockFolder();
            delete folder.specialUse;

            const result = bg.minifyFolder(folder);
            expect(result.specialUse).toEqual([]);
        });

        it("should default isFavorite to false", () => {
            const folder = createMockFolder();
            delete folder.isFavorite;

            const result = bg.minifyFolder(folder);
            expect(result.isFavorite).toBe(false);
        });

        it("should default isRoot to false", () => {
            const folder = createMockFolder();
            delete folder.isRoot;

            const result = bg.minifyFolder(folder);
            expect(result.isRoot).toBe(false);
        });
    });
});
