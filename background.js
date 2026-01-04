/**
 * Cortex1 Thunderbird Sync - Background Script
 *
 * Polls cortex_server for pending sync commands and executes them.
 * No native messaging required - just install the .xpi.
 */

const DEFAULT_CORTEX_SERVER = "http://localhost:5001";
const CORTEX_SERVER_STORAGE_KEY = "cortex_server_url";
const POLL_INTERVAL_MS = 3000;  // Poll every 3 seconds

// Optional: direct HTTP push of Thunderbird events to cortex_server
const EVENT_PUSH_PATH = "/tbird-sync/events";
const EVENT_PUSH_ENABLED_KEY = "cortex_event_push_enabled";
const EVENT_QUEUE_KEY = "cortex_event_queue_v1";
const EVENT_QUEUE_META_KEY = "cortex_event_queue_meta_v1";
const EVENT_QUEUE_LIMIT = 2000;
const EVENT_BATCH_SIZE = 50;
const EVENT_FLUSH_INTERVAL_MS = 2000;
const EVENT_POST_TIMEOUT_MS = 5000;

let isPolling = false;
let isFlushingEvents = false;

let cachedCortexServerUrl = null;
let hasLoadedCortexServerUrl = false;

let eventQueue = null;
let eventQueueMeta = null;
let persistQueueTimer = null;
let flushQueueTimer = null;
let eventSeq = 0;

function getExtensionVersion() {
    try {
        return messenger.runtime.getManifest().version;
    } catch (error) {
        return "unknown";
    }
}

async function getCortexServerUrl() {
    if (hasLoadedCortexServerUrl) {
        return cachedCortexServerUrl || DEFAULT_CORTEX_SERVER;
    }

    try {
        const stored = await messenger.storage.local.get(CORTEX_SERVER_STORAGE_KEY);
        const value = stored && stored[CORTEX_SERVER_STORAGE_KEY];
        cachedCortexServerUrl = (typeof value === "string" && value.trim()) ? value.trim() : DEFAULT_CORTEX_SERVER;
    } catch (error) {
        cachedCortexServerUrl = DEFAULT_CORTEX_SERVER;
    } finally {
        hasLoadedCortexServerUrl = true;
    }

    return cachedCortexServerUrl;
}

async function isEventPushEnabled() {
    try {
        const stored = await messenger.storage.local.get(EVENT_PUSH_ENABLED_KEY);
        const value = stored && stored[EVENT_PUSH_ENABLED_KEY];
        return value !== false;
    } catch (error) {
        return true;
    }
}

function createEventId() {
    try {
        return crypto.randomUUID();
    } catch (error) {
        return `evt_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    }
}

function minifyMessageHeader(message) {
    if (!message) return null;
    return {
        id: message.id,
        headerMessageId: message.headerMessageId,
        subject: message.subject,
        author: message.author,
        recipients: message.recipients,
        ccList: message.ccList,
        bccList: message.bccList,
        date: message.date,
        read: message.read,
        flagged: message.flagged,
        junk: message.junk || false,
        tags: message.tags
    };
}

function minifyFolder(folder) {
    if (!folder) return null;
    return {
        accountId: folder.accountId,
        path: folder.path,
        name: folder.name,
        type: folder.type
    };
}

async function ensureEventQueueLoaded() {
    if (eventQueue !== null && eventQueueMeta !== null) return;

    try {
        const stored = await messenger.storage.local.get([EVENT_QUEUE_KEY, EVENT_QUEUE_META_KEY]);
        eventQueue = Array.isArray(stored[EVENT_QUEUE_KEY]) ? stored[EVENT_QUEUE_KEY] : [];
        eventQueueMeta = stored[EVENT_QUEUE_META_KEY] && typeof stored[EVENT_QUEUE_META_KEY] === "object"
            ? stored[EVENT_QUEUE_META_KEY]
            : {};
    } catch (error) {
        eventQueue = [];
        eventQueueMeta = {};
    }

    if (typeof eventQueueMeta.dropped !== "number") eventQueueMeta.dropped = 0;
    if (typeof eventQueueMeta.failures !== "number") eventQueueMeta.failures = 0;
    if (typeof eventQueueMeta.nextAttemptAtMs !== "number") eventQueueMeta.nextAttemptAtMs = 0;
    if (typeof eventQueueMeta.backoffMs !== "number") eventQueueMeta.backoffMs = 1000;
}

function schedulePersistQueue() {
    if (persistQueueTimer) return;
    persistQueueTimer = setTimeout(async () => {
        persistQueueTimer = null;
        try {
            await messenger.storage.local.set({
                [EVENT_QUEUE_KEY]: eventQueue || [],
                [EVENT_QUEUE_META_KEY]: eventQueueMeta || {}
            });
        } catch (error) {
            // best-effort; keep in memory
        }
    }, 500);
}

function scheduleFlushQueue() {
    if (flushQueueTimer) return;
    flushQueueTimer = setTimeout(() => {
        flushQueueTimer = null;
        flushEventQueue();
    }, 250);
}

async function enqueueEvent(eventType, payload) {
    if (!(await isEventPushEnabled())) return;

    await ensureEventQueueLoaded();

    const event = {
        event_id: createEventId(),
        event_type: eventType,
        ts_ms: Date.now(),
        seq: (eventSeq += 1),
        extension_version: getExtensionVersion(),
        payload
    };

    eventQueue.push(event);

    if (eventQueue.length > EVENT_QUEUE_LIMIT) {
        const dropCount = eventQueue.length - EVENT_QUEUE_LIMIT;
        eventQueue.splice(0, dropCount);
        eventQueueMeta.dropped += dropCount;
    }

    schedulePersistQueue();
    scheduleFlushQueue();
}

async function postEventBatch(events) {
    const baseUrl = await getCortexServerUrl();
    const url = `${baseUrl}${EVENT_PUSH_PATH}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), EVENT_POST_TIMEOUT_MS);

    try {
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ events }),
            signal: controller.signal
        });

        if (!response.ok) {
            const err = new Error(`HTTP ${response.status}`);
            err.status = response.status;
            throw err;
        }

        return true;
    } finally {
        clearTimeout(timeout);
    }
}

async function flushEventQueue() {
    if (isFlushingEvents) return;
    if (!(await isEventPushEnabled())) return;

    await ensureEventQueueLoaded();

    if (!eventQueue.length) return;

    const now = Date.now();
    if (eventQueueMeta.nextAttemptAtMs && now < eventQueueMeta.nextAttemptAtMs) return;

    isFlushingEvents = true;
    try {
        const batch = eventQueue.slice(0, EVENT_BATCH_SIZE);
        await postEventBatch(batch);

        eventQueue.splice(0, batch.length);
        eventQueueMeta.failures = 0;
        eventQueueMeta.backoffMs = 1000;
        eventQueueMeta.nextAttemptAtMs = 0;
        schedulePersistQueue();
    } catch (error) {
        eventQueueMeta.failures += 1;
        const maxBackoff = 5 * 60 * 1000;
        const nextBackoff = Math.min(maxBackoff, Math.max(1000, eventQueueMeta.backoffMs || 1000) * 2);

        // If the endpoint isn't implemented yet (404/405), back off more aggressively to avoid constant retries.
        if (error && (error.status === 404 || error.status === 405)) {
            eventQueueMeta.backoffMs = Math.max(nextBackoff, 60 * 1000);
        } else {
            eventQueueMeta.backoffMs = nextBackoff;
        }

        eventQueueMeta.nextAttemptAtMs = Date.now() + eventQueueMeta.backoffMs;
        schedulePersistQueue();
    } finally {
        isFlushingEvents = false;
    }
}

function safeAddListener(eventObj, handler) {
    try {
        if (eventObj && typeof eventObj.addListener === "function") {
            eventObj.addListener(handler);
        }
    } catch (error) {
        // best-effort; avoid breaking startup on older TB versions
    }
}

async function initEventPush() {
    if (!(await isEventPushEnabled())) return;

    await enqueueEvent("cortex.extension.started", {
        extension_version: getExtensionVersion()
    });

    safeAddListener(messenger.messages && messenger.messages.onNewMailReceived, async (folder, messageList) => {
        const messages = (messageList && messageList.messages) ? messageList.messages : [];
        await enqueueEvent("messages.onNewMailReceived", {
            folder: minifyFolder(folder),
            messages: messages.map(minifyMessageHeader)
        });
    });

    safeAddListener(messenger.messages && messenger.messages.onUpdated, async (message, changedProperties, oldProperties) => {
        await enqueueEvent("messages.onUpdated", {
            message: minifyMessageHeader(message),
            changedProperties,
            oldProperties
        });
    });

    safeAddListener(messenger.messages && messenger.messages.onMoved, async (srcFolder, dstFolder, messageList) => {
        const messages = (messageList && messageList.messages) ? messageList.messages : [];
        await enqueueEvent("messages.onMoved", {
            srcFolder: minifyFolder(srcFolder),
            dstFolder: minifyFolder(dstFolder),
            messages: messages.map(minifyMessageHeader)
        });
    });

    safeAddListener(messenger.messages && messenger.messages.onCopied, async (srcFolder, dstFolder, messageList) => {
        const messages = (messageList && messageList.messages) ? messageList.messages : [];
        await enqueueEvent("messages.onCopied", {
            srcFolder: minifyFolder(srcFolder),
            dstFolder: minifyFolder(dstFolder),
            messages: messages.map(minifyMessageHeader)
        });
    });

    safeAddListener(messenger.messages && messenger.messages.onDeleted, async (srcFolder, messageList) => {
        const messages = (messageList && messageList.messages) ? messageList.messages : [];
        await enqueueEvent("messages.onDeleted", {
            srcFolder: minifyFolder(srcFolder),
            messages: messages.map(minifyMessageHeader)
        });
    });

    safeAddListener(messenger.messages && messenger.messages.tags && messenger.messages.tags.onCreated, async (tag) => {
        await enqueueEvent("messages.tags.onCreated", { tag });
    });

    safeAddListener(messenger.messages && messenger.messages.tags && messenger.messages.tags.onUpdated, async (tag) => {
        await enqueueEvent("messages.tags.onUpdated", { tag });
    });

    safeAddListener(messenger.messages && messenger.messages.tags && messenger.messages.tags.onDeleted, async (key) => {
        await enqueueEvent("messages.tags.onDeleted", { key });
    });

    safeAddListener(messenger.folders && messenger.folders.onFolderInfoChanged, async (folder) => {
        await enqueueEvent("folders.onFolderInfoChanged", { folder: minifyFolder(folder) });
    });

    safeAddListener(messenger.folders && messenger.folders.onCreated, async (folder) => {
        await enqueueEvent("folders.onCreated", { folder: minifyFolder(folder) });
    });

    safeAddListener(messenger.folders && messenger.folders.onRenamed, async (folder, oldFolder) => {
        await enqueueEvent("folders.onRenamed", { folder: minifyFolder(folder), oldFolder: minifyFolder(oldFolder) });
    });

    safeAddListener(messenger.folders && messenger.folders.onMoved, async (folder, oldFolder) => {
        await enqueueEvent("folders.onMoved", { folder: minifyFolder(folder), oldFolder: minifyFolder(oldFolder) });
    });

    safeAddListener(messenger.folders && messenger.folders.onDeleted, async (folder) => {
        await enqueueEvent("folders.onDeleted", { folder: minifyFolder(folder) });
    });

    safeAddListener(messenger.accounts && messenger.accounts.onCreated, async (account) => {
        await enqueueEvent("accounts.onCreated", { accountId: account && account.id, name: account && account.name });
    });

    safeAddListener(messenger.accounts && messenger.accounts.onUpdated, async (account) => {
        await enqueueEvent("accounts.onUpdated", { accountId: account && account.id, name: account && account.name });
    });

    safeAddListener(messenger.accounts && messenger.accounts.onDeleted, async (accountId) => {
        await enqueueEvent("accounts.onDeleted", { accountId });
    });

    safeAddListener(messenger.identities && messenger.identities.onCreated, async (identity) => {
        await enqueueEvent("identities.onCreated", { identityId: identity && identity.id, email: identity && identity.email });
    });

    safeAddListener(messenger.identities && messenger.identities.onUpdated, async (identity) => {
        await enqueueEvent("identities.onUpdated", { identityId: identity && identity.id, email: identity && identity.email });
    });

    safeAddListener(messenger.identities && messenger.identities.onDeleted, async (identityId) => {
        await enqueueEvent("identities.onDeleted", { identityId });
    });

    safeAddListener(messenger.compose && messenger.compose.onBeforeSend, async (tab, details) => {
        await enqueueEvent("compose.onBeforeSend", {
            tabId: tab && tab.id,
            details
        });
    });

    safeAddListener(messenger.compose && messenger.compose.onAfterSend, async (tab, sendInfo) => {
        await enqueueEvent("compose.onAfterSend", {
            tabId: tab && tab.id,
            sendInfo
        });
    });

    safeAddListener(messenger.compose && messenger.compose.onAfterSave, async (tab, saveInfo) => {
        await enqueueEvent("compose.onAfterSave", {
            tabId: tab && tab.id,
            saveInfo
        });
    });

    safeAddListener(messenger.addressBooks && messenger.addressBooks.onCreated, async (addressBook) => {
        await enqueueEvent("addressBooks.onCreated", { addressBook });
    });

    safeAddListener(messenger.addressBooks && messenger.addressBooks.onUpdated, async (addressBook) => {
        await enqueueEvent("addressBooks.onUpdated", { addressBook });
    });

    safeAddListener(messenger.addressBooks && messenger.addressBooks.onDeleted, async (addressBookId) => {
        await enqueueEvent("addressBooks.onDeleted", { addressBookId });
    });

    safeAddListener(messenger.addressBooks && messenger.addressBooks.contacts && messenger.addressBooks.contacts.onCreated, async (contact, parentId) => {
        await enqueueEvent("addressBooks.contacts.onCreated", { contact, parentId });
    });

    safeAddListener(messenger.addressBooks && messenger.addressBooks.contacts && messenger.addressBooks.contacts.onUpdated, async (contact, parentId) => {
        await enqueueEvent("addressBooks.contacts.onUpdated", { contact, parentId });
    });

    safeAddListener(messenger.addressBooks && messenger.addressBooks.contacts && messenger.addressBooks.contacts.onDeleted, async (contactId, parentId) => {
        await enqueueEvent("addressBooks.contacts.onDeleted", { contactId, parentId });
    });

    // periodic flush to drain queue even without new events
    setInterval(flushEventQueue, EVENT_FLUSH_INTERVAL_MS);
    flushEventQueue();
}

/**
 * Find a message by its Message-ID header
 */
async function findMessageByHeaderId(messageId) {
    let cleanId = messageId.trim();
    if (cleanId.startsWith("<")) cleanId = cleanId.slice(1);
    if (cleanId.endsWith(">")) cleanId = cleanId.slice(0, -1);

    try {
        const result = await messenger.messages.query({
            headerMessageId: cleanId
        });
        return result.messages && result.messages.length > 0 ? result.messages[0] : null;
    } catch (error) {
        console.error("Error finding message:", error);
        return null;
    }
}

/**
 * Mark a message as read
 */
async function markAsRead(messageId) {
    const message = await findMessageByHeaderId(messageId);
    if (!message) {
        return { success: false, error: "Message not found", messageId };
    }
    try {
        await messenger.messages.update(message.id, { read: true });
        return { success: true, messageId, action: "mark_read" };
    } catch (error) {
        return { success: false, error: error.message, messageId };
    }
}

/**
 * Mark a message as unread
 */
async function markAsUnread(messageId) {
    const message = await findMessageByHeaderId(messageId);
    if (!message) {
        return { success: false, error: "Message not found", messageId };
    }
    try {
        await messenger.messages.update(message.id, { read: false });
        return { success: true, messageId, action: "mark_unread" };
    } catch (error) {
        return { success: false, error: error.message, messageId };
    }
}

/**
 * Set flagged status
 */
async function setFlagged(messageId, flagged) {
    const message = await findMessageByHeaderId(messageId);
    if (!message) {
        return { success: false, error: "Message not found", messageId };
    }
    try {
        await messenger.messages.update(message.id, { flagged: flagged });
        return { success: true, messageId, action: "set_flagged", flagged };
    } catch (error) {
        return { success: false, error: error.message, messageId };
    }
}

/**
 * Open/display a message in a new Thunderbird window
 */
async function openMessage(messageId) {
    const message = await findMessageByHeaderId(messageId);
    if (!message) {
        return { success: false, error: "Message not found", messageId };
    }
    try {
        // Open message in a new window
        await messenger.messageDisplay.open({
            messageId: message.id,
            location: "window"
        });
        return { success: true, messageId, action: "open_message" };
    } catch (error) {
        return { success: false, error: error.message, messageId };
    }
}

/**
 * Archive messages (batch support)
 */
async function archiveMessages(messageIds) {
    const results = { success: [], failed: [] };
    const tbIds = [];

    // Resolve all message IDs to Thunderbird internal IDs
    for (const msgId of messageIds) {
        const message = await findMessageByHeaderId(msgId);
        if (message) {
            tbIds.push(message.id);
            results.success.push(msgId);
        } else {
            results.failed.push({ messageId: msgId, error: "Message not found" });
        }
    }

    if (tbIds.length > 0) {
        try {
            await messenger.messages.archive(tbIds);
        } catch (error) {
            // Move successful ones to failed
            results.failed.push(...results.success.map(id => ({ messageId: id, error: error.message })));
            results.success = [];
        }
    }

    return {
        success: results.failed.length === 0,
        action: "archive",
        archived: results.success,
        failed: results.failed,
        count: results.success.length
    };
}

/**
 * Move messages to a folder (batch support)
 */
async function moveMessages(messageIds, folderPath) {
    const results = { success: [], failed: [] };
    const tbIds = [];

    // Resolve all message IDs to Thunderbird internal IDs
    for (const msgId of messageIds) {
        const message = await findMessageByHeaderId(msgId);
        if (message) {
            tbIds.push(message.id);
            results.success.push(msgId);
        } else {
            results.failed.push({ messageId: msgId, error: "Message not found" });
        }
    }

    if (tbIds.length > 0) {
        try {
            // Find the target folder
            const accounts = await messenger.accounts.list();
            let targetFolder = null;

            for (const account of accounts) {
                targetFolder = await findFolder(account.id, folderPath);
                if (targetFolder) break;
            }

            if (!targetFolder) {
                return {
                    success: false,
                    action: "move",
                    error: `Folder not found: ${folderPath}`,
                    failed: messageIds.map(id => ({ messageId: id, error: "Folder not found" }))
                };
            }

            await messenger.messages.move(tbIds, targetFolder);
        } catch (error) {
            results.failed.push(...results.success.map(id => ({ messageId: id, error: error.message })));
            results.success = [];
        }
    }

    return {
        success: results.failed.length === 0,
        action: "move",
        folder: folderPath,
        moved: results.success,
        failed: results.failed,
        count: results.success.length
    };
}

/**
 * Find a folder by path within an account
 */
async function findFolder(accountId, folderPath) {
    try {
        const folders = await messenger.folders.query({ accountId });
        // Try exact match first
        for (const folder of folders) {
            if (folder.path === folderPath || folder.name === folderPath) {
                return folder;
            }
        }
        // Try case-insensitive match
        const lowerPath = folderPath.toLowerCase();
        for (const folder of folders) {
            if (folder.path.toLowerCase() === lowerPath || folder.name.toLowerCase() === lowerPath) {
                return folder;
            }
        }
        return null;
    } catch (error) {
        console.error("Error finding folder:", error);
        return null;
    }
}

/**
 * Bulk mark messages as read (batch support)
 */
async function bulkMarkRead(messageIds) {
    const results = { success: [], failed: [] };

    for (const msgId of messageIds) {
        const message = await findMessageByHeaderId(msgId);
        if (message) {
            try {
                await messenger.messages.update(message.id, { read: true });
                results.success.push(msgId);
            } catch (error) {
                results.failed.push({ messageId: msgId, error: error.message });
            }
        } else {
            results.failed.push({ messageId: msgId, error: "Message not found" });
        }
    }

    return {
        success: results.failed.length === 0,
        action: "bulk_mark_read",
        marked: results.success,
        failed: results.failed,
        count: results.success.length
    };
}

/**
 * Create a reply draft for a message
 */
async function createReplyDraft(messageId, replyBody, replyAll = false) {
    const message = await findMessageByHeaderId(messageId);
    if (!message) {
        return { success: false, error: "Message not found", messageId };
    }
    try {
        const replyType = replyAll ? "replyToAll" : "replyToSender";
        const tab = await messenger.compose.beginReply(message.id, replyType, {
            body: replyBody
        });
        return {
            success: true,
            messageId,
            action: "create_draft",
            tabId: tab.id
        };
    } catch (error) {
        return { success: false, error: error.message, messageId };
    }
}

/**
 * Send a reply to a message directly
 * WARNING: This sends immediately - use with caution
 */
async function sendReply(messageId, replyBody, replyAll = false) {
    const message = await findMessageByHeaderId(messageId);
    if (!message) {
        return { success: false, error: "Message not found", messageId };
    }
    try {
        const replyType = replyAll ? "replyToAll" : "replyToSender";
        const tab = await messenger.compose.beginReply(message.id, replyType, {
            body: replyBody
        });
        // Send the composed message
        await messenger.compose.sendMessage(tab.id, { mode: "sendNow" });
        return {
            success: true,
            messageId,
            action: "send_reply",
            sent: true
        };
    } catch (error) {
        return { success: false, error: error.message, messageId };
    }
}

/**
 * Get message status from Thunderbird
 * Returns read/flagged status (live from Thunderbird, not stale mbox data)
 * Note: 'forwarded' is NOT exposed by WebExtension API - only available from X-Mozilla-Status
 */
async function getMessageStatus(messageId) {
    const message = await findMessageByHeaderId(messageId);
    if (!message) {
        return { success: false, error: "Message not found", messageId };
    }
    return {
        success: true,
        messageId,
        action: "get_status",
        status: {
            read: message.read,
            flagged: message.flagged,
            junk: message.junk || false,
            date: message.date,
            subject: message.subject,
            author: message.author
            // Note: 'forwarded' and 'replied' are NOT exposed by Thunderbird WebExtension API
            // These can only be read from X-Mozilla-Status headers which may be stale
        }
    };
}

/**
 * Bulk get status for multiple messages
 */
async function bulkGetStatus(messageIds) {
    const results = { success: [], failed: [] };

    for (const msgId of messageIds) {
        const message = await findMessageByHeaderId(msgId);
        if (message) {
            results.success.push({
                messageId: msgId,
                read: message.read,
                flagged: message.flagged,
                junk: message.junk || false
            });
        } else {
            results.failed.push({ messageId: msgId, error: "Message not found" });
        }
    }

    return {
        success: results.failed.length === 0,
        action: "bulk_get_status",
        statuses: results.success,
        failed: results.failed,
        count: results.success.length
    };
}

/**
 * List available folders (for discovery)
 */
async function listFolders() {
    try {
        const accounts = await messenger.accounts.list();
        const allFolders = [];

        for (const account of accounts) {
            const folders = await messenger.folders.query({ accountId: account.id });
            for (const folder of folders) {
                allFolders.push({
                    accountId: account.id,
                    accountName: account.name,
                    path: folder.path,
                    name: folder.name,
                    type: folder.type
                });
            }
        }

        return {
            success: true,
            action: "list_folders",
            folders: allFolders,
            count: allFolders.length
        };
    } catch (error) {
        return { success: false, error: error.message, action: "list_folders" };
    }
}

async function handleToolbarClick() {
    await enqueueEvent("cortex.browser_action.clicked", { ok: true });

    try {
        await flushEventQueue();
    } catch (error) {
        // best-effort
    }

    try {
        await pollForCommands();
    } catch (error) {
        // best-effort
    }
}

function isAllowedRpcMethodPath(methodPath) {
    if (typeof methodPath !== "string" || !methodPath.trim()) return false;

    if (methodPath.startsWith("cortex.")) return true;

    const allowedPrefixes = [
        "messages.",
        "compose.",
        "folders.",
        "accounts.",
        "identities.",
        "addressBooks."
    ];

    if (!allowedPrefixes.some(prefix => methodPath.startsWith(prefix))) return false;

    // Disallow tampering with events/listeners over RPC
    const parts = methodPath.split(".");
    if (parts.some(p => p === "addListener" || p === "removeListener" || p === "hasListener")) return false;
    if (parts.some(p => /^on[A-Z]/.test(p))) return false;

    return true;
}

function getRpcFunctionByPath(methodPath) {
    const parts = methodPath.split(".");
    let obj = messenger;

    for (const part of parts) {
        if (!obj || typeof obj !== "object") return null;
        obj = obj[part];
    }

    return (typeof obj === "function") ? obj : null;
}

function sanitizeRpcResult(value) {
    if (value === undefined) return null;
    if (value === null) return null;

    if (value instanceof Date) return value.toISOString();

    if (Array.isArray(value)) {
        return value.map(sanitizeRpcResult);
    }

    if (typeof value === "object") {
        // Attempt a JSON-safe deep sanitize without blowing up on special objects.
        try {
            return JSON.parse(JSON.stringify(value));
        } catch (error) {
            return String(value);
        }
    }

    return value;
}

async function cortexResolveMessageIds(headerMessageIds) {
    const resolved = [];
    const failed = [];

    for (const headerMessageId of headerMessageIds) {
        const message = await findMessageByHeaderId(headerMessageId);
        if (message) {
            resolved.push({ headerMessageId, messageId: message.id });
        } else {
            failed.push({ headerMessageId, error: "Message not found" });
        }
    }

    return { resolved, failed };
}

async function cortexRpc(methodPath, args) {
    switch (methodPath) {
        case "cortex.findMessageByHeaderId": {
            const message = await findMessageByHeaderId(args[0]);
            return minifyMessageHeader(message);
        }
        case "cortex.resolveMessageIds": {
            return await cortexResolveMessageIds(args[0] || []);
        }
        case "cortex.messages.updateByHeaderId": {
            const headerMessageId = args[0];
            const props = args[1] || {};
            const message = await findMessageByHeaderId(headerMessageId);
            if (!message) throw new Error("Message not found");
            await messenger.messages.update(message.id, props);
            return { headerMessageId, messageId: message.id, updated: true };
        }
        case "cortex.messages.archiveByHeaderId": {
            const headerMessageIds = args[0] || [];
            const { resolved, failed } = await cortexResolveMessageIds(headerMessageIds);
            const messageIds = resolved.map(x => x.messageId);
            if (messageIds.length) {
                await messenger.messages.archive(messageIds);
            }
            return { archived: resolved, failed };
        }
        case "cortex.messages.deleteByHeaderId": {
            const headerMessageIds = args[0] || [];
            const skipTrash = args[1] === true;
            const { resolved, failed } = await cortexResolveMessageIds(headerMessageIds);
            const messageIds = resolved.map(x => x.messageId);
            if (messageIds.length) {
                await messenger.messages.delete(messageIds, skipTrash);
            }
            return { deleted: resolved, failed, skipTrash };
        }
        case "cortex.messages.moveByHeaderId": {
            const headerMessageIds = args[0] || [];
            const folderPath = args[1];
            const { resolved, failed } = await cortexResolveMessageIds(headerMessageIds);
            if (!folderPath) throw new Error("Missing folderPath");

            const accounts = await messenger.accounts.list();
            let targetFolder = null;
            for (const account of accounts) {
                targetFolder = await findFolder(account.id, folderPath);
                if (targetFolder) break;
            }
            if (!targetFolder) throw new Error(`Folder not found: ${folderPath}`);

            const messageIds = resolved.map(x => x.messageId);
            if (messageIds.length) {
                await messenger.messages.move(messageIds, targetFolder);
            }
            return { moved: resolved, failed, folder: minifyFolder(targetFolder) };
        }
        case "cortex.messages.copyByHeaderId": {
            const headerMessageIds = args[0] || [];
            const folderPath = args[1];
            const { resolved, failed } = await cortexResolveMessageIds(headerMessageIds);
            if (!folderPath) throw new Error("Missing folderPath");

            const accounts = await messenger.accounts.list();
            let targetFolder = null;
            for (const account of accounts) {
                targetFolder = await findFolder(account.id, folderPath);
                if (targetFolder) break;
            }
            if (!targetFolder) throw new Error(`Folder not found: ${folderPath}`);

            const messageIds = resolved.map(x => x.messageId);
            if (messageIds.length) {
                await messenger.messages.copy(messageIds, targetFolder);
            }
            return { copied: resolved, failed, folder: minifyFolder(targetFolder) };
        }
        case "cortex.messages.getFullByHeaderId": {
            const headerMessageId = args[0];
            const message = await findMessageByHeaderId(headerMessageId);
            if (!message) throw new Error("Message not found");
            const full = await messenger.messages.getFull(message.id);
            return { headerMessageId, messageId: message.id, full };
        }
        case "cortex.messages.getRawByHeaderId": {
            const headerMessageId = args[0];
            const message = await findMessageByHeaderId(headerMessageId);
            if (!message) throw new Error("Message not found");
            const raw = await messenger.messages.getRaw(message.id);
            return { headerMessageId, messageId: message.id, raw };
        }
        default:
            throw new Error(`Unknown cortex RPC method: ${methodPath}`);
    }
}

async function executeRpcCommand(cmd) {
    const method = cmd.method;
    const args = Array.isArray(cmd.args) ? cmd.args : [];

    if (!isAllowedRpcMethodPath(method)) {
        return { success: false, action: "rpc", method, error: `Method not allowed: ${method}` };
    }

    try {
        let result;
        if (method.startsWith("cortex.")) {
            result = await cortexRpc(method, args);
        } else {
            const fn = getRpcFunctionByPath(method);
            if (!fn) {
                return { success: false, action: "rpc", method, error: `Unknown method: ${method}` };
            }
            result = await fn(...args);
        }

        return {
            success: true,
            action: "rpc",
            method,
            result: sanitizeRpcResult(result)
        };
    } catch (error) {
        return { success: false, action: "rpc", method, error: error.message || String(error) };
    }
}

// ============================================================================
// Backfill Replied/Forwarded - Helper Functions
// ============================================================================

const GET_FULL_CALLS_PER_SECOND = 10;
const PROGRESS_EVERY_N_MESSAGES = 50;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function createRateLimiter(callsPerSecond) {
    const minIntervalMs = Math.max(1, Math.floor(1000 / callsPerSecond));
    let nextAllowedAt = 0;
    return async function rateLimitWait() {
        const now = Date.now();
        if (now < nextAllowedAt) {
            await sleep(nextAllowedAt - now);
        }
        nextAllowedAt = Math.max(nextAllowedAt, now) + minIntervalMs;
    };
}

const rateLimitGetFull = createRateLimiter(GET_FULL_CALLS_PER_SECOND);

function normalizeMessageId(raw) {
    if (!raw) return "";
    let value = String(raw).trim();
    if (value.startsWith("<") && value.endsWith(">")) {
        value = value.slice(1, -1).trim();
    }
    return value;
}

function extractMessageIds(headerValue) {
    if (!headerValue) return [];
    const value = String(headerValue);
    const angleBracketMatches = value.match(/<[^>]+>/g);

    let candidates = [];
    if (angleBracketMatches && angleBracketMatches.length) {
        candidates = angleBracketMatches.map((s) => s.trim());
    } else {
        candidates = value.split(/\s+/g).map((s) => s.trim());
    }

    const out = [];
    const seen = new Set();
    for (const candidate of candidates) {
        const normalized = normalizeMessageId(candidate);
        if (!normalized) continue;
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        out.push(normalized);
    }
    return out;
}

function getHeaderValues(getFullResult, headerName) {
    const headers = getFullResult && getFullResult.headers ? getFullResult.headers : null;
    if (!headers) return [];
    const want = String(headerName || "").toLowerCase();
    for (const [name, values] of Object.entries(headers)) {
        if (String(name).toLowerCase() !== want) continue;
        if (Array.isArray(values)) return values.map((v) => String(v));
        return [String(values)];
    }
    return [];
}

function getFirstHeader(getFullResult, headerName) {
    const values = getHeaderValues(getFullResult, headerName);
    return values.length ? values[0] : "";
}

function isForwardSubject(subject) {
    if (!subject) return false;
    return /^\s*(fw|fwd)\s*:/i.test(String(subject));
}

function getMessageDateMs(message) {
    const dateValue = message ? message.date : null;
    if (!dateValue) return null;
    if (typeof dateValue === "number") return dateValue;
    if (dateValue instanceof Date) return dateValue.getTime();
    const parsed = Date.parse(String(dateValue));
    return Number.isFinite(parsed) ? parsed : null;
}

function toFiniteNumber(value, fallback) {
    const n = typeof value === "number" ? value : Number(String(value));
    return Number.isFinite(n) ? n : fallback;
}

async function listFolderMessagesFirstPage(folder, pageSize) {
    try {
        return await messenger.messages.list(folder, { limit: pageSize });
    } catch {
        return await messenger.messages.list(folder);
    }
}

async function* iterateFolderMessages(folder, pageSize = 100) {
    let page = await listFolderMessagesFirstPage(folder, pageSize);
    while (page) {
        const messages = Array.isArray(page.messages) ? page.messages : [];
        for (const msg of messages) yield msg;
        if (!page.id) break;
        page = await messenger.messages.continueList(page.id);
    }
}

async function postProgressUpdate(commandId, processed, total, status) {
    if (!commandId) return;
    try {
        const baseUrl = await getCortexServerUrl();
        await fetch(`${baseUrl}/tbird-sync/progress`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                command_id: commandId,
                processed,
                total,
                status,
            }),
        });
    } catch {
        // Best-effort: don't fail the command if progress reporting fails.
    }
}

async function addTagPreservingExisting(tbMessageId, tag) {
    const msg = await messenger.messages.get(tbMessageId);
    const currentTags = Array.isArray(msg.tags) ? msg.tags : [];
    if (currentTags.includes(tag)) return false;
    const newTags = [...currentTags, tag];
    await messenger.messages.update(tbMessageId, { tags: newTags });
    return true;
}

async function handleBackfillRepliedForwarded(cmd) {
    const daysBack = toFiniteNumber(cmd.days_back, 30);
    const limit = toFiniteNumber(cmd.limit, 500);
    const accountId = cmd.account_id != null ? String(cmd.account_id) : null;
    const commandId = cmd.id || cmd.command_id || null;

    const cutoffMs = Date.now() - Math.max(0, daysBack) * 24 * 60 * 60 * 1000;

    const result = {
        success: true,
        processed: 0,
        replied_tagged: 0,
        forwarded_tagged: 0,
        not_found: 0,
        errors: [],
        replied_tagged_ids: [],
        forwarded_tagged_ids: [],
    };

    const resolvedCache = new Map();
    const repliedTaggedMessageIds = new Set();
    const forwardedTaggedMessageIds = new Set();

    const sentFolders = await messenger.folders.query({ type: "sent" });
    const targetFolders = Array.isArray(sentFolders)
        ? sentFolders.filter((f) => !accountId || String(f.accountId) === accountId)
        : [];

    await postProgressUpdate(commandId, 0, limit, "in_progress");

    outer: for (const folder of targetFolders) {
        let lastDateMs = Infinity;
        let seemsNewestFirst = true;

        for await (const sentMsg of iterateFolderMessages(folder, 100)) {
            if (result.processed >= limit) break outer;

            const dateMs = getMessageDateMs(sentMsg);
            if (dateMs != null) {
                if (dateMs > lastDateMs + 1000) seemsNewestFirst = false;
                lastDateMs = dateMs;
                if (seemsNewestFirst && dateMs < cutoffMs) break;
                if (dateMs < cutoffMs) continue;
            }

            let full;
            try {
                await rateLimitGetFull();
                full = await messenger.messages.getFull(sentMsg.id);
            } catch (e) {
                result.errors.push(`getFull failed for sentMsg.id=${sentMsg.id}: ${String(e)}`);
                continue;
            }

            result.processed += 1;

            const subject = sentMsg.subject || getFirstHeader(full, "subject") || "";
            const inReplyToRaw = getFirstHeader(full, "in-reply-to");
            const referencesRaw = getFirstHeader(full, "references");

            const inReplyToIds = extractMessageIds(inReplyToRaw);
            const referenceIds = extractMessageIds(referencesRaw);

            const replyTargetHeaderId = inReplyToIds.length ? inReplyToIds[0] : "";
            const forwardTargetHeaderId =
                isForwardSubject(subject) && referenceIds.length ? referenceIds[referenceIds.length - 1] : "";

            const maybeTagOriginal = async (targetHeaderId, tag, taggedSet, counterKey, idsArrayKey) => {
                if (!targetHeaderId) return;
                const originalMsg = await findMessageByHeaderId(targetHeaderId, resolvedCache);
                if (!originalMsg) {
                    result.not_found += 1;
                    return;
                }

                if (taggedSet.has(originalMsg.id)) return;
                try {
                    const added = await addTagPreservingExisting(originalMsg.id, tag);
                    taggedSet.add(originalMsg.id);
                    if (added) {
                        result[counterKey] += 1;
                        result[idsArrayKey].push(originalMsg.headerMessageId || targetHeaderId);
                    }
                } catch (e) {
                    result.errors.push(`tagging failed for originalMsg.id=${originalMsg.id} tag=${tag}: ${String(e)}`);
                }
            };

            await maybeTagOriginal(replyTargetHeaderId, "cortex/replied", repliedTaggedMessageIds, "replied_tagged", "replied_tagged_ids");
            await maybeTagOriginal(forwardTargetHeaderId, "cortex/forwarded", forwardedTaggedMessageIds, "forwarded_tagged", "forwarded_tagged_ids");

            if (result.processed % PROGRESS_EVERY_N_MESSAGES === 0) {
                await postProgressUpdate(commandId, result.processed, limit, "in_progress");
            }
        }
    }

    await postProgressUpdate(commandId, result.processed, limit, "completed");
    return result;
}

async function handleSetTags(cmd) {
    const messageId = cmd.messageId || cmd.message_id;
    const tags = Array.isArray(cmd.tags) ? cmd.tags : [];
    const mode = cmd.mode || "add";

    const msg = await findMessageByHeaderId(messageId);
    if (!msg) {
        return { success: false, error: `Message not found: ${messageId}` };
    }

    const currentTags = Array.isArray(msg.tags) ? msg.tags : [];
    let newTags;

    if (mode === "add") {
        newTags = [...new Set([...currentTags, ...tags])];
    } else if (mode === "remove") {
        newTags = currentTags.filter(t => !tags.includes(t));
    } else if (mode === "replace") {
        newTags = tags;
    } else {
        return { success: false, error: `Unknown mode: ${mode}` };
    }

    await messenger.messages.update(msg.id, { tags: newTags });
    return { success: true, action: "set_tags", messageId, tags: newTags };
}

// ============================================================================

/**
 * Process a single command
 */
async function processCommand(cmd) {
    switch (cmd.action) {
        case "mark_read":
            return await markAsRead(cmd.messageId);
        case "mark_unread":
            return await markAsUnread(cmd.messageId);
        case "set_flagged":
            return await setFlagged(cmd.messageId, cmd.flagged !== false);
        case "open_message":
            return await openMessage(cmd.messageId);
        // Batch operations
        case "archive":
            return await archiveMessages(cmd.messageIds || [cmd.messageId]);
        case "move":
            return await moveMessages(cmd.messageIds || [cmd.messageId], cmd.folder);
        case "bulk_mark_read":
            return await bulkMarkRead(cmd.messageIds || [cmd.messageId]);
        // Compose operations
        case "create_draft":
            return await createReplyDraft(cmd.messageId, cmd.body || "", cmd.replyAll === true);
        case "send_reply":
            return await sendReply(cmd.messageId, cmd.body || "", cmd.replyAll === true);
        // Status queries (get live status from Thunderbird)
        case "get_status":
            return await getMessageStatus(cmd.messageId);
        case "bulk_get_status":
            return await bulkGetStatus(cmd.messageIds || [cmd.messageId]);
        // Discovery
        case "list_folders":
            return await listFolders();
        // Generic RPC executor (allowlisted)
        case "rpc":
            return await executeRpcCommand(cmd);
        // Backfill replied/forwarded from Sent folder
        case "backfill_replied_forwarded":
            return await handleBackfillRepliedForwarded(cmd);
        // Tag management
        case "set_tags":
            return await handleSetTags(cmd);
        default:
            return { success: false, error: "Unknown action: " + cmd.action };
    }
}

/**
 * Poll cortex_server for pending commands
 */
async function pollForCommands() {
    if (isPolling) return;
    isPolling = true;

    try {
        const baseUrl = await getCortexServerUrl();
        const response = await fetch(`${baseUrl}/tbird-sync/pending`, {
            method: "GET",
            headers: { "Accept": "application/json" }
        });

        if (!response.ok) {
            return;
        }

        const data = await response.json();
        const commands = data.commands || [];

        if (commands.length === 0) {
            return;
        }

        console.log(`Processing ${commands.length} sync commands`);

        const results = [];
        for (const cmd of commands) {
            const result = await processCommand(cmd);
            result.id = cmd.id;
            results.push(result);
        }

        const baseUrl2 = await getCortexServerUrl();
        await fetch(`${baseUrl2}/tbird-sync/complete`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ results })
        });

    } catch (error) {
        // Server not running - silent fail
    } finally {
        isPolling = false;
    }
}

initEventPush().catch(() => {});
safeAddListener(messenger.browserAction && messenger.browserAction.onClicked, () => {
    handleToolbarClick();
});
setInterval(pollForCommands, POLL_INTERVAL_MS);
pollForCommands();

console.log(
    `Cortex1 Thunderbird Sync v${getExtensionVersion()} loaded - polling every ${(POLL_INTERVAL_MS/1000)}s`
);
