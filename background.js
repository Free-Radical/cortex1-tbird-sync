/**
 * Cortex1 Thunderbird Sync - Background Script
 *
 * Polls cortex_server for pending sync commands and executes them.
 * No native messaging required - just install the .xpi.
 */

const CORTEX_SERVER = "http://localhost:5001";
const POLL_INTERVAL_MS = 3000;  // Poll every 3 seconds

let isPolling = false;

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

setInterval(pollForCommands, POLL_INTERVAL_MS);
pollForCommands();

console.log("Cortex1 Thunderbird Sync loaded - polling every " + (POLL_INTERVAL_MS/1000) + "s");
