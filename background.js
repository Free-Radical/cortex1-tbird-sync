/**
 * Cortex1 Thunderbird Sync - Background Script
 *
 * Receives commands from native messaging host and updates message status
 * in Thunderbird using the messenger.messages API.
 *
 * Supported commands:
 *   - mark_read: Mark message as read by Message-ID header
 *   - mark_unread: Mark message as unread
 *   - mark_flagged: Toggle flagged status
 *   - get_status: Get current message status
 */

const NATIVE_HOST = "cortex1_tbird_sync";

let port = null;

/**
 * Find a message by its Message-ID header
 * @param {string} messageId - The Message-ID header value
 * @returns {Promise<object|null>} The message object or null if not found
 */
async function findMessageByHeaderId(messageId) {
    // Clean up message ID - remove angle brackets if present
    let cleanId = messageId.trim();
    if (cleanId.startsWith("<")) cleanId = cleanId.slice(1);
    if (cleanId.endsWith(">")) cleanId = cleanId.slice(0, -1);

    try {
        const result = await messenger.messages.query({
            headerMessageId: cleanId
        });

        if (result.messages && result.messages.length > 0) {
            return result.messages[0];
        }
        return null;
    } catch (error) {
        console.error("Error finding message:", error);
        return null;
    }
}

/**
 * Mark a message as read
 * @param {string} messageId - The Message-ID header value
 * @returns {Promise<object>} Result with success status
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
 * @param {string} messageId - The Message-ID header value
 * @returns {Promise<object>} Result with success status
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
 * Toggle or set flagged status
 * @param {string} messageId - The Message-ID header value
 * @param {boolean} flagged - Whether to flag or unflag
 * @returns {Promise<object>} Result with success status
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
 * Get current status of a message
 * @param {string} messageId - The Message-ID header value
 * @returns {Promise<object>} Message status or error
 */
async function getStatus(messageId) {
    const message = await findMessageByHeaderId(messageId);
    if (!message) {
        return { success: false, error: "Message not found", messageId };
    }

    return {
        success: true,
        messageId,
        status: {
            read: message.read,
            flagged: message.flagged,
            subject: message.subject,
            author: message.author,
            date: message.date
        }
    };
}

/**
 * Handle incoming command from native messaging host
 * @param {object} command - The command object
 */
async function handleCommand(command) {
    console.log("Received command:", command);

    let result;

    switch (command.action) {
        case "mark_read":
            result = await markAsRead(command.messageId);
            break;
        case "mark_unread":
            result = await markAsUnread(command.messageId);
            break;
        case "set_flagged":
            result = await setFlagged(command.messageId, command.flagged !== false);
            break;
        case "get_status":
            result = await getStatus(command.messageId);
            break;
        case "ping":
            result = { success: true, action: "pong", version: "1.0.0" };
            break;
        default:
            result = { success: false, error: "Unknown action: " + command.action };
    }

    // Send result back through native messaging
    if (port) {
        port.postMessage(result);
    }

    return result;
}

/**
 * Connect to native messaging host
 */
function connectToNativeHost() {
    try {
        port = messenger.runtime.connectNative(NATIVE_HOST);

        port.onMessage.addListener((message) => {
            handleCommand(message);
        });

        port.onDisconnect.addListener(() => {
            console.log("Native host disconnected");
            port = null;
            // Attempt to reconnect after a delay
            setTimeout(connectToNativeHost, 5000);
        });

        console.log("Connected to native host:", NATIVE_HOST);

    } catch (error) {
        console.error("Failed to connect to native host:", error);
        // Retry after delay
        setTimeout(connectToNativeHost, 10000);
    }
}

// Initialize connection on startup
connectToNativeHost();

console.log("Cortex1 Thunderbird Sync extension loaded");
