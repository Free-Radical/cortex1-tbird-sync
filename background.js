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
        // Discovery
        case "list_folders":
            return await listFolders();
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

console.log("Cortex1 Thunderbird Sync v1.3.0 loaded - polling every " + (POLL_INTERVAL_MS/1000) + "s");
