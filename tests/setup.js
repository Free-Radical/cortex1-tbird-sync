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
            getHeaders: jest.fn(),
            getRaw: jest.fn(),
            listAttachments: jest.fn(),
            onNewMailReceived: {
                addListener: jest.fn()
            },
            tags: {
                list: jest.fn(),
                create: jest.fn(),
                update: jest.fn(),
                delete: jest.fn()
            }
        },
        folders: {
            get: jest.fn(),
            getFolderInfo: jest.fn(),
            getCapabilities: jest.fn(),
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
            getManifest: jest.fn(() => ({ version: "1.6.7" })),
            id: "cortex1-tbird-sync@example.com"
        },
        downloads: {
            download: jest.fn()
        },
        menus: {
            create: jest.fn(),
            onClicked: {
                addListener: jest.fn()
            }
        },
        action: {
            onClicked: {
                addListener: jest.fn()
            },
            setBadgeText: jest.fn(),
            setBadgeBackgroundColor: jest.fn(),
            setTitle: jest.fn()
        },
        browserAction: {
            onClicked: {
                addListener: jest.fn()
            },
            setBadgeText: jest.fn(),
            setBadgeBackgroundColor: jest.fn(),
            setTitle: jest.fn()
        },
        commands: {
            onCommand: {
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

    // Signal background.js to skip auto-poll/event init during tests
    global.CORTEX_TEST_MODE = true;

    // Create fresh messenger mock
    mockMessenger = createMockMessenger();
    global.messenger = mockMessenger;

    // Mock fetch
    global.fetch = jest.fn();

    // Node test environments may not provide WebSocket. Individual transport
    // tests can still replace this with a constructor when they need lifecycle
    // coverage.
    if (!global.WebSocket) {
        global.WebSocket = { OPEN: 1, CONNECTING: 0, CLOSING: 2, CLOSED: 3 };
    }

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
        // Clear Jest's module registry so background.js state is fresh and coverage-instrumented.
        jest.resetModules();
        delete require.cache[require.resolve("../background.js")];
        return require("../background.js");
    }
};
