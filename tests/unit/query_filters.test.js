/**
 * Unit Tests for the folder-scoped messages.query compat layer.
 *
 * Regression cover for a silent-data-loss bug: `queryFolderMessagesCompat` evaluated only
 * `fromDate` and `unread`, so `author`, `subject`, `recipients`, `toDate`, `flagged`,
 * `tags` and `headerMessageId` were accepted by the RPC and then discarded. Callers got a
 * full, unfiltered folder listing back and could not tell it apart from a real result set
 * — a search for a specific sender appeared to succeed and returned everything.
 *
 * The end-to-end cases at the bottom are the ones that would have caught it.
 */

const { createMockMessage, createMockFolder, createMockAccount, loadBackgroundScript } = require("../setup");

describe("messages.query compat filters", () => {
    let bg;

    beforeEach(() => {
        messenger.accounts.list.mockResolvedValue([createMockAccount()]);
        messenger.folders.query.mockResolvedValue([createMockFolder()]);
        messenger.messages.query.mockResolvedValue({ messages: [] });
        messenger.messages.list.mockResolvedValue({ id: null, messages: [] });
        bg = loadBackgroundScript();
    });

    // =========================================================================
    // queryFieldToSearchText
    // =========================================================================
    describe("queryFieldToSearchText()", () => {
        it("should lowercase a plain string", () => {
            expect(bg.queryFieldToSearchText("DoNotReply@GM.com")).toBe("donotreply@gm.com");
        });

        it("should join an array of recipients", () => {
            expect(bg.queryFieldToSearchText(["A@x.com", "B@y.com"])).toBe("a@x.com b@y.com");
        });

        it("should return empty string for null and undefined", () => {
            expect(bg.queryFieldToSearchText(null)).toBe("");
            expect(bg.queryFieldToSearchText(undefined)).toBe("");
        });

        it("should tolerate null entries inside an array", () => {
            expect(bg.queryFieldToSearchText(["a@x.com", null])).toBe("a@x.com ");
        });
    });

    // =========================================================================
    // querySubstringMatches
    // =========================================================================
    describe("querySubstringMatches()", () => {
        it("should match case-insensitively", () => {
            expect(bg.querySubstringMatches("DoNotReply@email.oss.gm.com", "GM.COM")).toBe(true);
        });

        it("should not match a substring that is absent", () => {
            expect(bg.querySubstringMatches("sender@example.com", "gm.com")).toBe(false);
        });

        it("should treat a null or blank needle as no filter", () => {
            expect(bg.querySubstringMatches("anything", null)).toBe(true);
            expect(bg.querySubstringMatches("anything", "   ")).toBe(true);
        });

        it("should not match anything when the haystack is missing", () => {
            expect(bg.querySubstringMatches(null, "gm.com")).toBe(false);
        });
    });

    // =========================================================================
    // matchesQueryTags
    // =========================================================================
    describe("matchesQueryTags()", () => {
        const tagged = (tags) => createMockMessage({ tags });

        it("should match any-mode when one tag is present", () => {
            expect(bg.matchesQueryTags(tagged(["work"]), { mode: "any", tags: ["work", "urgent"] })).toBe(true);
        });

        it("should fail any-mode when no tag is present", () => {
            expect(bg.matchesQueryTags(tagged(["personal"]), { mode: "any", tags: ["work"] })).toBe(false);
        });

        it("should require every tag in all-mode", () => {
            expect(bg.matchesQueryTags(tagged(["work"]), { mode: "all", tags: ["work", "urgent"] })).toBe(false);
            expect(bg.matchesQueryTags(tagged(["work", "urgent"]), { mode: "all", tags: ["work", "urgent"] })).toBe(true);
        });

        it("should treat a bare array as any-mode", () => {
            expect(bg.matchesQueryTags(tagged(["work"]), ["work"])).toBe(true);
        });

        it("should treat a null spec or empty tag list as no filter", () => {
            expect(bg.matchesQueryTags(tagged([]), null)).toBe(true);
            expect(bg.matchesQueryTags(tagged([]), { mode: "any", tags: [] })).toBe(true);
        });

        it("should match tags case-insensitively", () => {
            expect(bg.matchesQueryTags(tagged(["Work"]), { tags: ["work"] })).toBe(true);
        });
    });

    // =========================================================================
    // matchesQueryFilters
    // =========================================================================
    describe("matchesQueryFilters()", () => {
        const gmMsg = createMockMessage({
            author: "DoNotReply <DoNotReply@email.oss.gm.com>",
            subject: "Appointment Confirmation: LA QUINTA CHEVROLET",
            recipients: ["owner@example.com"],
            headerMessageId: "gm-appt-123@microsoft.com",
            date: new Date("2026-08-13T23:01:30.000Z"),
            read: true,
            flagged: false,
            tags: ["work"]
        });

        it("should reject a non-object message", () => {
            expect(bg.matchesQueryFilters(null, {})).toBe(false);
            expect(bg.matchesQueryFilters("nope", {})).toBe(false);
        });

        it("should pass everything when no filters are given", () => {
            expect(bg.matchesQueryFilters(gmMsg, {})).toBe(true);
            expect(bg.matchesQueryFilters(gmMsg)).toBe(true);
        });

        it("should filter on author substring", () => {
            expect(bg.matchesQueryFilters(gmMsg, { author: "gm.com" })).toBe(true);
            expect(bg.matchesQueryFilters(gmMsg, { author: "cadillac.com" })).toBe(false);
        });

        it("should filter on subject substring", () => {
            expect(bg.matchesQueryFilters(gmMsg, { subject: "chevrolet" })).toBe(true);
            expect(bg.matchesQueryFilters(gmMsg, { subject: "invoice" })).toBe(false);
        });

        it("should filter on recipients", () => {
            expect(bg.matchesQueryFilters(gmMsg, { recipients: "owner@example.com" })).toBe(true);
            expect(bg.matchesQueryFilters(gmMsg, { recipients: "someone.else@example.com" })).toBe(false);
        });

        it("should filter on free text across subject, author and recipients", () => {
            expect(bg.matchesQueryFilters(gmMsg, { text: "quinta" })).toBe(true);
            expect(bg.matchesQueryFilters(gmMsg, { text: "oss.gm.com" })).toBe(true);
            expect(bg.matchesQueryFilters(gmMsg, { text: "owner@example" })).toBe(true);
            expect(bg.matchesQueryFilters(gmMsg, { text: "nonexistent" })).toBe(false);
        });

        it("should filter on unread state", () => {
            expect(bg.matchesQueryFilters(gmMsg, { unreadFilter: false })).toBe(true);
            expect(bg.matchesQueryFilters(gmMsg, { unreadFilter: true })).toBe(false);
        });

        it("should filter on flagged state", () => {
            expect(bg.matchesQueryFilters(gmMsg, { flaggedFilter: false })).toBe(true);
            expect(bg.matchesQueryFilters(gmMsg, { flaggedFilter: true })).toBe(false);
        });

        it("should apply fromDate as an inclusive lower bound", () => {
            const cutoff = Date.parse("2026-08-13T23:01:30.000Z");
            expect(bg.matchesQueryFilters(gmMsg, { fromDateMs: cutoff })).toBe(true);
            expect(bg.matchesQueryFilters(gmMsg, { fromDateMs: cutoff + 1 })).toBe(false);
        });

        it("should apply toDate as an inclusive upper bound", () => {
            const cutoff = Date.parse("2026-08-13T23:01:30.000Z");
            expect(bg.matchesQueryFilters(gmMsg, { toDateMs: cutoff })).toBe(true);
            expect(bg.matchesQueryFilters(gmMsg, { toDateMs: cutoff - 1 })).toBe(false);
        });

        it("should support a fromDate/toDate window together", () => {
            const from = Date.parse("2026-08-13T00:00:00.000Z");
            const to = Date.parse("2026-08-14T00:00:00.000Z");
            expect(bg.matchesQueryFilters(gmMsg, { fromDateMs: from, toDateMs: to })).toBe(true);
            expect(bg.matchesQueryFilters(gmMsg, {
                fromDateMs: Date.parse("2026-08-14T00:00:00.000Z"),
                toDateMs: Date.parse("2026-08-15T00:00:00.000Z")
            })).toBe(false);
        });

        it("should reject a message with no parseable date when a date bound is set", () => {
            const undated = createMockMessage({ date: null });
            expect(bg.matchesQueryFilters(undated, { fromDateMs: 0 })).toBe(false);
            expect(bg.matchesQueryFilters(undated, { toDateMs: Date.now() })).toBe(false);
        });

        it("should match headerMessageId ignoring angle brackets and case", () => {
            expect(bg.matchesQueryFilters(gmMsg, { headerMessageId: "<gm-appt-123@microsoft.com>" })).toBe(true);
            expect(bg.matchesQueryFilters(gmMsg, { headerMessageId: "GM-APPT-123@MICROSOFT.COM" })).toBe(true);
            expect(bg.matchesQueryFilters(gmMsg, { headerMessageId: "other@example.com" })).toBe(false);
        });

        it("should filter on tags", () => {
            expect(bg.matchesQueryFilters(gmMsg, { tags: { mode: "any", tags: ["work"] } })).toBe(true);
            expect(bg.matchesQueryFilters(gmMsg, { tags: { mode: "any", tags: ["personal"] } })).toBe(false);
        });

        it("should require ALL supplied filters to pass", () => {
            expect(bg.matchesQueryFilters(gmMsg, { author: "gm.com", subject: "chevrolet" })).toBe(true);
            // author matches, subject does not
            expect(bg.matchesQueryFilters(gmMsg, { author: "gm.com", subject: "invoice" })).toBe(false);
        });
    });

    // =========================================================================
    // buildCompatQueryFilters
    // =========================================================================
    describe("buildCompatQueryFilters()", () => {
        it("should map every supported field off the raw queryInfo", () => {
            const filters = bg.buildCompatQueryFilters({
                author: "gm.com",
                subject: "Confirmation",
                recipients: "me@example.com",
                text: "quinta",
                tags: { mode: "all", tags: ["work"] },
                flagged: true,
                unread: false,
                headerMessageId: "abc@example.com",
                fromDate: "2026-08-01T00:00:00.000Z",
                toDate: "2026-08-31T00:00:00.000Z"
            });

            expect(filters.author).toBe("gm.com");
            expect(filters.subject).toBe("Confirmation");
            expect(filters.recipients).toBe("me@example.com");
            expect(filters.text).toBe("quinta");
            expect(filters.tags).toEqual({ mode: "all", tags: ["work"] });
            expect(filters.flaggedFilter).toBe(true);
            expect(filters.unreadFilter).toBe(false);
            expect(filters.headerMessageId).toBe("abc@example.com");
            expect(filters.fromDateMs).toBe(Date.parse("2026-08-01T00:00:00.000Z"));
            expect(filters.toDateMs).toBe(Date.parse("2026-08-31T00:00:00.000Z"));
        });

        it("should map unreadOnly to unreadFilter true", () => {
            expect(bg.buildCompatQueryFilters({ unreadOnly: true }).unreadFilter).toBe(true);
        });

        it("should prefer an explicit unread boolean over absent unreadOnly", () => {
            expect(bg.buildCompatQueryFilters({ unread: false }).unreadFilter).toBe(false);
        });

        it("should null out every field for an empty or invalid queryInfo", () => {
            for (const input of [{}, null, undefined, "nonsense"]) {
                const filters = bg.buildCompatQueryFilters(input);
                expect(filters.author).toBeNull();
                expect(filters.subject).toBeNull();
                expect(filters.text).toBeNull();
                expect(filters.tags).toBeNull();
                expect(filters.unreadFilter).toBeNull();
                expect(filters.flaggedFilter).toBeNull();
                expect(filters.fromDateMs).toBeNull();
                expect(filters.toDateMs).toBeNull();
            }
        });

        it("should produce filters that matchesQueryFilters accepts unchanged", () => {
            const msg = createMockMessage({ author: "x@gm.com" });
            const filters = bg.buildCompatQueryFilters({ author: "gm.com" });
            expect(bg.matchesQueryFilters(msg, filters)).toBe(true);
        });
    });

    // =========================================================================
    // compatFiltersNarrowResults
    // =========================================================================
    describe("compatFiltersNarrowResults()", () => {
        it("should be false when nothing narrows", () => {
            expect(bg.compatFiltersNarrowResults(bg.buildCompatQueryFilters({}))).toBe(false);
            expect(bg.compatFiltersNarrowResults(null)).toBe(false);
        });

        it("should be true for each narrowing field", () => {
            const cases = [
                { author: "a" },
                { subject: "s" },
                { recipients: "r" },
                { text: "t" },
                { headerMessageId: "h" },
                { flagged: true },
                { unread: true },
                { fromDate: "2026-08-01T00:00:00.000Z" },
                { toDate: "2026-08-01T00:00:00.000Z" },
                { tags: { mode: "any", tags: ["work"] } }
            ];
            for (const input of cases) {
                expect(bg.compatFiltersNarrowResults(bg.buildCompatQueryFilters(input))).toBe(true);
            }
        });

        it("should not count a blank string or empty tag list as narrowing", () => {
            expect(bg.compatFiltersNarrowResults(bg.buildCompatQueryFilters({ author: "   " }))).toBe(false);
            expect(bg.compatFiltersNarrowResults(bg.buildCompatQueryFilters({ tags: { tags: [] } }))).toBe(false);
        });
    });

    // =========================================================================
    // queryFolderMessagesCompat — the function that dropped the filters
    // =========================================================================
    describe("queryFolderMessagesCompat()", () => {
        const folder = createMockFolder();

        const gm = createMockMessage({
            id: 1,
            headerMessageId: "gm@example.com",
            author: "DoNotReply <DoNotReply@email.oss.gm.com>",
            subject: "Appointment Confirmation: LA QUINTA CHEVROLET",
            date: new Date("2026-08-13T23:01:30.000Z")
        });
        const linkedin = createMockMessage({
            id: 2,
            headerMessageId: "li@example.com",
            author: "LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>",
            subject: "Field CISO at Jobgether",
            date: new Date("2026-08-20T16:27:38.000Z")
        });
        const costco = createMockMessage({
            id: 3,
            headerMessageId: "costco@example.com",
            author: "Costco Wholesale <membershipannualrenewal@invoice.costco.com>",
            subject: "Costco Wholesale Membership Annual Renewal",
            date: new Date("2026-08-19T18:48:20.000Z")
        });

        beforeEach(() => {
            messenger.messages.list.mockResolvedValue({ id: null, messages: [linkedin, costco, gm] });
        });

        it("REGRESSION: should apply the author filter instead of returning the whole folder", async () => {
            const result = await bg.queryFolderMessagesCompat(folder, { author: "gm.com", limit: 10 });
            expect(result.messages).toHaveLength(1);
            expect(result.messages[0].headerMessageId).toBe("gm@example.com");
        });

        it("REGRESSION: should apply the subject filter", async () => {
            const result = await bg.queryFolderMessagesCompat(folder, { subject: "membership", limit: 10 });
            expect(result.messages).toHaveLength(1);
            expect(result.messages[0].headerMessageId).toBe("costco@example.com");
        });

        it("REGRESSION: should apply toDate as an upper bound", async () => {
            const result = await bg.queryFolderMessagesCompat(folder, {
                toDate: "2026-08-19T23:59:59.000Z",
                limit: 10
            });
            const ids = result.messages.map((m) => m.headerMessageId).sort();
            expect(ids).toEqual(["costco@example.com", "gm@example.com"]);
        });

        it("should return an empty set when nothing matches, not the folder listing", async () => {
            const result = await bg.queryFolderMessagesCompat(folder, { author: "nobody@nowhere.test", limit: 10 });
            expect(result.messages).toHaveLength(0);
        });

        it("should still return everything when no filter is supplied", async () => {
            const result = await bg.queryFolderMessagesCompat(folder, { limit: 10 });
            expect(result.messages).toHaveLength(3);
        });

        it("should sort results newest first", async () => {
            const result = await bg.queryFolderMessagesCompat(folder, { limit: 10 });
            expect(result.messages.map((m) => m.headerMessageId))
                .toEqual(["li@example.com", "costco@example.com", "gm@example.com"]);
        });

        it("should honour the limit after filtering", async () => {
            const result = await bg.queryFolderMessagesCompat(folder, { limit: 2 });
            expect(result.messages).toHaveLength(2);
        });

        it("should combine filters conjunctively", async () => {
            const none = await bg.queryFolderMessagesCompat(folder, {
                author: "gm.com",
                subject: "Costco",
                limit: 10
            });
            expect(none.messages).toHaveLength(0);
        });

        it("should deduplicate messages repeated across pages", async () => {
            messenger.messages.list.mockResolvedValue({ id: "page-1", messages: [gm] });
            messenger.messages.continueList.mockResolvedValue({ id: null, messages: [gm] });
            const result = await bg.queryFolderMessagesCompat(folder, { author: "gm.com", limit: 10 });
            expect(result.messages).toHaveLength(1);
        });

        it("should page past the first page to find a filtered match", async () => {
            messenger.messages.list.mockResolvedValue({ id: "page-1", messages: [linkedin] });
            messenger.messages.continueList.mockResolvedValue({ id: null, messages: [gm] });
            const result = await bg.queryFolderMessagesCompat(folder, { author: "gm.com", limit: 10 });
            expect(result.messages).toHaveLength(1);
            expect(result.messages[0].headerMessageId).toBe("gm@example.com");
            expect(messenger.messages.continueList).toHaveBeenCalled();
        });
    });

    // =========================================================================
    // End-to-end through the RPC handler
    // =========================================================================
    describe("executeRpcCommand('messages.query')", () => {
        const gm = createMockMessage({
            id: 1,
            headerMessageId: "gm@example.com",
            author: "DoNotReply <DoNotReply@email.oss.gm.com>",
            subject: "Appointment Confirmation: LA QUINTA CHEVROLET",
            date: new Date("2026-08-13T23:01:30.000Z")
        });
        const noise = createMockMessage({
            id: 2,
            headerMessageId: "noise@example.com",
            author: "LinkedIn <jobalerts-noreply@linkedin.com>",
            subject: "Field CISO at Jobgether",
            date: new Date("2026-08-20T16:27:38.000Z")
        });

        beforeEach(() => {
            messenger.messages.list.mockResolvedValue({ id: null, messages: [noise, gm] });
        });

        const scopedQuery = (extra) => ({
            method: "messages.query",
            args: [{
                accountId: "account1",
                folder: { accountId: "account1", path: "/INBOX" },
                limit: 10,
                ...extra
            }]
        });

        it("REGRESSION: a folder-scoped author query must not return unrelated senders", async () => {
            const res = await bg.executeRpcCommand(scopedQuery({ author: "gm.com" }));

            expect(res.success).toBe(true);
            expect(res.result.messages).toHaveLength(1);
            expect(res.result.messages[0].headerMessageId).toBe("gm@example.com");
        });

        it("REGRESSION: a folder-scoped subject query must filter", async () => {
            const res = await bg.executeRpcCommand(scopedQuery({ subject: "chevrolet" }));

            expect(res.success).toBe(true);
            expect(res.result.messages).toHaveLength(1);
            expect(res.result.messages[0].headerMessageId).toBe("gm@example.com");
        });

        it("REGRESSION: toDate must bound the result set", async () => {
            const res = await bg.executeRpcCommand(scopedQuery({ toDate: "2026-08-14T00:00:00.000Z" }));

            expect(res.success).toBe(true);
            expect(res.result.messages).toHaveLength(1);
            expect(res.result.messages[0].headerMessageId).toBe("gm@example.com");
        });

        it("should never forward 'text' to the native query, which rejects it", async () => {
            await bg.executeRpcCommand(scopedQuery({ text: "quinta" }));

            for (const call of messenger.messages.query.mock.calls) {
                expect(call[0]).not.toHaveProperty("text");
            }
        });

        it("should resolve a free-text query through the compat path", async () => {
            const res = await bg.executeRpcCommand(scopedQuery({ text: "quinta" }));

            expect(res.success).toBe(true);
            expect(res.result.messages).toHaveLength(1);
            expect(res.result.messages[0].headerMessageId).toBe("gm@example.com");
        });

        it("should fail loudly for an unscoped free-text query rather than return everything", async () => {
            const res = await bg.executeRpcCommand({
                method: "messages.query",
                args: [{ text: "quinta" }]
            });

            expect(res.success).toBe(false);
            expect(res.error).toMatch(/text/i);
            expect(res.error).toMatch(/scope/i);
        });

        it("should leave an unfiltered folder listing intact", async () => {
            const res = await bg.executeRpcCommand(scopedQuery({}));

            expect(res.success).toBe(true);
            expect(res.result.messages).toHaveLength(2);
        });
    });

    // =========================================================================
    // Contract guard
    // =========================================================================
    describe("COMPAT_QUERY_FILTER_KEYS", () => {
        it("should list every field the compat path evaluates", () => {
            expect([...bg.COMPAT_QUERY_FILTER_KEYS].sort()).toEqual([
                "author", "flagged", "headerMessageId", "recipients", "subject", "tags", "text", "toDate"
            ]);
        });

        it("should be frozen so the routing contract cannot drift at runtime", () => {
            expect(Object.isFrozen(bg.COMPAT_QUERY_FILTER_KEYS)).toBe(true);
        });

        it("every key must be honoured by buildCompatQueryFilters", () => {
            // Guards the exact failure mode: a key accepted by the router but ignored by
            // the filter builder is a silently dropped filter.
            const probes = {
                author: "a@example.com",
                subject: "probe",
                recipients: "r@example.com",
                text: "probe",
                tags: { mode: "any", tags: ["probe"] },
                flagged: true,
                toDate: "2026-08-01T00:00:00.000Z",
                headerMessageId: "probe@example.com"
            };
            for (const key of bg.COMPAT_QUERY_FILTER_KEYS) {
                const filters = bg.buildCompatQueryFilters({ [key]: probes[key] });
                expect(bg.compatFiltersNarrowResults(filters)).toBe(true);
            }
        });
    });
});
