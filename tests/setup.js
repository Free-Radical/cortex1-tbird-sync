/**
 * Jest Test Setup - Mock Thunderbird WebExtension APIs
 *
 * This file sets up all the mocks needed to test background.js
 * without requiring an actual Thunderbird instance.
 */

// ============================================================================
// Mock Data Factories
// ============================================================================

const createMockMessage = (overrides = {}) => ({
    id: 12345,
    headerMessageId: "test-msg-id@example.com",
    subject: "Test Subject",
    author: "sender@example.com",
    recipients: ["recipient@example.com"],
    ccList: [],
    bccList: [],
    date: new Date("2025-01-05T10:30:00.000Z"),
    read: false,
    flagged: false,
    junk: false,
    tags: [],
    size: 12345,
    folder: {
        accountId: "account1",
        path: "/INBOX",
        name: "Inbox",
        type: "inbox",
        specialUse: ["inbox"],
        isFavorite: false,
        isRoot: false
    },
    ...overrides
});

const createMockFolder = (overrides = {}) => ({
    accountId: "account1",
    path: "/INBOX",
    name: "Inbox",
    type: "inbox",
    specialUse: ["inbox"],
    isFavorite: false,
    isRoot: false,
    subFolders: [],
    ...overrides
});

const createMockAccount = (overrides = {}) => ({
    id: "account1",
    name: "Test Account",
    type: "imap",
    identities: [{ id: "identity1", email: "test@example.com" }],
    folders: [createMockFolder()],
    ...overrides
});

// ============================================================================
// Mock Messenger API
// ============================================================================

const createMockMessenger = () => {
    const mockStorage = {
        data: {},
        local: {
            get: jest.fn(async (keys) => {
                if (Array.isArray(keys)) {
                    const result = {};
                    keys.forEach(k => {
                        if (mockStorage.data[k] !== undefined) {
                            result[k] = mockStorage.data[k];
                        }
                    });
                    return result;
                }
                if (typeof keys === "string") {
                    return { [keys]: mockStorage.data[keys] };
                }
                return mockStorage.data;
            }),
            set: jest.fn(async (obj) => {
                Object.assign(mockStorage.data, obj);
            })
        },
        _setData: (data) => { mockStorage.data = { ...data }; },
        _clear: () => { mockStorage.data = {}; }
    };

    return {
        messages: {
            get: jest.fn(),
            update: jest.fn(),
            archive: jest.fn(),
            move: jest.fn(),
            copy: jest.fn(),
            delete: jest.fn(),
            list: jest.fn(),
            continueList: jest.fn(),
            query: jest.fn(),
            getFull: jest.fn(),
            getRaw: jest.fn(),
            tags: {
                list: jest.fn(),
                create: jest.fn(),
                update: jest.fn(),
                delete: jest.fn()
            }
        },
        folders: {
            get: jest.fn(),
            query: jest.fn(),
            create: jest.fn(),
            rename: jest.fn(),
            move: jest.fn(),
            delete: jest.fn()
        },
        accounts: {
            list: jest.fn(),
            get: jest.fn()
        },
        identities: {
            list: jest.fn(),
            get: jest.fn()
        },
        messageDisplay: {
            open: jest.fn(),
            getDisplayedMessage: jest.fn()
        },
        compose: {
            beginReply: jest.fn(),
            beginForward: jest.fn(),
            beginNew: jest.fn(),
            sendMessage: jest.fn(),
            getComposeDetails: jest.fn(),
            setComposeDetails: jest.fn()
        },
        storage: mockStorage,
        runtime: {
            getManifest: jest.fn(() => ({ version: "1.6.5" })),
            id: "cortex1-tbird-sync@example.com"
        },
        action: {
            onClicked: {
                addListener: jest.fn()
            }
        },
        browserAction: {
            onClicked: {
                addListener: jest.fn()
            }
        },
        // Helper to access mock storage data
        _storage: mockStorage
    };
};

// ============================================================================
// Global Setup
// ============================================================================

// Create fresh mock for each test
let mockMessenger;

beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();
    jest.useFakeTimers();

    // Create fresh messenger mock
    mockMessenger = createMockMessenger();
    global.messenger = mockMessenger;

    // Mock fetch
    global.fetch = jest.fn();

    // Mock console methods
    global.console = {
        ...console,
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn()
    };

    // Mock crypto.randomUUID
    global.crypto = {
        randomUUID: jest.fn(() => "mock-uuid-" + Math.random().toString(36).substr(2, 9))
    };

    // Setup default successful responses
    mockMessenger.accounts.list.mockResolvedValue([createMockAccount()]);
    mockMessenger.folders.query.mockResolvedValue([createMockFolder()]);
});

afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
});

// ============================================================================
// Export Helpers for Tests
// ============================================================================

module.exports = {
    createMockMessage,
    createMockFolder,
    createMockAccount,
    createMockMessenger,
    getMockMessenger: () => mockMessenger,

    // Helper to load background.js functions
    loadBackgroundScript: () => {
        // Clear module cache to get fresh instance
        delete require.cache[require.resolve("../background.js")];

        // We need to extract functions from background.js
        // Since it's not a module, we'll read and eval it
        const fs = require("fs");
        const path = require("path");
        const scriptPath = path.join(__dirname, "..", "background.js");
        const scriptContent = fs.readFileSync(scriptPath, "utf8");

        // Create a sandbox to execute the script
        const sandbox = {
            messenger: global.messenger,
            fetch: global.fetch,
            console: global.console,
            crypto: global.crypto,
            Date: global.Date,
            setTimeout: global.setTimeout,
            setInterval: global.setInterval,
            clearTimeout: global.clearTimeout,
            clearInterval: global.clearInterval,
            Math: global.Math,
            JSON: global.JSON,
            Array: global.Array,
            Object: global.Object,
            String: global.String,
            Number: global.Number,
            Boolean: global.Boolean,
            Error: global.Error,
            Promise: global.Promise,
            Map: global.Map,
            Set: global.Set,
            AbortController: global.AbortController,
            AbortSignal: global.AbortSignal,
            // Pre-create __exports__ so it's accessible after vm.runInContext
            __exports__: {}
        };

        // Execute script and capture exported functions
        const vm = require("vm");
        const context = vm.createContext(sandbox);

        // Wrap script to expose functions
        const wrappedScript = `
            ${scriptContent}

            // Export functions for testing (assign to pre-created __exports__ object)
            Object.assign(__exports__, {
                // Helper functions
                minifyMessageHeader,
                minifyFolder,
                buildTbState,
                findMessageByHeaderId,
                findFolder,

                // Action handlers
                markAsRead,
                markAsUnread,
                setFlagged,
                openMessage,
                archiveMessages,
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
                pollForCommands,

                // Event system
                enqueueEvent,
                flushEventQueue,
                postEventBatch,
                ensureEventQueueLoaded,

                // Debug logger
                DebugLogger,

                // Tag handling
                handleSetTags,

                // Backfill
                handleBackfillRepliedForwarded,

                // Constants
                DEFAULT_CORTEX_SERVER,
                POLL_INTERVAL_MS,
                EVENT_QUEUE_LIMIT,
                EVENT_BATCH_SIZE,
                DEBUG_MAX_ENTRIES
            });
        `;

        vm.runInContext(wrappedScript, context);

        return context.__exports__;
    }
};
