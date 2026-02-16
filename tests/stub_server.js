/**
 * Stub Cortex Server for tbird-sync load testing.
 *
 * Simulates cortex_server endpoints for testing without requiring the real server.
 *
 * Usage:
 *   node tests/stub_server.js [port]
 *
 * Endpoints:
 *   GET  /tbird-sync/pending   - Returns pending commands (configurable)
 *   POST /tbird-sync/new-email - Accepts new email notifications
 *   POST /tbird-sync/complete  - Accepts command completion results
 *   GET  /tbird-sync/status    - Returns server status
 *   POST /tbird-sync/events    - Accepts event batches
 *
 * Control endpoints (for tests):
 *   POST /test/add-command     - Add a command to pending queue
 *   POST /test/clear           - Clear all state
 *   GET  /test/stats           - Get statistics
 *   POST /test/set-delay       - Set response delay (ms)
 */

const http = require("http");
const WebSocket = require("ws");

const PORT = parseInt(process.argv[2] || "5001", 10);

// Server state
let pendingCommands = [];
let completedResults = [];
let receivedEmails = [];
let receivedEvents = [];
let pollCount = 0;
let lastPollAt = null;
let responseDelayMs = 0;

// Stats
const stats = {
    pendingPolls: 0,
    emailsReceived: 0,
    commandsCompleted: 0,
    eventsReceived: 0,
    errors: 0,
};

function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = "";
        req.on("data", chunk => body += chunk);
        req.on("end", () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (e) {
                reject(e);
            }
        });
        req.on("error", reject);
    });
}

function sendJson(res, data, status = 200) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
}

async function handleRequest(req, res) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const path = url.pathname;
    const method = req.method;

    // Apply configured delay
    if (responseDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, responseDelayMs));
    }

    try {
        // === tbird-sync endpoints ===

        if (path === "/tbird-sync/pending" && method === "GET") {
            pollCount++;
            lastPollAt = new Date().toISOString();
            stats.pendingPolls++;

            const commands = pendingCommands.splice(0);  // Return and clear
            sendJson(res, { commands });
            return;
        }

        if (path === "/tbird-sync/new-email" && method === "POST") {
            const body = await parseBody(req);
            receivedEmails.push({
                ...body,
                received_at: new Date().toISOString(),
            });
            stats.emailsReceived++;
            sendJson(res, { status: "queued", message_id: body.message_id });
            return;
        }

        if (path === "/tbird-sync/complete" && method === "POST") {
            const body = await parseBody(req);
            const results = body.results || [];
            completedResults.push(...results);
            stats.commandsCompleted += results.length;
            sendJson(res, { status: "ok", processed: results.length });
            return;
        }

        if (path === "/tbird-sync/events" && method === "POST") {
            const body = await parseBody(req);
            const events = body.events || [];
            receivedEvents.push(...events);
            stats.eventsReceived += events.length;
            sendJson(res, { status: "ok", processed: events.length });
            return;
        }

        if (path === "/tbird-sync/status" && method === "GET") {
            sendJson(res, {
                pending_count: pendingCommands.length,
                last_pending_served_at: lastPollAt,
                paused: false,
                connection: {
                    connected: lastPollAt !== null,
                    last_poll_ago: lastPollAt
                        ? Math.floor((Date.now() - new Date(lastPollAt).getTime()) / 1000)
                        : null,
                },
            });
            return;
        }

        // === Test control endpoints ===

        if (path === "/test/add-command" && method === "POST") {
            const body = await parseBody(req);
            const cmd = {
                id: body.id || `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                action: body.action || "get_status",
                ...body,
            };
            pendingCommands.push(cmd);
            // Broadcast to WebSocket clients
            if (wsClients.size > 0) {
                broadcastCommand(cmd);
            }
            sendJson(res, { status: "added", command: cmd });
            return;
        }

        if (path === "/test/add-commands" && method === "POST") {
            const body = await parseBody(req);
            const commands = body.commands || [];
            for (const cmd of commands) {
                pendingCommands.push({
                    id: cmd.id || `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                    action: cmd.action || "get_status",
                    ...cmd,
                });
            }
            sendJson(res, { status: "added", count: commands.length });
            return;
        }

        if (path === "/test/clear" && method === "POST") {
            pendingCommands = [];
            completedResults = [];
            receivedEmails = [];
            receivedEvents = [];
            pollCount = 0;
            lastPollAt = null;
            Object.keys(stats).forEach(k => stats[k] = 0);
            sendJson(res, { status: "cleared" });
            return;
        }

        if (path === "/test/stats" && method === "GET") {
            sendJson(res, {
                ...stats,
                pollCount,
                lastPollAt,
                pendingCommands: pendingCommands.length,
                completedResults: completedResults.length,
                receivedEmails: receivedEmails.length,
                receivedEvents: receivedEvents.length,
            });
            return;
        }

        if (path === "/test/set-delay" && method === "POST") {
            const body = await parseBody(req);
            responseDelayMs = parseInt(body.delay_ms || "0", 10);
            sendJson(res, { status: "ok", delay_ms: responseDelayMs });
            return;
        }

        if (path === "/test/received-emails" && method === "GET") {
            sendJson(res, { emails: receivedEmails });
            return;
        }

        if (path === "/test/completed-results" && method === "GET") {
            sendJson(res, { results: completedResults });
            return;
        }

        // Health check
        if (path === "/" && method === "GET") {
            sendJson(res, { status: "ok", name: "stub-cortex-server" });
            return;
        }

        // 404
        stats.errors++;
        sendJson(res, { error: "Not found", path }, 404);

    } catch (error) {
        stats.errors++;
        sendJson(res, { error: error.message }, 500);
    }
}

const server = http.createServer(handleRequest);

// ============================================================================
// WebSocket Server for real-time command push
// ============================================================================

const wss = new WebSocket.Server({ server });
const wsClients = new Set();

wss.on('connection', (ws) => {
    console.log('[STUB-WS] Client connected');
    wsClients.add(ws);

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            handleWebSocketMessage(ws, msg);
        } catch (error) {
            console.error('[STUB-WS] Failed to parse message:', error);
        }
    });

    ws.on('close', () => {
        console.log('[STUB-WS] Client disconnected');
        wsClients.delete(ws);
    });

    ws.on('error', (error) => {
        console.error('[STUB-WS] Error:', error);
    });

    // Send ALL pending commands via WS when client connects
    for (const cmd of pendingCommands) {
        ws.send(JSON.stringify({
            type: 'command',
            data: cmd
        }));
    }
});

function handleWebSocketMessage(ws, msg) {
    const { type, data } = msg;

    switch (type) {
        case 'result':
            // Store result
            completedResults.push(data);
            stats.commandsCompleted++;
            // Remove from pending
            const idx = pendingCommands.findIndex(c => c.id === data.id);
            if (idx >= 0) {
                pendingCommands.splice(idx, 1);
            }
            // Note: Don't send next command here - commands are pushed when added
            break;

        case 'event':
            // Store event
            if (data.events) {
                receivedEvents.push(...data.events);
                stats.eventsReceived += data.events.length;
            } else {
                receivedEvents.push(data);
                stats.eventsReceived++;
            }
            break;

        case 'pong':
            // Acknowledge pong (connection is alive)
            break;

        default:
            console.warn('[STUB-WS] Unknown message type:', type);
    }
}

// Helper to broadcast commands via WebSocket
function broadcastCommand(command) {
    const msg = JSON.stringify({
        type: 'command',
        data: command
    });
    wsClients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(msg);
        }
    });
}

server.listen(PORT, () => {
    console.log(`Stub Cortex Server running on http://localhost:${PORT}`);
    console.log(`WebSocket endpoint: ws://localhost:${PORT}/tbird-sync/ws`);
    console.log("Endpoints:");
    console.log("  GET  /tbird-sync/pending");
    console.log("  POST /tbird-sync/new-email");
    console.log("  POST /tbird-sync/complete");
    console.log("  GET  /tbird-sync/status");
    console.log("  POST /tbird-sync/events");
    console.log("  WS   /tbird-sync/ws (NEW)");
    console.log("Control:");
    console.log("  POST /test/add-command");
    console.log("  POST /test/clear");
    console.log("  GET  /test/stats");
    console.log("  POST /test/set-delay");
});

// Export for programmatic use
module.exports = { server, PORT };
