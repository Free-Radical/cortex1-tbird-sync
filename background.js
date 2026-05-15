/**
 * Cortex1 Thunderbird Sync - Background Script
 *
 * Polls cortex_server for pending sync commands and executes them.
 * No native messaging required - just install the .xpi.
 */

const DEFAULT_CORTEX_SERVER = "http://127.0.0.1:5001";
const CORTEX_SERVER_STORAGE_KEY = "cortex_server_url";
const CLIENT_ID_STORAGE_KEY = "cortex_tbird_sync_client_id_v1";
// HTTP polling removed — WebSocket is the sole IPC transport.
// POLL_INTERVAL_MS retained only for completion-flush retry cadence.
const POLL_INTERVAL_MS = 3000;

// =============================================================================
// WebSocket Connection (preferred transport)
// =============================================================================

let ws = null;
let wsReconnectAttempts = 0;
let wsReconnectTimer = null;
const WS_MAX_RECONNECT_DELAY = 30000; // 30s max
const WS_BASE_DELAY = 1000; // 1s base

// Optional: direct HTTP push of Thunderbird events to cortex_server
const EVENT_PUSH_PATH = "/tbird-sync/events";
const EVENT_PUSH_ENABLED_KEY = "cortex_event_push_enabled";
const EVENT_QUEUE_KEY = "cortex_event_queue_v1";
const EVENT_QUEUE_META_KEY = "cortex_event_queue_meta_v1";
const EVENT_QUEUE_LIMIT = 2000;
const EVENT_BATCH_SIZE = 50;
const EVENT_FLUSH_INTERVAL_MS = 2000;
const EVENT_POST_TIMEOUT_MS = 5000;

let isFlushingEvents = false;

let cachedCortexServerUrl = null;
let hasLoadedCortexServerUrl = false;
let cachedClientId = null;

function normalizeLoopbackServerUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) return DEFAULT_CORTEX_SERVER;
    try {
        const parsed = new URL(raw);
        if (parsed.hostname === "localhost") {
            parsed.hostname = "127.0.0.1";
            return parsed.toString().replace(/\/$/, "");
        }
        return parsed.toString().replace(/\/$/, "");
    } catch (error) {
        return raw.replace(/^http:\/\/localhost(?=[:/]|$)/i, "http://127.0.0.1")
            .replace(/^https:\/\/localhost(?=[:/]|$)/i, "https://127.0.0.1")
            .replace(/\/$/, "");
    }
}

// =============================================================================
// Debug Logging + Failure Tracking
// =============================================================================

const DEBUG_MAX_ENTRIES = 100;  // Keep only last 100 log entries total across all runs
const FAILURE_MAX_ENTRIES = 50;
const FAILURE_STORAGE_KEY = "cortex_recent_failures";
const DIAGNOSTICS_SCHEMA_VERSION = 1;
const IS_TEST_MODE = typeof globalThis !== "undefined" && !!globalThis.CORTEX_TEST_MODE;

function shouldRecordFailure(category, message, data) {
    if (data && data.error != null) return true;
    const msg = String(message || "").toLowerCase();
    if (!msg) return false;
    return (
        msg.includes("error") ||
        msg.includes("fail") ||
        msg.includes("exception") ||
        msg.includes("timeout")
    );
}

const FailureTracker = {
    failures: [],

    async init() {
        try {
            const stored = await messenger.storage.local.get([FAILURE_STORAGE_KEY]);
            const entries = stored && stored[FAILURE_STORAGE_KEY];
            this.failures = Array.isArray(entries) ? entries : [];
        } catch (error) {
            this.failures = [];
        }
    },

    record(category, message, data = null) {
        const ts = new Date().toISOString();
        const entry = { ts, cat: category, msg: message, data };
        this.failures.push(entry);
        while (this.failures.length > FAILURE_MAX_ENTRIES) {
            this.failures.shift();
        }
        messenger.storage.local.set({ [FAILURE_STORAGE_KEY]: this.failures }).catch(() => {});
    },

    getFailures() {
        return this.failures;
    },

    clear() {
        this.failures = [];
        messenger.storage.local.set({ [FAILURE_STORAGE_KEY]: [] }).catch(() => {});
    }
};

const DebugLogger = {
    enabled: false,
    logs: [],  // Single array of all logs (max 5)

    async init() {
        try {
            const stored = await messenger.storage.local.get(["cortex_debug_enabled", "cortex_debug_logs"]);
            this.enabled = stored.cortex_debug_enabled === true;
            // Restore logs from storage (persisted across restarts)
            this.logs = Array.isArray(stored.cortex_debug_logs) ? stored.cortex_debug_logs : [];
        } catch (e) {
            this.enabled = false;
            this.logs = [];
        }
    },

    log(category, message, data = null) {
        const ts = new Date().toISOString().substring(11, 23);  // HH:MM:SS.mmm
        const entry = { ts, cat: category, msg: message, data };

        // Add to buffer
        this.logs.push(entry);
        if (shouldRecordFailure(category, message, data)) {
            FailureTracker.record(category, message, data);
        }

        // Keep only last 5 entries (flush old ones)
        while (this.logs.length > DEBUG_MAX_ENTRIES) {
            this.logs.shift();  // Remove oldest
        }

        // Persist to storage (survives restarts)
        messenger.storage.local.set({ cortex_debug_logs: this.logs }).catch(() => {});

        // Print to console if enabled
        if (this.enabled) {
            const dataStr = data ? ` | ${JSON.stringify(data)}` : "";
            console.log(`[DEBUG:${category}] ${ts} ${message}${dataStr}`);
        }
    },

    getLogs() {
        return this.logs;
    },

    clear() {
        this.logs = [];
        messenger.storage.local.set({ cortex_debug_logs: [] }).catch(() => {});
    },

    toggle() {
        this.enabled = !this.enabled;
        messenger.storage.local.set({ cortex_debug_enabled: this.enabled });
        this.log("debug", `Debug console output ${this.enabled ? "enabled" : "disabled"}`);
        return this.enabled;
    }
};

// Initialize debug logger
DebugLogger.init();
FailureTracker.init();

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

function createClientId() {
    try {
        if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
            return `tbird-sync-${globalThis.crypto.randomUUID()}`;
        }
    } catch (error) {
        // Fall through to timestamp/random fallback below.
    }
    const rand = Math.random().toString(36).slice(2, 12);
    return `tbird-sync-${Date.now().toString(36)}-${rand}`;
}

async function getExtensionClientId() {
    if (cachedClientId) return cachedClientId;
    try {
        const stored = await messenger.storage.local.get(CLIENT_ID_STORAGE_KEY);
        const value = stored && stored[CLIENT_ID_STORAGE_KEY];
        if (typeof value === "string" && value.trim()) {
            cachedClientId = value.trim();
            return cachedClientId;
        }
    } catch (error) {
        // Storage can fail in restricted/test contexts; still provide a live-session id.
    }

    cachedClientId = createClientId();
    try {
        await messenger.storage.local.set({ [CLIENT_ID_STORAGE_KEY]: cachedClientId });
    } catch (error) {
        // Best effort only. The in-memory id still identifies this connection.
    }
    return cachedClientId;
}

async function getCortexServerUrl() {
    if (hasLoadedCortexServerUrl) {
        return normalizeLoopbackServerUrl(cachedCortexServerUrl || DEFAULT_CORTEX_SERVER);
    }

    try {
        const stored = await messenger.storage.local.get(CORTEX_SERVER_STORAGE_KEY);
        const value = stored && stored[CORTEX_SERVER_STORAGE_KEY];
        cachedCortexServerUrl = normalizeLoopbackServerUrl(
            (typeof value === "string" && value.trim()) ? value.trim() : DEFAULT_CORTEX_SERVER
        );
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

function normalizeDiagnosticsFormat(value) {
    const fmt = String(value || "").toLowerCase();
    if (fmt === "jsonl" || fmt === "ndjson") return "jsonl";
    return "json";
}

function buildDiagnosticsFilename(format) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const ext = format === "jsonl" ? "jsonl" : "json";
    return `cortex1-diagnostics-${ts}.${ext}`;
}

function buildDiagnosticsMeta(payload) {
    return {
        schemaVersion: payload.schemaVersion,
        generatedAt: payload.generatedAt,
        extensionVersion: payload.extensionVersion,
        serverUrl: payload.serverUrl,
        eventPushEnabled: payload.eventPushEnabled,
        connectionState: payload.connectionState,
        transport: payload.transport,
        debugEnabled: payload.debug.enabled,
        logCount: payload.debug.logs.length,
        failureCount: payload.recentFailures.length,
        eventQueue: payload.eventQueue
    };
}

async function buildDiagnosticsPayload() {
    const logs = DebugLogger.getLogs().map(entry => ({ ...entry }));
    const failures = FailureTracker.getFailures().map(entry => ({ ...entry }));
    const queueMeta = eventQueueMeta || {};

    return {
        schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
        generatedAt: new Date().toISOString(),
        extensionVersion: getExtensionVersion(),
        serverUrl: await getCortexServerUrl(),
        eventPushEnabled: await isEventPushEnabled(),
        connectionState,
        transport: "websocket",
        debug: {
            enabled: DebugLogger.enabled,
            logs
        },
        recentFailures: failures,
        eventQueue: {
            queued: eventQueue ? eventQueue.length : 0,
            dropped: queueMeta.dropped || 0,
            failures: queueMeta.failures || 0,
            backoffMs: queueMeta.backoffMs || 0,
            nextAttemptAtMs: queueMeta.nextAttemptAtMs || 0
        }
    };
}

function diagnosticsToJsonl(payload) {
    const meta = buildDiagnosticsMeta(payload);
    const lines = [JSON.stringify({ type: "meta", ...meta })];
    for (const log of payload.debug.logs) {
        lines.push(JSON.stringify({ type: "log", ...log }));
    }
    for (const failure of payload.recentFailures) {
        lines.push(JSON.stringify({ type: "failure", ...failure }));
    }
    return lines.join("\n");
}

async function exportDiagnostics(options = {}) {
    const format = normalizeDiagnosticsFormat(options.format);
    const saveAs = options.saveAs !== false;
    const payload = await buildDiagnosticsPayload();
    const filename = buildDiagnosticsFilename(format);
    const mime = format === "jsonl" ? "application/x-ndjson" : "application/json";
    const body = format === "jsonl"
        ? diagnosticsToJsonl(payload)
        : JSON.stringify(payload, null, 2);
    const url = `data:${mime};charset=utf-8,${encodeURIComponent(body)}`;

    if (!messenger.downloads || typeof messenger.downloads.download !== "function") {
        const error = "downloads API not available";
        DebugLogger.log("diagnostics", "Export diagnostics failed", { error });
        return { success: false, action: "export_diagnostics", error };
    }

    try {
        const downloadId = await messenger.downloads.download({ url, filename, saveAs });
        return {
            success: true,
            action: "export_diagnostics",
            format,
            filename,
            downloadId
        };
    } catch (error) {
        const message = error && error.message ? error.message : String(error);
        DebugLogger.log("diagnostics", "Export diagnostics download failed", { error: message });
        return { success: false, action: "export_diagnostics", error: message };
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
        tags: message.tags,
        folder: message.folder ? minifyFolder(message.folder) : null
    };
}

function minifyFolder(folder) {
    if (!folder) return null;
    return {
        accountId: folder.accountId,
        path: folder.path,
        name: folder.name,
        type: folder.type,
        specialUse: Array.isArray(folder.specialUse) ? folder.specialUse : [],
        isFavorite: folder.isFavorite || false,
        isRoot: folder.isRoot || false
    };
}

const TBIRD_SYNC_STATE_AUDIT_SCHEMA_VERSION = "1.0";

const TBIRD_MESSAGE_HEADER_FIELDS = [
    "author",
    "bccList",
    "ccList",
    "date",
    "external",
    "flagged",
    "folder",
    "headerMessageId",
    "headersOnly",
    "id",
    "junk",
    "junkScore",
    "new",
    "priority",
    "recipients",
    "read",
    "size",
    "subject",
    "tags"
];

const TBIRD_MESSAGE_PART_FIELDS = [
    "body",
    "contentType",
    "decryptionStatus",
    "headers",
    "name",
    "partName",
    "parts",
    "rawBody",
    "rawHeaders",
    "size"
];

const TBIRD_ATTACHMENT_FIELDS = [
    "contentDisposition",
    "contentType",
    "headers",
    "name",
    "partName",
    "size",
    "contentId",
    "message"
];

const TBIRD_FOLDER_FIELDS = [
    "path",
    "accountId",
    "id",
    "isFavorite",
    "isRoot",
    "isTag",
    "isUnified",
    "isVirtual",
    "name",
    "specialUse",
    "subFolders",
    "type"
];

const TBIRD_FOLDER_INFO_FIELDS = [
    "favorite",
    "lastUsed",
    "lastUsedAsDestination",
    "newMessageCount",
    "quota",
    "totalMessageCount",
    "unreadMessageCount"
];

const TBIRD_FOLDER_CAPABILITY_FIELDS = [
    "canAddMessages",
    "canAddSubfolders",
    "canBeDeleted",
    "canBeRenamed",
    "canDeleteMessages"
];

const TBIRD_NOT_BIDIRECTIONALLY_SYNCED_ATTRIBUTES = [
    {
        surface: "MessageHeader",
        attributes: ["id", "external", "headersOnly", "junkScore", "new", "priority", "recipients", "ccList", "bccList", "size"],
        exposed_by_audit: true,
        synced_bidirectionally: false,
        reason: "These fields are read-only metadata or unstable locators. They are exposed for inspection but not written back as canonical C1-owned state."
    },
    {
        surface: "MailFolder",
        attributes: ["id", "isTag", "isUnified", "isVirtual", "subFolders"],
        exposed_by_audit: true,
        synced_bidirectionally: false,
        reason: "Folder metadata is exposed for inspection. Folder moves/archives/deletes are command paths, but folder-tree metadata is not treated as mutable message state."
    },
    {
        surface: "MailFolderInfo",
        attributes: TBIRD_FOLDER_INFO_FIELDS,
        exposed_by_audit: true,
        synced_bidirectionally: false,
        reason: "Folder counts, last-used timestamps, and quota are Thunderbird/provider-derived diagnostics."
    },
    {
        surface: "MailFolderCapabilities",
        attributes: TBIRD_FOLDER_CAPABILITY_FIELDS,
        exposed_by_audit: true,
        synced_bidirectionally: false,
        reason: "Capabilities describe what Thunderbird says the folder can do; they are not message state."
    },
    {
        surface: "MessagePart/getFull",
        attributes: TBIRD_MESSAGE_PART_FIELDS,
        exposed_by_audit: true,
        synced_bidirectionally: false,
        reason: "The full MIME tree is exposed for inspection. tbird-sync does not mutate arbitrary MIME parts."
    },
    {
        surface: "MessageAttachment",
        attributes: TBIRD_ATTACHMENT_FIELDS,
        exposed_by_audit: true,
        synced_bidirectionally: false,
        reason: "Attachment metadata is exposed when Thunderbird APIs provide it. Attachment bytes/download lifecycle are not synced."
    },
    {
        surface: "headers",
        attributes: ["all RFC/message headers from getFull/getHeaders/getRaw"],
        exposed_by_audit: true,
        synced_bidirectionally: false,
        reason: "Headers are exposed for inspection, but tbird-sync only normalizes selected state fields."
    },
    {
        surface: "native replied/forwarded/thread/security state",
        attributes: ["native replied flag", "native forwarded flag", "threadId", "conversation id", "authentication verdict", "signature verification", "encryption verification"],
        exposed_by_audit: false,
        synced_bidirectionally: false,
        reason: "These are not exposed as complete mutable state by the current Thunderbird WebExtension message APIs used by tbird-sync."
    }
];

const TBIRD_SYNC_STATE_CAPABILITIES = {
    canonical_state_fields: [
        "read",
        "flagged",
        "junk",
        "tags",
        "folder.accountId",
        "folder.path",
        "folder.name",
        "folder.type",
        "folder.specialUse",
        "folder.isFavorite",
        "folder.isRoot",
        "date",
        "subject",
        "author",
        "headerMessageId",
        "size",
        "stateReadAt"
    ],
    header_fields_exposed: TBIRD_MESSAGE_HEADER_FIELDS,
    message_part_fields_exposed: TBIRD_MESSAGE_PART_FIELDS,
    attachment_fields_exposed: TBIRD_ATTACHMENT_FIELDS,
    folder_fields_exposed: TBIRD_FOLDER_FIELDS,
    folder_info_fields_exposed: TBIRD_FOLDER_INFO_FIELDS,
    folder_capability_fields_exposed: TBIRD_FOLDER_CAPABILITY_FIELDS,
    writable_commands: [
        "mark_read",
        "mark_unread",
        "set_flagged",
        "set_junk",
        "set_tags",
        "archive",
        "move",
        "delete",
        "bulk_mark_read",
        "cortex.messages.updateByHeaderId",
        "cortex.messages.archiveByHeaderId",
        "cortex.messages.moveByHeaderId",
        "cortex.messages.copyByHeaderId",
        "cortex.messages.deleteByHeaderId"
    ],
    query_commands: [
        "get_status",
        "bulk_get_status",
        "sync_state",
        "bulk_sync_state",
        "cortex.findMessageByHeaderId",
        "cortex.messages.getFullByHeaderId",
        "cortex.messages.getRawByHeaderId",
        "cortex.messages.getStateAuditByHeaderId",
        "messages.query",
        "folders.query",
        "messages.tags.list"
    ],
    event_sources: [
        "messages.onNewMailReceived",
        "messages.onUpdated",
        "messages.onMoved",
        "messages.onCopied",
        "messages.onDeleted",
        "messages.tags.onCreated",
        "messages.tags.onUpdated",
        "messages.tags.onDeleted",
        "folders.onFolderInfoChanged",
        "folders.onCreated",
        "folders.onRenamed",
        "folders.onMoved",
        "folders.onDeleted",
        "compose.onBeforeSend",
        "compose.onAfterSend",
        "compose.onAfterSave"
    ],
    unsupported_or_partial: [
        {
            field: "replied/forwarded native flags",
            status: "partial",
            reason: "Thunderbird WebExtension MessageHeader/MessageProperties do not expose native replied or forwarded flags. tbird-sync uses compose events and sent-folder/header inference where available."
        },
        {
            field: "attachments",
            status: "metadata-only",
            reason: "getFull may expose MIME parts; tbird-sync reports a best-effort attachment manifest but does not sync attachment bytes or download state."
        },
        {
            field: "calendar/ICS state",
            status: "metadata-only",
            reason: "Calendar invites may appear as MIME parts such as text/calendar, but no calendar acceptance or provider state is synced."
        },
        {
            field: "thread id/conversation state",
            status: "unsupported",
            reason: "Thunderbird WebExtension messages API does not expose a stable threadId or thread API."
        },
        {
            field: "security/authentication/crypto state",
            status: "unsupported",
            reason: "Message authentication results, encryption/signature verification state, and provider security verdicts are not normalized by tbird-sync."
        },
        {
            field: "all raw headers",
            status: "available-via-getFull-or-getRaw",
            reason: "Headers can be inspected through getFull/getRaw, but tbird-sync does not normalize every header into canonical state."
        },
        {
            field: "message id conflict resolution",
            status: "partial",
            reason: "headerMessageId is the durable locator; duplicate/missing Message-ID and move/restart internal-id changes are not fully conflict-modeled."
        }
    ]
};

/**
 * Build the normalized Thunderbird state subset that cortex treats as canonical.
 * Use getStateAuditByHeaderId for the broader capability/unsupported-property report.
 */
function buildTbState(message) {
    if (!message) return null;

    return {
        // Message state
        read: message.read,
        flagged: message.flagged,
        junk: message.junk || false,
        tags: Array.isArray(message.tags) ? message.tags : [],

        // Folder info
        folder: message.folder ? {
            accountId: message.folder.accountId || null,
            path: message.folder.path || "",
            name: message.folder.name || "",
            type: message.folder.type || null,
            specialUse: Array.isArray(message.folder.specialUse)
                ? message.folder.specialUse
                : [],
            isFavorite: message.folder.isFavorite || false,
            isRoot: message.folder.isRoot || false,
        } : null,

        // Message metadata
        date: message.date,
        subject: message.subject,
        author: message.author,
        headerMessageId: message.headerMessageId,
        size: message.size || null,

        // Timestamp when state was read
        stateReadAt: new Date().toISOString()
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
    if (IS_TEST_MODE) {
        messenger.storage.local.set({
            [EVENT_QUEUE_KEY]: eventQueue || [],
            [EVENT_QUEUE_META_KEY]: eventQueueMeta || {}
        }).catch(() => {});
        return;
    }
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
    if (IS_TEST_MODE) {
        flushEventQueue();
        return;
    }
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
    if (sendWebSocketMessage({ type: "event", event: { events }, data: { events } })) {
        console.log("[WS] Sent event batch", { count: events.length });
        return true;
    }

    // WS not open — caller's retry logic will handle re-attempt
    DebugLogger.log("event", "WS not open, cannot send event batch", { count: events.length });
    return false;
}

async function flushEventQueue() {
    if (isFlushingEvents) return;
    isFlushingEvents = true;
    try {
        if (!(await isEventPushEnabled())) return;

        await ensureEventQueueLoaded();

        if (!eventQueue.length) return;

        const now = Date.now();
        if (eventQueueMeta.nextAttemptAtMs && now < eventQueueMeta.nextAttemptAtMs) return;

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

function safeAddListener(eventObj, handler, ...listenerArgs) {
    try {
        if (eventObj && typeof eventObj.addListener === "function") {
            eventObj.addListener(handler, ...listenerArgs);
        }
    } catch (error) {
        // best-effort; avoid breaking startup on older TB versions
    }
}

function registerDiagnosticsMenu() {
    if (!messenger.menus || typeof messenger.menus.create !== "function") return;
    try {
        messenger.menus.create({
            id: "export-diagnostics",
            title: "Export Diagnostics",
            contexts: ["browser_action"]
        });
    } catch (error) {
        DebugLogger.log("diagnostics", "Menu create failed", { error: String(error) });
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
    }, true);

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
async function findMessageByHeaderId(messageId, resolvedCache = null) {
    let cleanId = messageId.trim();
    if (cleanId.startsWith("<")) cleanId = cleanId.slice(1);
    if (cleanId.endsWith(">")) cleanId = cleanId.slice(0, -1);

    // Check cache first if provided
    if (resolvedCache && resolvedCache.has(cleanId)) {
        return resolvedCache.get(cleanId);
    }

    try {
        const result = await messenger.messages.query({
            headerMessageId: cleanId
        });
        const msg = result.messages && result.messages.length > 0 ? result.messages[0] : null;
        if (resolvedCache && msg) {
            resolvedCache.set(cleanId, msg);
        }
        return msg;
    } catch (error) {
        DebugLogger.log("find", `Error finding message: ${error.message}`, { messageId: cleanId });
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
        // Re-fetch message to get updated state
        const updatedMessage = await messenger.messages.get(message.id);
        return { success: true, messageId, action: "mark_read", tb_state: buildTbState(updatedMessage) };
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
        // Re-fetch message to get updated state
        const updatedMessage = await messenger.messages.get(message.id);
        return { success: true, messageId, action: "mark_unread", tb_state: buildTbState(updatedMessage) };
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
        // Re-fetch message to get updated state
        const updatedMessage = await messenger.messages.get(message.id);
        return { success: true, messageId, action: "set_flagged", flagged, tb_state: buildTbState(updatedMessage) };
    } catch (error) {
        return { success: false, error: error.message, messageId };
    }
}

/**
 * Set junk status
 */
async function setJunk(messageId, junk) {
    const message = await findMessageByHeaderId(messageId);
    if (!message) {
        return { success: false, error: "Message not found", messageId };
    }
    try {
        await messenger.messages.update(message.id, { junk: junk });
        // Re-fetch message to get updated state
        const updatedMessage = await messenger.messages.get(message.id);
        return { success: true, messageId, action: "set_junk", junk, tb_state: buildTbState(updatedMessage) };
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
        // Re-fetch message to get current state (opening may mark as read)
        const updatedMessage = await messenger.messages.get(message.id);
        return { success: true, messageId, action: "open_message", tb_state: buildTbState(updatedMessage) };
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
    const tbIdToHeaderId = new Map();

    // Resolve all message IDs to Thunderbird internal IDs
    for (const msgId of messageIds) {
        const message = await findMessageByHeaderId(msgId);
        if (message) {
            tbIds.push(message.id);
            tbIdToHeaderId.set(message.id, msgId);
            results.success.push(msgId);
        } else {
            results.failed.push({ messageId: msgId, error: "Message not found" });
        }
    }

    const tbStates = [];

    if (tbIds.length > 0) {
        try {
            await messenger.messages.archive(tbIds);
            // Fetch updated state for each archived message
            for (const tbId of tbIds) {
                try {
                    const updatedMessage = await messenger.messages.get(tbId);
                    tbStates.push({
                        messageId: tbIdToHeaderId.get(tbId),
                        tb_state: buildTbState(updatedMessage)
                    });
                } catch (e) {
                    // Message may have been moved, still include with null state
                    tbStates.push({
                        messageId: tbIdToHeaderId.get(tbId),
                        tb_state: null
                    });
                }
            }
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
        count: results.success.length,
        tb_states: tbStates
    };
}

/**
 * Delete messages by Message-ID header (batch support).
 *
 * By default this uses Thunderbird's normal delete behavior and moves messages
 * to Trash. `skipTrash=true` is reserved for explicit RPC/permanent-delete
 * callers and should not be used by the normal c1server triage queue.
 */
async function deleteMessages(messageIds, skipTrash = false) {
    const results = { success: [], failed: [] };
    const tbIds = [];
    const tbIdToHeaderId = new Map();

    for (const msgId of messageIds) {
        const message = await findMessageByHeaderId(msgId);
        if (message) {
            tbIds.push(message.id);
            tbIdToHeaderId.set(message.id, msgId);
            results.success.push(msgId);
        } else {
            results.failed.push({ messageId: msgId, error: "Message not found" });
        }
    }

    const tbStates = [];

    if (tbIds.length > 0) {
        try {
            await messenger.messages.delete(tbIds, skipTrash === true);
            for (const tbId of tbIds) {
                tbStates.push({
                    messageId: tbIdToHeaderId.get(tbId),
                    tb_state: null
                });
            }
        } catch (error) {
            results.failed.push(...results.success.map(id => ({ messageId: id, error: error.message })));
            results.success = [];
            tbStates.length = 0;
        }
    }

    return {
        success: results.failed.length === 0,
        action: "delete",
        deleted: results.success,
        failed: results.failed,
        count: results.success.length,
        skipTrash: skipTrash === true,
        tb_states: tbStates
    };
}

function buildAuditedMessageHeader(message) {
    if (!message) return null;
    const out = minifyMessageHeader(message) || {};
    out.junkScore = message.junkScore != null ? message.junkScore : null;
    out.new = message.new === true;
    out.size = message.size || null;
    return out;
}

function safeAuditValue(value, seen = new WeakSet()) {
    if (value === undefined) return null;
    if (value === null) return null;
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map((item) => safeAuditValue(item, seen));

    if (typeof value === "object") {
        if (seen.has(value)) return "[Circular]";
        seen.add(value);

        const out = {};
        for (const key of Object.keys(value)) {
            const item = value[key];
            if (typeof item === "function") continue;
            out[key] = safeAuditValue(item, seen);
        }
        seen.delete(value);
        return out;
    }

    if (typeof value === "bigint") return value.toString();
    if (typeof value === "function") return null;
    return value;
}

function listMissingFields(source, expectedFields) {
    const object = source && typeof source === "object" ? source : {};
    return expectedFields.filter((field) => !Object.prototype.hasOwnProperty.call(object, field));
}

function collectPartFieldNames(part, names = new Set()) {
    if (!part || typeof part !== "object") return names;
    Object.keys(part).forEach((key) => names.add(key));
    const children = Array.isArray(part.parts) ? part.parts : [];
    children.forEach((child) => collectPartFieldNames(child, names));
    return names;
}

async function callAuditApi(apiName, fn, ...args) {
    if (typeof fn !== "function") {
        return {
            api: apiName,
            available: false,
            error: "api not available",
            value: null
        };
    }

    try {
        const value = await fn(...args);
        return {
            api: apiName,
            available: value != null,
            error: null,
            value: safeAuditValue(value)
        };
    } catch (error) {
        return {
            api: apiName,
            available: false,
            error: error && error.message ? error.message : String(error),
            value: null
        };
    }
}

function getPartHeaderValues(part, headerName) {
    const headers = part && part.headers ? part.headers : null;
    if (!headers) return [];
    const want = String(headerName || "").toLowerCase();
    for (const [name, values] of Object.entries(headers)) {
        if (String(name).toLowerCase() !== want) continue;
        if (Array.isArray(values)) return values.map((v) => String(v));
        return [String(values)];
    }
    return [];
}

function getPartFirstHeader(part, headerName) {
    const values = getPartHeaderValues(part, headerName);
    return values.length ? values[0] : "";
}

function collectHeaderNames(full) {
    const headers = full && full.headers && typeof full.headers === "object" ? full.headers : {};
    return Object.keys(headers).map((name) => String(name).toLowerCase()).sort();
}

function buildAttachmentManifestFromFull(full) {
    const attachments = [];

    const visit = (part, path) => {
        if (!part || typeof part !== "object") return;
        const contentType = String(part.contentType || part.content_type || "").toLowerCase();
        const contentDisposition = getPartFirstHeader(part, "content-disposition").toLowerCase();
        const contentTypeHeader = getPartFirstHeader(part, "content-type");
        const name = part.name || part.filename || part.fileName || "";
        const partName = part.partName || part.name || path;
        const isMultipart = contentType.startsWith("multipart/");
        const looksAttached =
            contentDisposition.includes("attachment") ||
            /;\s*filename=/i.test(contentDisposition) ||
            /;\s*name=/i.test(contentTypeHeader) ||
            Boolean(name);

        if (!isMultipart && looksAttached) {
            attachments.push({
                partName,
                path,
                name: name || null,
                contentType: contentType || null,
                size: Number.isFinite(Number(part.size)) ? Number(part.size) : null,
                disposition: contentDisposition || null,
                isCalendar: contentType === "text/calendar" || /\.ics$/i.test(String(name || "")),
                contentAvailableViaGetFull: typeof part.body === "string"
            });
        }

        const children = Array.isArray(part.parts) ? part.parts : [];
        children.forEach((child, idx) => visit(child, path ? `${path}.${idx + 1}` : String(idx + 1)));
    };

    visit(full, "");
    return attachments;
}

async function getStateAuditByHeaderId(headerMessageId) {
    const message = await findMessageByHeaderId(headerMessageId);
    if (!message) throw new Error("Message not found");

    let full = null;
    let fullError = null;
    try {
        full = await messenger.messages.getFull(message.id);
    } catch (error) {
        fullError = error && error.message ? error.message : String(error);
    }

    const attachmentManifest = full ? buildAttachmentManifestFromFull(full) : [];
    const headerNames = full ? collectHeaderNames(full) : [];
    const folder = message.folder || null;
    const headers = await callAuditApi(
        "messages.getHeaders",
        messenger.messages && messenger.messages.getHeaders,
        message.id
    );
    const attachments = await callAuditApi(
        "messages.listAttachments",
        messenger.messages && messenger.messages.listAttachments,
        message.id
    );
    const folderInfo = await callAuditApi(
        "folders.getFolderInfo",
        messenger.folders && messenger.folders.getFolderInfo,
        folder
    );
    const folderCapabilities = await callAuditApi(
        "folders.getCapabilities",
        messenger.folders && messenger.folders.getCapabilities,
        folder
    );
    const fullPartFields = Array.from(collectPartFieldNames(full)).sort();

    return {
        schema_version: TBIRD_SYNC_STATE_AUDIT_SCHEMA_VERSION,
        extension_version: getExtensionVersion(),
        headerMessageId,
        messageId: message.id,
        locator: {
            durable: "headerMessageId",
            internalMessageId: message.id,
            internalMessageIdStable: false,
            caveats: [
                "Thunderbird internal message ids can change after moves, imports, or profile rebuilds.",
                "Duplicate or missing RFC Message-ID values require caller-side conflict handling."
            ]
        },
        capabilities: TBIRD_SYNC_STATE_CAPABILITIES,
        message_header: buildAuditedMessageHeader(message),
        raw_message_header: safeAuditValue(message),
        raw_folder: safeAuditValue(folder),
        tb_state: buildTbState(message),
        full: {
            available: Boolean(full),
            error: fullError,
            header_names: headerNames,
            has_body: Boolean(full && typeof full.body === "string"),
            has_parts: Boolean(full && Array.isArray(full.parts) && full.parts.length > 0)
        },
        full_message_part: safeAuditValue(full),
        headers: {
            ...headers,
            names: headers.value && typeof headers.value === "object"
                ? Object.keys(headers.value).map((name) => String(name).toLowerCase()).sort()
                : []
        },
        attachments: {
            ...attachments,
            manifest_from_getFull: attachmentManifest
        },
        folder_info: folderInfo,
        folder_capabilities: folderCapabilities,
        attachments_manifest: attachmentManifest,
        calendar_manifest: attachmentManifest.filter((part) => part.isCalendar),
        unsupported_properties: TBIRD_SYNC_STATE_CAPABILITIES.unsupported_or_partial,
        missing_or_not_synced_attributes: {
            missing_from_message_header_api: listMissingFields(message, TBIRD_MESSAGE_HEADER_FIELDS),
            missing_from_folder_api: folder ? listMissingFields(folder, TBIRD_FOLDER_FIELDS) : TBIRD_FOLDER_FIELDS,
            missing_from_full_api: full ? listMissingFields(full, TBIRD_MESSAGE_PART_FIELDS) : TBIRD_MESSAGE_PART_FIELDS,
            message_part_fields_seen: fullPartFields,
            missing_from_getHeaders_api: headers.available ? [] : ["messages.getHeaders"],
            missing_from_listAttachments_api: attachments.available ? [] : ["messages.listAttachments"],
            missing_from_getFolderInfo_api: folderInfo.available ? [] : ["folders.getFolderInfo"],
            missing_from_getCapabilities_api: folderCapabilities.available ? [] : ["folders.getCapabilities"],
            not_bidirectionally_synced: TBIRD_NOT_BIDIRECTIONALLY_SYNCED_ATTRIBUTES
        },
        audit_notes: [
            "This is an explicit capability audit, not a claim that every Thunderbird-exposed property is bidirectionally synced.",
            "Raw Thunderbird objects are included as JSON-safe snapshots for inspection; only tb_state is the canonical bidirectional state subset.",
            "Use getFull/getRaw for raw body/header inspection; use this audit RPC to see what tbird-sync normalizes and what remains partial or unsupported."
        ],
        audited_at: new Date().toISOString()
    };
}

/**
 * Move messages to a folder (batch support)
 */
async function moveMessages(messageIds, folderPath) {
    const results = { success: [], failed: [] };
    const tbIds = [];
    const tbIdToHeaderId = new Map();

    // Resolve all message IDs to Thunderbird internal IDs
    for (const msgId of messageIds) {
        const message = await findMessageByHeaderId(msgId);
        if (message) {
            tbIds.push(message.id);
            tbIdToHeaderId.set(message.id, msgId);
            results.success.push(msgId);
        } else {
            results.failed.push({ messageId: msgId, error: "Message not found" });
        }
    }

    const tbStates = [];

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
            // Fetch updated state for each moved message
            for (const tbId of tbIds) {
                try {
                    const updatedMessage = await messenger.messages.get(tbId);
                    tbStates.push({
                        messageId: tbIdToHeaderId.get(tbId),
                        tb_state: buildTbState(updatedMessage)
                    });
                } catch (e) {
                    // Message ID may have changed after move, include with null state
                    tbStates.push({
                        messageId: tbIdToHeaderId.get(tbId),
                        tb_state: null
                    });
                }
            }
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
        count: results.success.length,
        tb_states: tbStates
    };
}

/**
 * Find a folder by path within an account
 */
async function findFolder(accountId, folderPath) {
    try {
        const accountIdStr = accountId != null ? String(accountId) : "";
        const targetPath = typeof folderPath === "string" ? folderPath : "";
        const normalizedTarget = targetPath.toLowerCase();
        const normalizedTargetNoSlash = normalizedTarget.startsWith("/") ? normalizedTarget.slice(1) : normalizedTarget;

        const findInScopedFolders = (folders) => {
            const scopedFolders = [];
            for (const folder of Array.isArray(folders) ? folders : []) {
                if (!folder || typeof folder !== "object") continue;
                const folderAccountId = folder.accountId != null ? String(folder.accountId) : "";
                // Strict scoping: never accept ambiguous/missing account IDs for account-bound lookups.
                if (accountIdStr && folderAccountId !== accountIdStr) continue;
                scopedFolders.push(folder);
            }

            // Try exact match first
            for (const folder of scopedFolders) {
                if (folder.path === folderPath || folder.name === folderPath) {
                    return folder;
                }
            }
            // Try case-insensitive match
            for (const folder of scopedFolders) {
                const folderPathLower = String(folder.path || "").toLowerCase();
                const folderNameLower = String(folder.name || "").toLowerCase();
                if (
                    folderPathLower === normalizedTarget ||
                    folderNameLower === normalizedTarget ||
                    folderPathLower === normalizedTargetNoSlash ||
                    folderNameLower === normalizedTargetNoSlash
                ) {
                    return folder;
                }
            }
            return null;
        };

        const foldersFromAccountTree = await getAccountFolders(accountIdStr);
        const accountTreeMatch = findInScopedFolders(foldersFromAccountTree);
        if (accountTreeMatch) return accountTreeMatch;

        // Fallback to API query if account tree did not contain the target folder.
        const fallbackFolders = await messenger.folders.query({ accountId });
        const fallbackMatch = findInScopedFolders(fallbackFolders);
        if (fallbackMatch) return fallbackMatch;

        return null;
    } catch (error) {
        console.error("Error finding folder:", error);
        return null;
    }
}

function flattenAccountFolders(folder, out, accountIdHint) {
    if (!folder || typeof folder !== "object") return;
    const normalized = { ...folder };
    if (normalized.accountId == null || normalized.accountId === "") {
        normalized.accountId = accountIdHint;
    }
    out.push(normalized);
    const subs = Array.isArray(folder.subFolders) ? folder.subFolders : [];
    for (const sub of subs) {
        flattenAccountFolders(sub, out, accountIdHint);
    }
}

async function getAccountFolders(accountId) {
    const accountIdStr = accountId != null ? String(accountId) : "";
    if (!accountIdStr) return [];
    try {
        const accounts = await messenger.accounts.list();
        const account = (accounts || []).find((acc) => acc && String(acc.id || "") === accountIdStr);
        if (!account) return [];
        const out = [];
        const roots = Array.isArray(account.folders) ? account.folders : [];
        for (const root of roots) {
            flattenAccountFolders(root, out, accountIdStr);
        }
        return out;
    } catch {
        return [];
    }
}

function applyFolderQueryFilters(folders, queryInfo = {}) {
    let out = Array.isArray(folders) ? folders.slice() : [];
    const accountId = queryInfo && queryInfo.accountId != null ? String(queryInfo.accountId) : "";
    if (accountId) {
        out = out.filter((folder) => folder && String(folder.accountId || "") === accountId);
    }

    const wantedSpecialUse = Array.isArray(queryInfo && queryInfo.specialUse)
        ? queryInfo.specialUse.map((v) => String(v || "").toLowerCase()).filter(Boolean)
        : [];
    if (wantedSpecialUse.length > 0) {
        out = out.filter((folder) => {
            const have = Array.isArray(folder && folder.specialUse)
                ? folder.specialUse.map((v) => String(v || "").toLowerCase())
                : [];
            return wantedSpecialUse.every((tag) => have.includes(tag));
        });
    }

    if (queryInfo && typeof queryInfo.path === "string" && queryInfo.path.trim()) {
        const targetPath = normalizeFolderPath(queryInfo.path).toLowerCase();
        out = out.filter((folder) => normalizeFolderPath(folder && folder.path || "").toLowerCase() === targetPath);
    }
    if (queryInfo && typeof queryInfo.name === "string" && queryInfo.name.trim()) {
        const targetName = String(queryInfo.name).toLowerCase();
        out = out.filter((folder) => String(folder && folder.name || "").toLowerCase() === targetName);
    }
    if (queryInfo && typeof queryInfo.type === "string" && queryInfo.type.trim()) {
        const targetType = String(queryInfo.type).toLowerCase();
        out = out.filter((folder) => String(folder && folder.type || "").toLowerCase() === targetType);
    }

    if (queryInfo && typeof queryInfo.isRoot === "boolean") {
        out = out.filter((folder) => Boolean(folder && folder.isRoot) === queryInfo.isRoot);
    }
    if (queryInfo && typeof queryInfo.isFavorite === "boolean") {
        out = out.filter((folder) => Boolean(folder && folder.isFavorite) === queryInfo.isFavorite);
    }
    return out;
}

function parseAccountFolderId(value) {
    if (typeof value !== "string") return null;
    const raw = value.trim();
    if (!raw) return null;
    const idx = raw.indexOf("://");
    if (idx <= 0) return null;
    const accountId = raw.slice(0, idx);
    let folderPath = raw.slice(idx + 3);
    if (!folderPath.startsWith("/")) folderPath = `/${folderPath}`;
    return { accountId, folderPath };
}

function normalizeFolderPath(path) {
    if (typeof path !== "string") return "";
    const trimmed = path.trim().replace(/\\/g, "/");
    if (!trimmed) return "";
    return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

async function resolveRpcFolder(folderRef, accountIdHint = "") {
    let accountId = accountIdHint ? String(accountIdHint) : "";
    let folderPath = "";

    if (typeof folderRef === "string") {
        const parsed = parseAccountFolderId(folderRef);
        if (parsed) {
            accountId = parsed.accountId;
            folderPath = parsed.folderPath;
        } else {
            folderPath = normalizeFolderPath(folderRef);
        }
    } else if (folderRef && typeof folderRef === "object") {
        const parsed = parseAccountFolderId(folderRef.id);
        if (parsed && !accountId) {
            accountId = parsed.accountId;
        }
        if (parsed && !folderPath) {
            folderPath = parsed.folderPath;
        }
        if (!accountId && folderRef.accountId != null) {
            accountId = String(folderRef.accountId);
        }
        if (!folderPath && typeof folderRef.path === "string") {
            folderPath = normalizeFolderPath(folderRef.path);
        }
        if (!folderPath && typeof folderRef.name === "string") {
            folderPath = normalizeFolderPath(folderRef.name);
        }
    }

    if (!folderPath) folderPath = "/INBOX";
    if (!accountId) return null;

    const resolved = await findFolder(accountId, folderPath);
    if (resolved) return resolved;

    const normalized = normalizeFolderPath(folderPath);
    if (normalized === "/INBOX") {
        return await findFolder(accountId, "/Inbox");
    }
    if (normalized === "/Inbox") {
        return await findFolder(accountId, "/INBOX");
    }
    return null;
}

function filterMessagesByScope(messages, expectedAccountId = "", expectedFolderPath = "") {
    if (!Array.isArray(messages)) return [];
    const accountId = expectedAccountId ? String(expectedAccountId) : "";
    const folderPath = normalizeFolderPath(expectedFolderPath).toLowerCase();

    return messages.filter((msg) => {
        if (!msg || typeof msg !== "object") return false;
        const folder = msg.folder;
        if (!folder || typeof folder !== "object") return false;

        if (accountId && String(folder.accountId || "") !== accountId) {
            return false;
        }

        if (!folderPath) return true;
        const msgPath = normalizeFolderPath(folder.path || "").toLowerCase();
        return msgPath === folderPath;
    });
}

function parseRpcDateMs(value) {
    if (value == null) return null;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (value instanceof Date) {
        const ms = value.getTime();
        return Number.isFinite(ms) ? ms : null;
    }
    if (typeof value === "string" && value.trim()) {
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function toPositiveInt(value, fallback, max = 2000) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(Math.floor(n), max);
}

function normalizeRpcArgs(rawArgs) {
    if (Array.isArray(rawArgs)) return rawArgs;
    if (rawArgs && typeof rawArgs === "object") return [rawArgs];
    if (typeof rawArgs === "string" && rawArgs.trim()) {
        try {
            const parsed = JSON.parse(rawArgs);
            if (Array.isArray(parsed)) return parsed;
            if (parsed && typeof parsed === "object") return [parsed];
        } catch {
            // Ignore malformed JSON and fall through to empty args.
        }
    }
    return [];
}

function matchesQueryFilters(message, { fromDateMs = null, unreadFilter = null } = {}) {
    if (!message || typeof message !== "object") return false;
    if (typeof unreadFilter === "boolean") {
        const isUnread = !Boolean(message.read);
        if (isUnread !== unreadFilter) return false;
    }
    if (typeof fromDateMs === "number" && Number.isFinite(fromDateMs)) {
        const msgMs = getMessageDateMs(message);
        if (msgMs === null || msgMs < fromDateMs) return false;
    }
    return true;
}

async function queryFolderMessagesCompat(folder, queryInfo) {
    const requestedLimit = toPositiveInt(queryInfo && queryInfo.limit, 100, 5000);
    const limit = Math.max(1, requestedLimit);
    const unreadFilter = (queryInfo && queryInfo.unreadOnly === true)
        ? true
        : ((queryInfo && typeof queryInfo.unread === "boolean") ? queryInfo.unread : null);
    const fromDateMs = parseRpcDateMs(queryInfo && queryInfo.fromDate);

    // Keep this within the outer command timeout budget.
    const deadlineMs = Date.now() + 24000;
    const maxPages = fromDateMs !== null ? 60 : Math.max(6, Math.ceil(limit / 100) + 2);
    const pageSize = Math.max(50, Math.min(500, Math.max(limit, 100)));
    const seen = new Set();
    const collected = [];

    let page = await listFolderMessagesFirstPage(folder, pageSize);
    let pages = 0;
    while (page && pages < maxPages && Date.now() < deadlineMs) {
        pages += 1;
        const pageMessages = Array.isArray(page.messages) ? page.messages : [];
        for (const msg of pageMessages) {
            if (!matchesQueryFilters(msg, { fromDateMs, unreadFilter })) continue;
            const key = String(
                msg.id != null
                    ? msg.id
                    : (msg.headerMessageId || `${msg.subject || ""}|${msg.date || ""}|${Math.random()}`)
            );
            if (seen.has(key)) continue;
            seen.add(key);
            collected.push(msg);
        }

        if (!page.id) break;
        if (fromDateMs === null && collected.length >= limit) break;
        page = await messenger.messages.continueList(page.id);
    }

    collected.sort((a, b) => {
        const aMs = getMessageDateMs(a) || 0;
        const bMs = getMessageDateMs(b) || 0;
        return bMs - aMs;
    });

    return {
        id: null,
        messages: collected.slice(0, limit),
    };
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
        const details = {};
        if (replyBody && replyBody.trim()) {
            const htmlBody = replyBody
                .split('\n\n')
                .map(p => '<p>' + p.replace(/\n/g, '<br>') + '</p>')
                .join('');
            details.body = htmlBody;
        }
        const tab = await messenger.compose.beginReply(message.id, replyType, details);
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
        },
        tb_state: buildTbState(message)
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
                junk: message.junk || false,
                tb_state: buildTbState(message)
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
    let parent = null;

    for (const part of parts) {
        if (!obj || typeof obj !== "object") return null;
        parent = obj;
        obj = obj[part];
    }

    // Bind to parent to preserve `this` context (e.g. folders.getFolderInfo
    // needs `this` === messenger.folders)
    return (typeof obj === "function") ? obj.bind(parent) : null;
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
        case "cortex.getInboxCounts": {
            // Returns per-account inbox message counts using live folder references.
            // Uses getFolderInfo (fast) with fallback to messages.list pagination (slow).
            const _timeoutPromise = (promise, ms, label) =>
                Promise.race([
                    promise,
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
                    ),
                ]);
            const accounts = await messenger.accounts.list();
            const counts = {};
            for (const account of accounts) {
                if (account.type === "none") continue;
                const accountId = account.id;
                const t0 = Date.now();
                // Find inbox folder in the live account tree
                let inboxFolder = null;
                const findInbox = (folders) => {
                    for (const f of (folders || [])) {
                        if (Array.isArray(f.specialUse) && f.specialUse.includes("inbox")) {
                            return f;
                        }
                        const sub = findInbox(f.subFolders);
                        if (sub) return sub;
                    }
                    return null;
                };
                const rootSubs = account.rootFolder
                    ? (account.rootFolder.subFolders || [])
                    : (account.folders || []);
                inboxFolder = findInbox(rootSubs);
                if (!inboxFolder) {
                    counts[accountId] = { name: account.name, type: account.type, totalMessageCount: null, error: "no inbox folder", ms: Date.now() - t0 };
                    continue;
                }
                // Strategy 1: getFolderInfo with the live MailFolder object (fast, <1s)
                let method = "none";
                try {
                    const info = await _timeoutPromise(
                        messenger.folders.getFolderInfo(inboxFolder),
                        10000, `getFolderInfo(${accountId})`
                    );
                    method = "getFolderInfo";
                    counts[accountId] = {
                        name: account.name,
                        type: account.type,
                        totalMessageCount: info.totalMessageCount,
                        unreadMessageCount: info.unreadMessageCount,
                        method, ms: Date.now() - t0,
                    };
                    continue;
                } catch (e) {
                    // Strategy 1 failed, try getFolderInfo with string id
                    try {
                        const info = await _timeoutPromise(
                            messenger.folders.getFolderInfo(inboxFolder.id),
                            10000, `getFolderInfo(id=${inboxFolder.id})`
                        );
                        method = "getFolderInfo(id)";
                        counts[accountId] = {
                            name: account.name,
                            type: account.type,
                            totalMessageCount: info.totalMessageCount,
                            unreadMessageCount: info.unreadMessageCount,
                            method, ms: Date.now() - t0,
                        };
                        continue;
                    } catch (_e2) {
                        // Strategy 2: messages.list pagination (slow but reliable)
                        try {
                            let total = 0;
                            let unread = 0;
                            let pages = 0;
                            const firstPage = await _timeoutPromise(
                                messenger.messages.list(inboxFolder),
                                15000, `messages.list(${accountId})`
                            );
                            total += firstPage.messages.length;
                            for (const m of firstPage.messages) { if (!m.read) unread++; }
                            pages++;
                            let listId = firstPage.id;
                            while (listId) {
                                const nextPage = await _timeoutPromise(
                                    messenger.messages.continueList(listId),
                                    10000, `messages.continueList(${accountId} p${pages})`
                                );
                                if (!nextPage || !nextPage.messages || nextPage.messages.length === 0) break;
                                total += nextPage.messages.length;
                                for (const m of nextPage.messages) { if (!m.read) unread++; }
                                listId = nextPage.id;
                                pages++;
                            }
                            method = `messages.list(${pages}pg)`;
                            counts[accountId] = {
                                name: account.name,
                                type: account.type,
                                totalMessageCount: total,
                                unreadMessageCount: unread,
                                method, ms: Date.now() - t0,
                            };
                        } catch (e3) {
                            method = "failed";
                            counts[accountId] = {
                                name: account.name,
                                type: account.type,
                                totalMessageCount: null,
                                error: String(e3.message || e3),
                                method, ms: Date.now() - t0,
                            };
                        }
                    }
                }
            }
            return counts;
        }
        case "cortex.getNewestInboxMessageByAccount": {
            // Returns per-account newest inbox message timestamp using live folder references.
            // Uses messages.list (returns newest-first) to avoid messages.query serialization bugs.
            const _timeoutPromise2 = (promise, ms, label) =>
                Promise.race([
                    promise,
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
                    ),
                ]);
            const accounts = await messenger.accounts.list();
            const result = {};
            for (const account of accounts) {
                if (account.type === "none") continue;
                const accountId = account.id;
                const t0 = Date.now();
                // Find inbox folder in the live account tree
                const findInbox = (folders) => {
                    for (const f of (folders || [])) {
                        if (Array.isArray(f.specialUse) && f.specialUse.includes("inbox")) return f;
                        const sub = findInbox(f.subFolders);
                        if (sub) return sub;
                    }
                    return null;
                };
                const rootSubs = account.rootFolder
                    ? (account.rootFolder.subFolders || [])
                    : (account.folders || []);
                const inboxFolder = findInbox(rootSubs);
                if (!inboxFolder) {
                    result[accountId] = {
                        name: account.name, type: account.type,
                        newestDate: null, error: "no inbox folder", ms: Date.now() - t0,
                    };
                    continue;
                }
                try {
                    // messages.list returns newest-first; we only need page 1
                    const page = await _timeoutPromise2(
                        messenger.messages.list(inboxFolder),
                        15000, `messages.list(${accountId})`
                    );
                    const msgs = (page && page.messages) || [];
                    let newestDate = null;
                    let sampled = msgs.length;
                    for (const m of msgs) {
                        if (m.date) {
                            const d = (m.date instanceof Date) ? m.date.toISOString() : String(m.date);
                            if (!newestDate || d > newestDate) newestDate = d;
                        }
                    }
                    result[accountId] = {
                        name: account.name, type: account.type,
                        newestDate, sampled, ms: Date.now() - t0,
                    };
                } catch (e) {
                    result[accountId] = {
                        name: account.name, type: account.type,
                        newestDate: null, error: String(e.message || e),
                        ms: Date.now() - t0,
                    };
                }
            }
            return result;
        }
        case "cortex.messages.getFullByHeaderId": {
            const headerMessageId = args[0];
            const message = await findMessageByHeaderId(headerMessageId);
            if (!message) throw new Error("Message not found");
            const full = await messenger.messages.getFull(message.id);
            // Include complete message state for immediate sync during ingest
            return {
                headerMessageId,
                messageId: message.id,
                full,
                state: buildTbState(message)
            };
        }
        case "cortex.messages.getStateAuditByHeaderId": {
            return await getStateAuditByHeaderId(args[0]);
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
    const args = normalizeRpcArgs(cmd.args);

    if (!isAllowedRpcMethodPath(method)) {
        return { success: false, action: "rpc", method, error: `Method not allowed: ${method}` };
    }

    try {
        let result;
        if (method.startsWith("cortex.")) {
            result = await cortexRpc(method, args);
        } else if (method === "messages.tags.list") {
            if (messenger.messages && typeof messenger.messages.listTags === "function") {
                result = await messenger.messages.listTags();
            } else if (
                messenger.messages &&
                messenger.messages.tags &&
                typeof messenger.messages.tags.list === "function"
            ) {
                result = await messenger.messages.tags.list();
            } else {
                throw new Error("Unknown method: messages.tags.list");
            }
        } else if (method === "messages.query") {
            const original = (args[0] && typeof args[0] === "object") ? args[0] : {};
            const queryInfo = { ...original };
            const requestedScopedQuery = Boolean(
                queryInfo.accountId != null ||
                Object.prototype.hasOwnProperty.call(queryInfo, "folder") ||
                Object.prototype.hasOwnProperty.call(queryInfo, "folderId")
            );

            let accountIdHint = queryInfo.accountId != null ? String(queryInfo.accountId) : "";
            let expectedFolderPath = "";
            let resolvedFolder = null;

            if (Object.prototype.hasOwnProperty.call(queryInfo, "folder")) {
                resolvedFolder = await resolveRpcFolder(queryInfo.folder, accountIdHint);
            } else if (Object.prototype.hasOwnProperty.call(queryInfo, "folderId")) {
                resolvedFolder = await resolveRpcFolder(queryInfo.folderId, accountIdHint);
            } else if (accountIdHint) {
                resolvedFolder = await resolveRpcFolder({ accountId: accountIdHint, path: "/INBOX" }, accountIdHint);
            }

            if (resolvedFolder) {
                queryInfo.folder = resolvedFolder;
                accountIdHint = String(resolvedFolder.accountId || accountIdHint || "");
                expectedFolderPath = normalizeFolderPath(resolvedFolder.path || "");
            }
            if (!expectedFolderPath && queryInfo.folder && typeof queryInfo.folder === "object") {
                expectedFolderPath = normalizeFolderPath(queryInfo.folder.path || "");
            }
            if (!accountIdHint && queryInfo.folder && typeof queryInfo.folder === "object" && queryInfo.folder.accountId != null) {
                accountIdHint = String(queryInfo.folder.accountId);
            }
            if (requestedScopedQuery && !resolvedFolder) {
                const scopeRef = queryInfo.folder || queryInfo.folderId || null;
                return {
                    success: false,
                    action: "rpc",
                    method,
                    error: `Unable to resolve folder scope for account '${accountIdHint || "?"}' (${JSON.stringify(scopeRef)})`
                };
            }
            delete queryInfo.folderId;
            delete queryInfo.accountId;

            const fromDateMs = parseRpcDateMs(queryInfo.fromDate);
            if (fromDateMs !== null) {
                queryInfo.fromDate = new Date(fromDateMs);
            }
            if (queryInfo.unreadOnly === true && typeof queryInfo.unread !== "boolean") {
                queryInfo.unread = true;
            }

            const nativeQuery = { ...queryInfo };
            delete nativeQuery.includeBody;
            delete nativeQuery.limit;
            delete nativeQuery.unreadOnly;

            const shouldUseCompatFolderQuery = Boolean(queryInfo.folder) && (
                fromDateMs !== null ||
                Object.prototype.hasOwnProperty.call(original, "limit") ||
                Object.prototype.hasOwnProperty.call(original, "unreadOnly")
            );

            if (shouldUseCompatFolderQuery) {
                result = await queryFolderMessagesCompat(queryInfo.folder, queryInfo);
            } else {
                result = await messenger.messages.query(nativeQuery);
                if (
                    result &&
                    Array.isArray(result.messages) &&
                    Object.prototype.hasOwnProperty.call(original, "limit")
                ) {
                    const capped = toPositiveInt(original.limit, result.messages.length, 5000);
                    result = {
                        ...result,
                        messages: result.messages.slice(0, capped),
                    };
                }
            }

            if (result && Array.isArray(result.messages) && (accountIdHint || expectedFolderPath)) {
                const originalCount = result.messages.length;
                const filteredMessages = filterMessagesByScope(result.messages, accountIdHint, expectedFolderPath);
                if (requestedScopedQuery && originalCount > 0 && filteredMessages.length === 0) {
                    return {
                        success: false,
                        action: "rpc",
                        method,
                        error: `Scope mismatch: query returned ${originalCount} out-of-scope messages for ${accountIdHint || "?"} ${expectedFolderPath || ""}`.trim()
                    };
                }
                result = {
                    ...result,
                    messages: filteredMessages,
                };
            }
        } else if (method === "folders.query") {
            const queryInfo = (args[0] && typeof args[0] === "object") ? args[0] : {};
            const accountId = queryInfo.accountId != null ? String(queryInfo.accountId) : "";
            if (accountId) {
                const accountFolders = await getAccountFolders(accountId);
                if (accountFolders.length > 0) {
                    result = applyFolderQueryFilters(accountFolders, queryInfo);
                } else {
                    result = await messenger.folders.query(queryInfo);
                    if (Array.isArray(result)) {
                        result = applyFolderQueryFilters(result, queryInfo);
                    }
                }
            } else {
                result = await messenger.folders.query(queryInfo);
            }

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
const PROGRESS_EVERY_N_MESSAGES = 10;
const PROGRESS_MIN_INTERVAL_MS = 10_000;

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
    // When iterating lots of messages, yield to the event loop periodically so
    // timers (polling/watchdog) and UI remain responsive. This mirrors patterns
    // used by large-export extensions like ImportExportTools NG.
    let yielded = 0;
    let page = await listFolderMessagesFirstPage(folder, pageSize);
    while (page) {
        const messages = Array.isArray(page.messages) ? page.messages : [];
        for (const msg of messages) {
            yield msg;
            yielded += 1;
            if (yielded % 50 === 0) {
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }
        if (!page.id) break;
        page = await messenger.messages.continueList(page.id);
    }
}

async function* iterateFolderMessagesSince(folder, cutoffMs, pageSize = 100) {
    // Prefer a server-side query with a date filter when available (fast and order-independent).
    try {
        const queryInfo = { folder };
        if (typeof cutoffMs === "number" && Number.isFinite(cutoffMs) && cutoffMs > 0) {
            queryInfo.fromDate = new Date(cutoffMs);
        }
        let page = await messenger.messages.query(queryInfo);
        let yielded = 0;
        while (page) {
            const messages = Array.isArray(page.messages) ? page.messages : [];
            for (const msg of messages) {
                yield msg;
                yielded += 1;
                if (yielded % 50 === 0) {
                    await new Promise(resolve => setTimeout(resolve, 0));
                }
            }
            if (!page.id) break;
            page = await messenger.messages.continueList(page.id);
        }
        return;
    } catch {
        // Fallback to folder listing
    }

    for await (const msg of iterateFolderMessages(folder, pageSize)) yield msg;
}

async function postProgressUpdate(commandId, processed, total, status, meta = null) {
    if (!commandId) return;
    try {
        const payload = {
            command_id: commandId,
            processed,
            total,
            status,
            source: "tbird-sync",
        };
        if (meta && typeof meta === "object") {
            for (const [k, v] of Object.entries(meta)) {
                if (k in payload) continue;
                payload[k] = v;
            }
        }

        // Send progress via WebSocket (best-effort, don't block command execution)
        if (!sendWebSocketMessage({ type: "progress", data: payload })) {
            DebugLogger.log("progress", "WS not open, progress update dropped", { commandId, processed, total, status });
        }
    } catch (e) {
        DebugLogger.log("progress", "postProgressUpdate failed", { commandId, processed, total, status, error: String(e) });
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

function isLikelySentFolder(folder) {
    if (!folder) return false;
    if (folder.type === "sent") return true;

    const name = String(folder.name || "").trim().toLowerCase();
    const path = String(folder.path || "").trim().toLowerCase();

    // Common Sent folder names (English + a few typical variants).
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
    if (typeof Cortex1SentFolderDiscovery !== "undefined" && Cortex1SentFolderDiscovery.walkFolderTree) {
        return Cortex1SentFolderDiscovery.walkFolderTree(folder, out);
    }
    if (!folder) return;
    out.push(folder);
    const subs = Array.isArray(folder.subFolders) ? folder.subFolders : [];
    for (const sub of subs) walkFolderTree(sub, out);
}

async function getSentFolders(accountIdFilter) {
    if (typeof Cortex1SentFolderDiscovery !== "undefined" && Cortex1SentFolderDiscovery.getSentFolders) {
        return await Cortex1SentFolderDiscovery.getSentFolders(messenger, accountIdFilter);
    }
    // Defensive fallback (should not happen if manifest loads sent_folder_discovery.js)
    const accounts = await messenger.accounts.list();
    const out = [];
    for (const account of accounts) {
        if (accountIdFilter && String(account.id) !== String(accountIdFilter)) continue;
        const folders = [];
        for (const root of Array.isArray(account.folders) ? account.folders : []) {
            walkFolderTree(root, folders);
        }
        for (const folder of folders) {
            if (!isLikelySentFolder(folder)) continue;
            out.push(folder);
        }
    }
    return out;
}

async function resolveAccountIdFilter(accountIdRaw) {
    const raw = accountIdRaw != null ? String(accountIdRaw).trim() : "";
    if (!raw) return null;

    const accounts = await messenger.accounts.list();
    const exact = (Array.isArray(accounts) ? accounts : []).find((a) => String(a && a.id) === raw);
    if (exact) return String(exact.id);

    const needle = raw.toLowerCase();
    const candidates = [];

    for (const account of Array.isArray(accounts) ? accounts : []) {
        const name = String(account && account.name ? account.name : "").trim().toLowerCase();
        if (name && name === needle) candidates.push(account);

        const identities = Array.isArray(account && account.identities) ? account.identities : [];
        for (const ident of identities) {
            const email = String(ident && ident.email ? ident.email : "").trim().toLowerCase();
            if (email && email === needle) candidates.push(account);
        }
    }

    const unique = new Map();
    for (const a of candidates) {
        if (!a || a.id == null) continue;
        unique.set(String(a.id), a);
    }
    const matches = Array.from(unique.values());
    if (matches.length === 1) return String(matches[0].id);

    throw new Error(`Unknown or ambiguous account_id: ${raw}`);
}

async function handleBackfillRepliedForwarded(cmd) {
    let step = "init";
    let result = null;
    let commandId = null;
    let limit = 0;
    let lastProgressPostAt = 0;

    try {
        const daysBack = toFiniteNumber(cmd.days_back, 30);
        limit = toFiniteNumber(cmd.limit, 500);
        const accountFilterRequested = cmd.account_id != null ? String(cmd.account_id) : null;
        const accountFilterResolved = await resolveAccountIdFilter(accountFilterRequested);
        commandId = cmd.id || cmd.command_id || null;

        const cutoffMs = Date.now() - Math.max(0, daysBack) * 24 * 60 * 60 * 1000;

        result = {
            success: true,
            processed: 0,
            replied_tagged: 0,
            forwarded_tagged: 0,
            not_found: 0,
            errors: [],
            replied_tagged_ids: [],
            forwarded_tagged_ids: [],
            account_filter_requested: accountFilterRequested,
            account_filter_resolved: accountFilterResolved,
            folders_scanned: 0,
            errors_count: 0,
            completed_reason: "",
        };

        const resolvedCache = new Map();
        const repliedTaggedMessageIds = new Set();
        const forwardedTaggedMessageIds = new Set();

        step = "resolve sent folders";
        const targetFolders = await getSentFolders(accountFilterResolved);
        result.sent_folders_count = Array.isArray(targetFolders) ? targetFolders.length : 0;
        result.sent_folders = (Array.isArray(targetFolders) ? targetFolders : [])
            .slice(0, 20)
            .map((f) => ({
                accountId: f && f.accountId != null ? String(f.accountId) : "",
                name: f && f.name != null ? String(f.name) : "",
                path: f && f.path != null ? String(f.path) : "",
                type: f && f.type != null ? String(f.type) : "",
            }));

        step = "postProgressUpdate(start)";
        await postProgressUpdate(commandId, 0, limit, "in_progress", {
            step,
            sent_folders_count: result.sent_folders_count,
            sent_folders: result.sent_folders,
            account_filter_requested: accountFilterRequested,
            account_filter_resolved: accountFilterResolved,
            folders_scanned: 0,
            errors_count: 0,
            not_found: 0,
        });
        lastProgressPostAt = Date.now();

        outer: for (const folder of targetFolders) {
            // Check cancellation between folders
            if (commandId && cancelledJobIds.has(commandId)) {
                result.completed_reason = "cancelled";
                result.success = true;
                break outer;
            }
            step = `iterateFolderMessagesSince(accountId=${folder.accountId} folderPath=${folder.path || ""})`;
            result.folders_scanned += 1;
            for await (const sentMsg of iterateFolderMessagesSince(folder, cutoffMs, 100)) {
                if (result.processed >= limit) break outer;

                // Check cancellation every message
                if (commandId && cancelledJobIds.has(commandId)) {
                    result.completed_reason = "cancelled";
                    result.success = true;
                    break outer;
                }

                const dateMs = getMessageDateMs(sentMsg);
                if (dateMs != null && dateMs < cutoffMs) continue;

                let full;
                try {
                    step = `messages.getFull(sentMsg.id=${sentMsg.id})`;
                    await rateLimitGetFull();
                    full = await messenger.messages.getFull(sentMsg.id);
                } catch (e) {
                    result.errors.push(`getFull failed for sentMsg.id=${sentMsg.id}: ${String(e)}`);
                    result.errors_count = result.errors.length;
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
                    step = `findMessageByHeaderId(target=${targetHeaderId})`;
                    const originalMsg = await findMessageByHeaderId(targetHeaderId, resolvedCache);
                    if (!originalMsg) {
                        result.not_found += 1;
                        return;
                    }

                    if (taggedSet.has(originalMsg.id)) return;
                    try {
                        step = `messages.update(tag=${tag} originalMsg.id=${originalMsg.id})`;
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

                const now = Date.now();
                const shouldHeartbeat = (now - lastProgressPostAt) >= PROGRESS_MIN_INTERVAL_MS;
                if (shouldHeartbeat || (result.processed % PROGRESS_EVERY_N_MESSAGES === 0)) {
                    step = "postProgressUpdate(progress)";
                    await postProgressUpdate(commandId, result.processed, limit, "in_progress", {
                        step,
                        folders_scanned: result.folders_scanned,
                        current_folder: {
                            accountId: folder && folder.accountId != null ? String(folder.accountId) : "",
                            path: folder && folder.path != null ? String(folder.path) : "",
                            name: folder && folder.name != null ? String(folder.name) : "",
                            type: folder && folder.type != null ? String(folder.type) : "",
                        },
                        errors_count: result.errors.length,
                        not_found: result.not_found,
                    });
                    lastProgressPostAt = now;
                }
            }
        }

        if (result.completed_reason !== "cancelled") {
            result.completed_reason = result.processed >= limit ? "limit_reached" : "exhausted";
        }
        // Clean up cancel tracking + prune stale entries
        if (commandId) cancelledJobIds.delete(commandId);
        pruneCancelledJobIds();
        const finalStatus = result.completed_reason === "cancelled" ? "cancelled" : "completed";
        step = `postProgressUpdate(${finalStatus})`;
        await postProgressUpdate(commandId, result.processed, result.processed, finalStatus, {
            step,
            folders_scanned: result.folders_scanned,
            errors_count: result.errors.length,
            not_found: result.not_found,
            completed_reason: result.completed_reason,
        });
        return result;
    } catch (e) {
        const message = e && e.message ? e.message : String(e);
        const processed = result && typeof result.processed === "number" ? result.processed : 0;
        const errors = result && Array.isArray(result.errors) ? result.errors : [];

        DebugLogger.log("backfill", "backfill_replied_forwarded exception", {
            step,
            error: String(e),
            commandId,
            processed,
        });

        await postProgressUpdate(commandId, processed, processed, "failed", {
            step,
            errors_count: errors.length,
        });
        return {
            success: false,
            error: `Exception in backfill_replied_forwarded at ${step}: ${message}`,
            step,
            processed,
            errors,
        };
    }
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
    DebugLogger.log("cmd", "Raw command", cmd);
    if (!cmd || !cmd.action) {
        return { success: false, error: "Command missing action field" };
    }
    switch (cmd.action) {
        case "mark_read":
            return await markAsRead(cmd.messageId);
        case "mark_unread":
            return await markAsUnread(cmd.messageId);
        case "set_flagged":
            return await setFlagged(cmd.messageId, cmd.flagged !== false);
        case "set_junk":
            return await setJunk(cmd.messageId, cmd.junk === true);
        case "open_message":
            return await openMessage(cmd.messageId);
        // Batch operations
        case "archive":
            return await archiveMessages(cmd.messageIds || [cmd.messageId]);
        case "delete":
            return await deleteMessages(cmd.messageIds || [cmd.messageId], cmd.skipTrash === true);
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
        // Bulk sync state for multiple messages
        case "sync_state":
        case "bulk_sync_state": {
            const messageIds = cmd.messageIds || [];
            const states = [];
            const failed = [];

            for (const msgId of messageIds) {
                try {
                    const message = await findMessageByHeaderId(msgId);
                    if (message) {
                        states.push({
                            messageId: msgId,
                            tb_state: buildTbState(message)
                        });
                    } else {
                        failed.push({ messageId: msgId, error: "Not found" });
                    }
                } catch (e) {
                    failed.push({ messageId: msgId, error: e.message });
                }
            }

            return {
                success: failed.length === 0,
                action: "sync_state",
                states: states,
                failed: failed,
                count: states.length
            };
        }
        case "cancel_job": {
            const targetJobId = cmd.job_id || "";
            if (targetJobId) {
                cancelledJobIds.set(targetJobId, Date.now());
                pruneCancelledJobIds();
                const removed = removeQueuedCommandsForJob(targetJobId);
                DebugLogger.log("cmd", "Job cancelled", { job_id: targetJobId, removed_queued: removed });
            }
            return { success: true, action: "cancel_job", job_id: targetJobId };
        }
        case "export_diagnostics":
            return await exportDiagnostics({
                format: cmd.format || cmd.outputFormat || cmd.output_format,
                saveAs: cmd.saveAs
            });
        default:
            return { success: false, error: "Unknown action: " + cmd.action };
    }
}

// =============================================================================
// WebSocket Client (preferred, with HTTP fallback)
// =============================================================================

// HTTP polling removed — WebSocket only.

function isWebSocketOpen() {
    return ws && ws.readyState === WebSocket.OPEN;
}

async function getWebSocketUrl() {
    const baseUrl = normalizeLoopbackServerUrl(await getCortexServerUrl());
    try {
        const parsed = new URL(baseUrl);
        const protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
        return `${protocol}//${parsed.host}/tbird-sync/ws`;
    } catch (error) {
        const wsBase = String(baseUrl || "").replace(/^http(s?):/i, (match, secure) => (secure ? "wss:" : "ws:"));
        return `${wsBase.replace(/\/+$/, "")}/tbird-sync/ws`;
    }
}

function sendWebSocketMessage(msg) {
    if (!isWebSocketOpen()) return false;
    try {
        ws.send(JSON.stringify(msg));
        return true;
    } catch (error) {
        console.error("[WS] Send failed:", error);
        return false;
    }
}

async function handleWebSocketMessage(msg) {
    if (!msg || typeof msg !== "object") {
        console.warn("[WS] Ignoring non-object message");
        return;
    }

    const msgType = msg.type;
    if (msgType === "command" || msgType === "commands") {
        let commands = [];
        if (msgType === "command") {
            const cmd = msg.data || msg.command || msg;
            if (cmd) commands = [cmd];
        } else {
            commands = msg.commands || msg.data || [];
        }

        // Reuse existing command pipeline (queue + workers).
        const enqueued = enqueueCommands(commands);
        if (IS_TEST_MODE && enqueued > 0) {
            await runWorkerLoop();
        }
        if (commands.length > 0) {
            DebugLogger.log("poll", `WS received ${commands.length} command(s)`, {
                actions: commands.map(c => c && c.action ? c.action : null),
                enqueued
            });
        }
        return;
    }

    if (msgType === "ping") {
        const clientId = await getExtensionClientId();
        sendWebSocketMessage({
            type: "pong",
            client_id: clientId,
            clientId,
            data: { timestamp: Date.now(), client_id: clientId, clientId }
        });
        return;
    }

    if (msgType === "pong") return;

    console.warn("[WS] Unknown message type:", msgType);
}

// startHttpPolling / stopHttpPolling removed — WebSocket is the sole transport.

function scheduleReconnect() {
    if (wsReconnectTimer) return;
    wsReconnectAttempts += 1;
    const delay = Math.min(
        WS_BASE_DELAY * Math.pow(2, wsReconnectAttempts - 1),
        WS_MAX_RECONNECT_DELAY
    );
    console.log(`[WS] Reconnecting in ${delay}ms (attempt ${wsReconnectAttempts})`);
    wsReconnectTimer = setTimeout(() => {
        wsReconnectTimer = null;
        connectWebSocket();
    }, delay);

    connectionState = "RECONNECTING";
    setIndicator({ connected: false });
}

async function connectWebSocket() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        return;
    }

    const wsUrl = await getWebSocketUrl();
    try {
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            console.log("[WS] Connected to cortex-server");
            wsReconnectAttempts = 0;
            connectionState = "CONNECTED";
            setIndicator({ connected: true });
            getExtensionClientId()
                .then((clientId) => {
                    sendWebSocketMessage({
                        type: "hello",
                        client_id: clientId,
                        clientId,
                        extension_version: getExtensionVersion()
                    });
                })
                .catch((error) => {
                    DebugLogger.log("transport", "Failed to send WS hello", { error: String(error) });
                });
            // Flush any queued completions/events that accumulated while disconnected
            scheduleCompletionFlush(0);
            scheduleFlushQueue();
            flushNewEmailBatch().catch((error) => {
                DebugLogger.log("new-email", "Flush on reconnect failed", { error: String(error) });
            });
        };

        ws.onmessage = async (event) => {
            try {
                const msg = JSON.parse(event.data);
                await handleWebSocketMessage(msg);
            } catch (error) {
                console.error("[WS] Message error:", error);
            }
        };

        ws.onerror = (error) => {
            console.error("[WS] Error:", error);
        };

        ws.onclose = () => {
            console.log("[WS] Disconnected, will reconnect...");
            ws = null;
            setIndicator({ connected: false });
            scheduleReconnect();
        };
    } catch (error) {
        console.error("[WS] Failed to connect:", error);
        setIndicator({ connected: false, error: "Connection failed" });
        scheduleReconnect();
    }
}

// =============================================================================
// Bulletproof polling loop (timeouts, watchdog, backoff, and heartbeat logging)
// =============================================================================

// Connection state tracking (best-effort UX/diagnostics)
let connectionState = "DISCONNECTED"; // CONNECTED, DISCONNECTED, RECONNECTING

// =============================================================================
// Toolbar badge indicator (green-light / busy / error)
// =============================================================================

const ACT = (typeof messenger !== "undefined" && messenger)
    ? (messenger.action || messenger.browserAction)
    : null;

let _indicatorLastUpdate = 0;
let _indicatorTimer = null;

function getQueueDepth() {
    return (highCommandQueue ? highCommandQueue.length : 0)
         + (fastCommandQueue ? fastCommandQueue.length : 0)
         + (slowCommandQueue ? slowCommandQueue.length : 0);
}

function setIndicator(opts) {
    const now = Date.now();
    const elapsed = now - _indicatorLastUpdate;

    if (elapsed < 1000) {
        // Throttle: schedule a deferred update if not already pending
        if (!_indicatorTimer) {
            _indicatorTimer = setTimeout(() => {
                _indicatorTimer = null;
                setIndicator(opts);
            }, 1000 - elapsed);
        }
        return;
    }

    _indicatorLastUpdate = now;

    if (!ACT) return;

    const connected = opts && opts.connected !== undefined
        ? opts.connected
        : connectionState === "CONNECTED";
    const error = opts && opts.error ? opts.error : null;
    const busy = opts && opts.busy !== undefined ? opts.busy : false;
    const queueDepth = opts && opts.queueDepth !== undefined
        ? opts.queueDepth
        : getQueueDepth();

    let badgeText, badgeColor, tooltip;

    if (error || !connected) {
        badgeText = "!";
        badgeColor = "#e74c3c"; // red
        tooltip = error
            ? "Cortex: Error: " + String(error).slice(0, 80)
            : "Cortex: Disconnected";
    } else if (busy || queueDepth > 0) {
        badgeText = queueDepth > 0
            ? (queueDepth > 99 ? "99+" : String(queueDepth))
            : "\u2026"; // ellipsis
        badgeColor = "#f1c40f"; // yellow
        tooltip = "Cortex: Connected | Queue: " + queueDepth;
    } else {
        badgeText = "OK";
        badgeColor = "#2ecc71"; // green
        tooltip = "Cortex: Connected | Idle";
    }

    try {
        if (typeof ACT.setBadgeText === "function") {
            ACT.setBadgeText({ text: badgeText });
        }
        if (typeof ACT.setBadgeBackgroundColor === "function") {
            ACT.setBadgeBackgroundColor({ color: badgeColor });
        }
        if (typeof ACT.setTitle === "function") {
            ACT.setTitle({ title: tooltip });
        }
    } catch (e) {
        // best-effort; avoid breaking the extension
    }
}

// Command execution is decoupled from polling so long-running commands cannot
// block the next /pending poll. This keeps `last_poll_ago` low even during
// multi-minute backfills.
const COMMAND_TIMEOUT_MS = 30000; // Default per-command timeout
const LONG_COMMAND_TIMEOUT_MS = 10 * 60 * 1000; // Allow slow commands more time
const LONG_RUNNING_ACTIONS = new Set(["backfill_replied_forwarded"]);

const knownCommandIds = new Set(); // prevents re-enqueueing the same server command
const CANCEL_TTL_MS = 86_400_000; // 24 hours
const CANCEL_MAX_SIZE = 5000;
const cancelledJobIds = new Map(); // job_id -> Date.now() timestamp

function pruneCancelledJobIds() {
    const now = Date.now();
    // Remove expired entries
    for (const [id, ts] of cancelledJobIds) {
        if (now - ts > CANCEL_TTL_MS) cancelledJobIds.delete(id);
    }
    // Enforce size cap — drop oldest if over limit
    if (cancelledJobIds.size > CANCEL_MAX_SIZE) {
        const sorted = [...cancelledJobIds.entries()].sort((a, b) => a[1] - b[1]);
        const toDrop = sorted.length - CANCEL_MAX_SIZE;
        for (let i = 0; i < toDrop; i++) {
            cancelledJobIds.delete(sorted[i][0]);
        }
    }
}
const highCommandQueue = [];
const fastCommandQueue = [];
const slowCommandQueue = [];

let commandWorkerRunning = false;
let slowCommandWorkerRunning = false;

const inFlightCommands = new Map(); // id -> { action, startedAt, lane }

const completionQueue = []; // results pending POST to /tbird-sync/complete
let completionFlushInFlight = false;
let completionFlushTimer = null;

// fetchWithTimeout removed — all IPC goes through WebSocket.

function getCommandTimeoutMs(cmd) {
    const action = cmd && cmd.action ? String(cmd.action) : "";
    return LONG_RUNNING_ACTIONS.has(action) ? LONG_COMMAND_TIMEOUT_MS : COMMAND_TIMEOUT_MS;
}

function safeCommandId(cmd) {
    if (!cmd) return null;
    if (cmd.id != null) return String(cmd.id);
    if (cmd.command_id != null) return String(cmd.command_id);
    return null;
}

function getCommandLane(cmd) {
    const priority = cmd && cmd.priority != null ? String(cmd.priority).toLowerCase() : "normal";
    if (priority === "high") return "high";
    const action = cmd && cmd.action ? String(cmd.action) : "";
    return LONG_RUNNING_ACTIONS.has(action) ? "slow" : "fast";
}

function enqueueCommands(commands) {
    if (!Array.isArray(commands) || commands.length === 0) return 0;

    let enqueued = 0;
    for (const cmd of commands) {
        const id = safeCommandId(cmd);
        if (!id) {
            DebugLogger.log("poll", "Skipping command without id", { action: cmd && cmd.action ? cmd.action : null });
            continue;
        }

        if (knownCommandIds.has(id)) continue;
        knownCommandIds.add(id);

        const lane = getCommandLane(cmd);
        if (lane === "high") {
            highCommandQueue.push(cmd);
        } else if (lane === "slow") {
            slowCommandQueue.push(cmd);
        } else {
            fastCommandQueue.push(cmd);
        }
        enqueued += 1;
    }

    if (enqueued > 0) {
        setIndicator({ connected: connectionState === "CONNECTED", busy: true, queueDepth: getQueueDepth() });
        if (!IS_TEST_MODE) {
            startWorkers();
        }
    }

    return enqueued;
}

/**
 * Remove all queued (not yet in-flight) commands whose id matches the given
 * job_id.  Also clears their entries from knownCommandIds so dedupe won't
 * block future commands that re-use those ids.
 * Returns the number of commands removed.
 */
function removeQueuedCommandsForJob(jobId) {
    if (!jobId) return 0;
    let removed = 0;
    for (const q of [fastCommandQueue, slowCommandQueue]) {
        for (let i = q.length - 1; i >= 0; i--) {
            const cmd = q[i];
            const id = safeCommandId(cmd);
            const cmdJobId = cmd && cmd.job_id != null ? String(cmd.job_id) : null;
            if (id === jobId || cmdJobId === jobId) {
                q.splice(i, 1);
                if (id) knownCommandIds.delete(id);
                removed++;
            }
        }
    }
    return removed;
}

function ensureValidCommandResult(cmd, result, errorMessage) {
    let out = result;
    if (!out || typeof out !== "object") {
        out = { success: false, error: errorMessage || "Exception: invalid result" };
    }
    out.id = cmd && cmd.id != null ? cmd.id : (cmd && cmd.command_id != null ? cmd.command_id : out.id);
    out.action = cmd && cmd.action != null ? cmd.action : out.action;
    if (out.method == null && cmd && cmd.action === "rpc" && cmd.method != null) {
        out.method = cmd.method;
    }
    return out;
}

async function executeCommandWithTimeout(cmd) {
    const id = safeCommandId(cmd);
    const action = cmd && cmd.action ? String(cmd.action) : "";
    const timeoutMs = getCommandTimeoutMs(cmd);
    const startedAt = Date.now();

    const lane = getCommandLane(cmd);
    if (id) {
        inFlightCommands.set(id, { action, startedAt, lane });
    }

    DebugLogger.log("cmd", `Executing: ${action}`, { id, messageId: cmd && cmd.messageId != null ? cmd.messageId : cmd && cmd.message_id });

    let timedOut = false;
    let timerId = null;

    const underlying = (async () => {
        try {
            return await processCommand(cmd);
        } catch (error) {
            const message = error && error.message ? error.message : String(error);
            DebugLogger.log("cmd", "processCommand exception", { action, id, error: String(error) });
            return { success: false, error: "Exception: " + message };
        }
    })();

    const timeoutPromise = new Promise((_, reject) => {
        timerId = setTimeout(() => {
            timedOut = true;
            reject(new Error(`Command timeout after ${timeoutMs}ms`));
        }, timeoutMs);
    });

    let result;
    try {
        result = await Promise.race([underlying, timeoutPromise]);
    } catch (error) {
        if (timedOut) {
            result = { success: false, error: `Timeout after ${timeoutMs}ms` };
            // Prevent unhandled rejections from the underlying promise after timeout.
            underlying
                .then(() => {
                    DebugLogger.log("cmd", "Late command completion ignored", { action, id, timeoutMs });
                })
                .catch((e) => {
                    DebugLogger.log("cmd", "Late command failure ignored", { action, id, timeoutMs, error: String(e) });
                });
        } else {
            const message = error && error.message ? error.message : String(error);
            result = { success: false, error: "Exception: " + message };
        }
    } finally {
        if (timerId) clearTimeout(timerId);
        if (id) inFlightCommands.delete(id);
    }

    const durationMs = Date.now() - startedAt;
    const finalResult = ensureValidCommandResult(cmd, result, "Exception: processCommand returned invalid result");

    DebugLogger.log("cmd", `Result: ${finalResult.success ? "OK" : "FAIL"}`, {
        action,
        id,
        timedOut,
        durationMs,
        error: finalResult.error
    });

    if (!finalResult.success) {
        setIndicator({ connected: connectionState === "CONNECTED", error: finalResult.error });
    }

    return finalResult;
}

function startWorkers() {
    startCommandWorker();
    startSlowCommandWorker();
    scheduleCompletionFlush(0);
}

function startCommandWorker() {
    if (commandWorkerRunning) return;
    if (highCommandQueue.length === 0 && fastCommandQueue.length === 0) return;
    commandWorkerRunning = true;
    runWorkerLoop().catch(() => {}).finally(() => { commandWorkerRunning = false; startCommandWorker(); });
}

function shiftNextCommand() {
    if (highCommandQueue.length > 0) return highCommandQueue.shift();
    if (fastCommandQueue.length > 0) return fastCommandQueue.shift();
    return null;
}

function shiftNextSlowCommand() {
    if (slowCommandQueue.length > 0) return slowCommandQueue.shift();
    return null;
}

async function reportCommandCompletion(result) {
    completionQueue.push(result);
    if (IS_TEST_MODE) {
        await flushCompletions();
    } else {
        scheduleCompletionFlush(0);
    }
}

async function runWorkerLoop() {
    startSlowCommandWorker();
    while (true) {
        const cmd = shiftNextCommand();
        if (!cmd) break;
        if (!cmd) continue;
        const depth = getQueueDepth();
        setIndicator({ connected: connectionState === "CONNECTED", busy: depth > 0, queueDepth: depth });
        const res = await executeCommandWithTimeout(cmd);
        await reportCommandCompletion(res);
    }
    startSlowCommandWorker();
    const depth = getQueueDepth();
    // Foreground queue drained — slow work may still be queued/running.
    setIndicator({ connected: connectionState === "CONNECTED", busy: depth > 0, queueDepth: depth });
}

function startSlowCommandWorker() {
    if (slowCommandWorkerRunning) return;
    if (slowCommandQueue.length === 0) return;
    slowCommandWorkerRunning = true;
    runSlowWorkerLoop().catch(() => {}).finally(() => {
        slowCommandWorkerRunning = false;
        if (slowCommandQueue.length > 0) {
            startSlowCommandWorker();
            return;
        }
        const depth = getQueueDepth();
        setIndicator({ connected: connectionState === "CONNECTED", busy: depth > 0, queueDepth: depth });
    });
}

async function runSlowWorkerLoop() {
    while (true) {
        const cmd = shiftNextSlowCommand();
        if (!cmd) break;
        if (!cmd) continue;
        const depth = getQueueDepth();
        setIndicator({ connected: connectionState === "CONNECTED", busy: true, queueDepth: depth });
        const res = await executeCommandWithTimeout(cmd);
        await reportCommandCompletion(res);
    }
}

function scheduleCompletionFlush(delayMs) {
    if (IS_TEST_MODE) {
        flushCompletions().catch(() => {});
        return;
    }
    if (completionFlushTimer) return;
    completionFlushTimer = setTimeout(() => {
        completionFlushTimer = null;
        flushCompletions().catch(() => {});
    }, Math.max(0, delayMs || 0));
}

async function flushCompletions() {
    if (completionFlushInFlight) return;
    if (completionQueue.length === 0) return;
    completionFlushInFlight = true;

    try {
        if (!isWebSocketOpen()) {
            // WS not connected — keep items queued, retry when WS reconnects
            DebugLogger.log("complete", "WS not open, deferring completions", { queued: completionQueue.length });
            scheduleCompletionFlush(POLL_INTERVAL_MS);
            return;
        }

        while (completionQueue.length > 0) {
            const batch = completionQueue.slice(0, 25);
            const clientId = await getExtensionClientId();
            const stampedBatch = batch.map((result) => ({
                ...(result || {}),
                client_id: clientId,
                clientId
            }));
            const sent = sendWebSocketMessage({
                type: "results",
                client_id: clientId,
                clientId,
                results: stampedBatch,
                data: stampedBatch
            });
            if (!sent) {
                DebugLogger.log("complete", "WS send failed, deferring", { queued: completionQueue.length });
                scheduleCompletionFlush(POLL_INTERVAL_MS);
                return;
            }

            console.log("[WS] Sent completion batch", { count: batch.length, remaining: completionQueue.length - batch.length });
            completionQueue.splice(0, batch.length);
            for (const r of batch) {
                const id = r && r.id != null ? String(r.id) : null;
                if (id) knownCommandIds.delete(id);
            }

            DebugLogger.log("complete", "Posted results via WS", { sent: batch.length, remaining: completionQueue.length });
        }
    } finally {
        completionFlushInFlight = false;
    }
}

// markPollSuccess / markPollFailure removed — WebSocket handles connection state.

// pollForCommands removed — commands arrive exclusively via WebSocket.

if (!IS_TEST_MODE) {
    initEventPush().catch(() => {});
}
const toolbarClickEvent =
    (messenger.action && messenger.action.onClicked) ||
    (messenger.browserAction && messenger.browserAction.onClicked);
safeAddListener(toolbarClickEvent, () => {
    handleToolbarClick();
});

registerDiagnosticsMenu();
const menuClickEvent = messenger.menus && messenger.menus.onClicked;
safeAddListener(menuClickEvent, (info) => {
    if (info && info.menuItemId === "export-diagnostics") {
        return exportDiagnostics({ source: "menu" }).catch((error) => {
            DebugLogger.log("diagnostics", "Export diagnostics menu failed", { error: String(error) });
        });
    }
    return undefined;
});

const commandEvent = messenger.commands && messenger.commands.onCommand;
safeAddListener(commandEvent, (command) => {
    if (command === "export-diagnostics") {
        return exportDiagnostics({ source: "command" }).catch((error) => {
            DebugLogger.log("diagnostics", "Export diagnostics command failed", { error: String(error) });
        });
    }
    return undefined;
});

// HTTP polling watchdog and pollLoop removed — WebSocket is the sole transport.

console.log("[cortex1-tbird-sync] background.js loaded, IS_TEST_MODE:", IS_TEST_MODE);
// Set initial indicator to disconnected before WS connects
setIndicator({ connected: false });

if (!IS_TEST_MODE) {
    // WebSocket is the sole IPC transport to cortex-server.
    console.log("[cortex1-tbird-sync] Connecting via WebSocket...");
    connectWebSocket();
} else {
    console.log("[cortex1-tbird-sync] TEST MODE - WebSocket not started");
}

// =============================================================================
// Push-based new email notification for pending_ingest queue
// Posts to /tbird-sync/new-email so cortex can ingest emails regardless of read status
// =============================================================================

const NEW_EMAIL_DEBOUNCE_MS = 100;
let newEmailBatch = [];
let newEmailTimer = null;
const NEW_EMAIL_POLL_MS = 30000;
let newEmailPollTimer = null;
let newEmailPollInFlight = false;
let newEmailLastCheckMs = 0;
const newEmailSeenIds = new Map();

async function resolveNewEmailMessageId(msg) {
    if (msg && msg.headerMessageId) {
        return String(msg.headerMessageId).trim();
    }
    const msgId = msg && msg.id;
    if (!msgId || !messenger.messages || !messenger.messages.getFull) {
        return "";
    }
    try {
        const full = await messenger.messages.getFull(msgId);
        const headers = full && full.headers ? full.headers : {};
        const rawId = headers["message-id"] || headers["message_id"];
        if (Array.isArray(rawId)) {
            return String(rawId[0] || "").trim();
        }
        if (rawId) {
            return String(rawId).trim();
        }
    } catch (error) {
        DebugLogger.log("new-email", "Header lookup failed", { error: String(error) });
    }
    return "";
}

async function flushNewEmailBatch() {
    if (!isWebSocketOpen()) {
        // WS not open — keep items in newEmailBatch, retry when WS reconnects
        DebugLogger.log("new-email", "WS not open, deferring new-email batch", { queued: newEmailBatch.length });
        return;
    }

    const batch = newEmailBatch.splice(0);
    if (!batch.length) return;

    for (const payload of batch) {
        const event = { type: "new_email", ...payload };
        const sent = sendWebSocketMessage({ type: "event", event, data: event });
        if (!sent) {
            // Put unsent items back at the front
            newEmailBatch.unshift(...batch.slice(batch.indexOf(payload)));
            DebugLogger.log("new-email", "WS send failed mid-batch, re-queued", { queued: newEmailBatch.length });
            return;
        }
        DebugLogger.log("new-email", "Posted new email via WS", { message_id: payload.message_id });
    }
}

async function queueNewEmail(payload) {
    newEmailBatch.push(payload);
    if (IS_TEST_MODE) {
        await flushNewEmailBatch().catch((error) => DebugLogger.log("new-email", "Flush error", { error: String(error) }));
        return;
    }
    if (newEmailTimer) return;
    newEmailTimer = setTimeout(() => {
        newEmailTimer = null;
        flushNewEmailBatch().catch((error) => DebugLogger.log("new-email", "Flush error", { error: String(error) }));
    }, NEW_EMAIL_DEBOUNCE_MS);
}

function pruneNewEmailSeen(limit = 2000, maxAgeMs = 6 * 60 * 60 * 1000) {
    const now = Date.now();
    for (const [key, ts] of newEmailSeenIds.entries()) {
        if (now - ts > maxAgeMs) {
            newEmailSeenIds.delete(key);
        }
    }
    if (newEmailSeenIds.size <= limit) return;
    const entries = Array.from(newEmailSeenIds.entries()).sort((a, b) => a[1] - b[1]);
    const toRemove = entries.length - limit;
    for (let i = 0; i < toRemove; i += 1) {
        newEmailSeenIds.delete(entries[i][0]);
    }
}

async function getInboxFolders() {
    if (!messenger.accounts || !messenger.accounts.list) return [];
    const accounts = await messenger.accounts.list();
    const inboxFolders = [];
    for (const account of accounts || []) {
        const folders = [];
        for (const root of Array.isArray(account.folders) ? account.folders : []) {
            walkFolderTree(root, folders);
        }
        for (const folder of folders) {
            if (!folder) continue;
            const name = String(folder.name || "").toLowerCase();
            const path = String(folder.path || "").toLowerCase();
            if (folder.type === "inbox" || name === "inbox" || path === "/inbox") {
                inboxFolders.push(folder);
                break;
            }
        }
    }
    return inboxFolders;
}

async function pollForNewEmails() {
    if (newEmailPollInFlight) return;
    newEmailPollInFlight = true;
    try {
        const now = Date.now();
        const cutoffMs = newEmailLastCheckMs || (now - (5 * 60 * 1000));
        const folders = await getInboxFolders();
        for (const folder of folders) {
            for await (const msg of iterateFolderMessagesSince(folder, cutoffMs, 100)) {
                const messageId = await resolveNewEmailMessageId(msg);
                if (!messageId) continue;
                if (newEmailSeenIds.has(messageId)) continue;
                newEmailSeenIds.set(messageId, now);
                await queueNewEmail({
                    message_id: messageId,
                    account_id: folder && folder.accountId,
                    folder_path: folder && folder.path,
                    subject: msg && msg.subject,
                    from: msg && msg.author,
                    date: msg && msg.date ? new Date(msg.date).toISOString() : null
                });
            }
        }
        pruneNewEmailSeen();
        newEmailLastCheckMs = now;
    } catch (error) {
        DebugLogger.log("new-email", "Poll failed", { error: String(error) });
    } finally {
        newEmailPollInFlight = false;
    }
}

// Register listener for push-based ingest (separate from event push)
safeAddListener(messenger.messages && messenger.messages.onNewMailReceived, async (folder, messageList) => {
    const messages = messageList && messageList.messages ? messageList.messages : [];
    for (const msg of messages) {
        const messageId = await resolveNewEmailMessageId(msg);
        if (!messageId) {
            DebugLogger.log("new-email", "Missing message-id", { msg_id: msg && msg.id });
            continue;
        }
        await queueNewEmail({
            message_id: messageId,
            account_id: folder && folder.accountId,
            folder_path: folder && folder.path,
            subject: msg && msg.subject,
            from: msg && msg.author,
            date: msg && msg.date ? new Date(msg.date).toISOString() : null
        });
    }
}, true);

if (!IS_TEST_MODE) {
    pollForNewEmails().catch((error) => DebugLogger.log("new-email", "Poll failed", { error: String(error) }));
    newEmailPollTimer = setInterval(() => {
        pollForNewEmails().catch((error) => DebugLogger.log("new-email", "Poll failed", { error: String(error) }));
    }, NEW_EMAIL_POLL_MS);
}

// Log startup
DebugLogger.log("startup", `Cortex1 Thunderbird Sync v${getExtensionVersion()} loaded`, { transport: "websocket" });

console.log(
    `Cortex1 Thunderbird Sync v${getExtensionVersion()} loaded - WebSocket IPC`
);

// Expose test helpers when running under Node/Jest.
// Thunderbird does not provide `module.exports`, so this is a no-op in production.
if (typeof module !== "undefined" && module && module.exports) {
    module.exports = {
        // Helper functions
        minifyMessageHeader,
        minifyFolder,
        buildTbState,
        buildAuditedMessageHeader,
        safeAuditValue,
        listMissingFields,
        buildAttachmentManifestFromFull,
        getStateAuditByHeaderId,
        TBIRD_NOT_BIDIRECTIONALLY_SYNCED_ATTRIBUTES,
        findMessageByHeaderId,
        findFolder,

        // Action handlers
        markAsRead,
        markAsUnread,
        setFlagged,
        openMessage,
        archiveMessages,
        deleteMessages,
        moveMessages,
        bulkMarkRead,
        createReplyDraft,
        sendReply,
        getMessageStatus,
        bulkGetStatus,
        listFolders,

        // RPC
        executeRpcCommand,
        cortexRpc,
        isAllowedRpcMethodPath,
        getRpcFunctionByPath,
        sanitizeRpcResult,

        // Command processing
        processCommand,
        executeCommandWithTimeout,
        ensureValidCommandResult,
        enqueueCommands,
        runWorkerLoop,

        // Event system
        enqueueEvent,
        flushEventQueue,
        postEventBatch,
        ensureEventQueueLoaded,
        pollForNewEmails,

        // WebSocket (sole IPC transport)
        isWebSocketOpen,
        sendWebSocketMessage,
        connectWebSocket,
        scheduleReconnect,
        getCortexServerUrl,
        getWebSocketUrl,
        getExtensionClientId,
        normalizeLoopbackServerUrl,
        _setWs: function(mockWs) { ws = mockWs; },
        _getWs: function() { return ws; },
        _getConnectionState: function() { return connectionState; },
        _getReconnectAttempts: function() { return wsReconnectAttempts; },

        // Diagnostics
        DebugLogger,
        FailureTracker,
        exportDiagnostics,
        buildDiagnosticsPayload,

        // Tag handling
        handleSetTags,

        // Backfill
        handleBackfillRepliedForwarded,

        // Cancel
        cancelledJobIds,
        pruneCancelledJobIds,
        removeQueuedCommandsForJob,
        CANCEL_TTL_MS,
        CANCEL_MAX_SIZE,

        // Queues (test access)
        highCommandQueue,
        fastCommandQueue,
        slowCommandQueue,
        knownCommandIds,

        // Indicator
        setIndicator,
        getQueueDepth,
        get ACT() { return ACT; },

        // Constants
        DEFAULT_CORTEX_SERVER,
        POLL_INTERVAL_MS,
        EVENT_QUEUE_LIMIT,
        EVENT_BATCH_SIZE,
        DEBUG_MAX_ENTRIES,
        FAILURE_MAX_ENTRIES
    };
}
