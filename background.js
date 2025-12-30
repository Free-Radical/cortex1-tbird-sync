/**
 * Cortex1 Thunderbird Sync - Background Script
 *
 * Features:
 * 1. Polls cortex_server for pending sync commands (mark read/unread, flagged)
 * 2. Handles thunderlink:// URLs to open messages in Thunderbird
 *
 * No native messaging required - just install the .xpi.
 */

const CORTEX_SERVER = "http://localhost:5001";
const POLL_INTERVAL_MS = 3000;  // Poll every 3 seconds

let isPolling = false;

// =============================================================================
// Message Lookup
// =============================================================================

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

// =============================================================================
// Sync Actions
// =============================================================================

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
 * Open/display a message in Thunderbird
 */
async function openMessage(messageId) {
    const message = await findMessageByHeaderId(messageId);
    if (!message) {
        return { success: false, error: "Message not found", messageId };
    }
    try {
        // Open message in a new tab or window
        await messenger.messageDisplay.open({
            messageId: message.id,
            location: "tab"
        });
        return { success: true, messageId, action: "open_message" };
    } catch (error) {
        return { success: false, error: error.message, messageId };
    }
}

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
        default:
            return { success: false, error: "Unknown action: " + cmd.action };
    }
}

// =============================================================================
// Polling
// =============================================================================

/**
 * Poll cortex_server for pending commands
 */
async function pollForCommands() {
    if (isPolling) return;
    isPolling = true;

    try {
        const response = await fetch(`${CORTEX_SERVER}/tbird-sync/pending`, {
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

        await fetch(`${CORTEX_SERVER}/tbird-sync/complete`, {
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

// =============================================================================
// ThunderLink Protocol Handler
// =============================================================================

/**
 * Parse a thunderlink URL and extract the message ID
 * Formats supported:
 *   thunderlink://messageid=<id>
 *   thunderlink://messageid=<id>&action=open
 */
function parseThunderlinkUrl(url) {
    // Handle the redirected URL format from protocol_handlers
    // https://thunderlink.invalid/?msgid=messageid%3D<actual-id>
    if (url.includes("thunderlink.invalid")) {
        const urlObj = new URL(url);
        let msgidParam = urlObj.searchParams.get("msgid");
        if (msgidParam) {
            // The msgid contains the original thunderlink path: "messageid=xxx"
            msgidParam = decodeURIComponent(msgidParam);
            const match = msgidParam.match(/messageid=([^&]+)/i);
            if (match) {
                return decodeURIComponent(match[1]);
            }
        }
    }

    // Handle direct thunderlink:// format
    const match = url.match(/thunderlink:\/\/messageid=([^&]+)/i);
    if (match) {
        return decodeURIComponent(match[1]);
    }

    return null;
}

/**
 * Handle thunderlink URL - find and display the message
 */
async function handleThunderlink(messageId) {
    console.log("ThunderLink: Opening message", messageId);

    const message = await findMessageByHeaderId(messageId);
    if (!message) {
        console.error("ThunderLink: Message not found:", messageId);
        return false;
    }

    try {
        // Open message in a new tab
        await messenger.messageDisplay.open({
            messageId: message.id,
            location: "tab"
        });
        console.log("ThunderLink: Message opened successfully");
        return true;
    } catch (error) {
        console.error("ThunderLink: Error opening message:", error);
        return false;
    }
}

/**
 * Listen for tab updates to intercept thunderlink URLs
 */
messenger.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.url) {
        const messageId = parseThunderlinkUrl(changeInfo.url);
        if (messageId) {
            // Close the dummy tab that was opened
            try {
                await messenger.tabs.remove(tabId);
            } catch (e) {
                // Tab may already be closed
            }

            // Open the actual message
            await handleThunderlink(messageId);
        }
    }
});

// Also listen for new tabs (some TB versions)
messenger.tabs.onCreated.addListener(async (tab) => {
    if (tab.url) {
        const messageId = parseThunderlinkUrl(tab.url);
        if (messageId) {
            // Close the dummy tab
            try {
                await messenger.tabs.remove(tab.id);
            } catch (e) {
                // Tab may already be closed
            }

            // Open the actual message
            await handleThunderlink(messageId);
        }
    }
});

// =============================================================================
// Initialization
// =============================================================================

setInterval(pollForCommands, POLL_INTERVAL_MS);
pollForCommands();

console.log("Cortex1 Thunderbird Sync v1.1.0 loaded");
console.log("  - Polling cortex_server every " + (POLL_INTERVAL_MS/1000) + "s");
console.log("  - ThunderLink protocol handler active");
