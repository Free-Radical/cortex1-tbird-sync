/**
 * Cortex1 Thunderbird Sync - Sent Folder Discovery Helpers
 *
 * This module is intentionally side-effect free so it can be unit-tested
 * outside Thunderbird/Betterbird.
 */

(function (root, factory) {
    const api = factory();
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    } else {
        root.Cortex1SentFolderDiscovery = api;
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    function isLikelySentFolder(folder) {
        if (!folder) return false;
        if (folder.type === "sent") return true;

        const name = String(folder.name || "").trim().toLowerCase();
        const path = String(folder.path || "").trim().toLowerCase();

        const sentNames = new Set([
            "sent",
            "sent items",
            "sent mail",
            "sent messages",
            "sent-items",
            "sentmail",
            "sentbox",
        ]);

        if (sentNames.has(name)) return true;
        if (sentNames.has(path)) return true;
        return false;
    }

    function walkFolderTree(folder, out) {
        if (!folder) return;
        out.push(folder);
        const subs = Array.isArray(folder.subFolders) ? folder.subFolders : [];
        for (const sub of subs) walkFolderTree(sub, out);
    }

    async function getSentFolders(messenger, accountIdFilter) {
        const byKey = new Map();

        const folderKey = (folder) => {
            const accountId = folder && folder.accountId != null ? String(folder.accountId) : "";
            const path = folder && folder.path != null ? String(folder.path) : "";
            const name = folder && folder.name != null ? String(folder.name) : "";
            return `${accountId}:${path || name}`;
        };

        // Best-effort: try the direct query API first.
        try {
            const sentFolders = await messenger.folders.query({ type: "sent" });
            const items = Array.isArray(sentFolders) ? sentFolders : [];
            for (const folder of items) {
                if (accountIdFilter && String(folder.accountId) !== String(accountIdFilter)) continue;
                if (folder) byKey.set(folderKey(folder), folder);
            }
        } catch {
            // Fall through to folder-tree traversal
        }

        // Always traverse all account folder trees, because some providers don't
        // correctly expose sent folders via folders.query.
        const accounts = await messenger.accounts.list();
        for (const account of accounts) {
            if (accountIdFilter && String(account.id) !== String(accountIdFilter)) continue;
            const folders = [];
            for (const root of Array.isArray(account.folders) ? account.folders : []) {
                walkFolderTree(root, folders);
            }
            for (const folder of folders) {
                if (!isLikelySentFolder(folder)) continue;
                if (folder) byKey.set(folderKey(folder), folder);
            }
        }

        return Array.from(byKey.values());
    }

    return {
        isLikelySentFolder,
        walkFolderTree,
        getSentFolders,
    };
});

