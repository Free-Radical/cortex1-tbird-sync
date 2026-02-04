# cortex1-tbird-sync

Thunderbird extension that syncs message status with cortex_server via **WebSocket IPC** (primary) with HTTP polling fallback.

## Overview

The extension communicates with cortex_server at `localhost:5001` using:

1. **WebSocket (Primary)** - Real-time bidirectional communication via `ws://localhost:5001/tbird-sync/ws`
   - Server pushes commands immediately (no polling delay)
   - Extension sends results/events back via WebSocket
   - Auto-reconnect with exponential backoff (1s → 2s → 4s → ... → 30s max)

2. **HTTP Polling (Fallback)** - Activates when WebSocket is unavailable
   - Polls `GET /tbird-sync/pending` every 3 seconds
   - Posts results to `POST /tbird-sync/complete`

**Supported operations:**
- Mark messages as read/unread
- Set flagged status
- Archive, move, delete messages
- Execute generic allowlisted RPC calls into Thunderbird's WebExtension APIs

It also exposes a toolbar button ("Cortex1 Sync") for manual sync.

No native messaging, no Python helper - just install the .xpi.

## Installation

1. Run `build.bat` to create `cortex1-tbird-sync.xpi`
2. In Thunderbird:
   - Go to **Add-ons Manager** (Tools → Add-ons and Themes)
   - Click gear icon → **Install Add-on From File**
   - Select `cortex1-tbird-sync.xpi`

That's it. The extension will start polling cortex_server automatically.

Note: In newer Thunderbird/Betterbird versions, the "Cortex1 Sync" button may be hidden by default. Use the Extensions (puzzle piece) menu to pin it to the toolbar, or use toolbar customization to place it.

## How It Works

### WebSocket Mode (Primary)

```
┌─────────────────┐                    ┌──────────────────┐
│ cortex_server   │ ═══ WebSocket ════ │ TB Extension     │
│ (port 5001)     │ ws://localhost:5001│                  │
│                 │   /tbird-sync/ws   │                  │
└─────────────────┘                    └──────────────────┘
      │                                        │
      │  ─── {type:"command", data:{...}} ───▶ │
      │  ◀── {type:"result", data:{...}} ────  │
      │  ◀── {type:"event", data:{...}} ─────  │
      │  ─── {type:"ping"} ─────────────────▶  │
      │  ◀── {type:"pong"} ─────────────────── │
```

1. Extension connects to WebSocket on startup
2. Server pushes commands in real-time (no polling delay)
3. Extension executes commands via `messenger.messages.update()`
4. Extension sends results/events back via WebSocket
5. Auto-reconnect with exponential backoff if disconnected

### HTTP Fallback Mode

```
┌─────────────────┐                    ┌──────────────────┐
│ cortex_server   │ <── GET /pending ──│ TB Extension     │
│ (port 5001)     │                    │ (polls every 3s) │
│                 │ ── POST /complete →│                  │
└─────────────────┘                    └──────────────────┘
```

Activates automatically when WebSocket is unavailable:
1. Extension polls `GET /tbird-sync/pending` every 3 seconds
2. Server returns list of commands: `{commands: [{action: "mark_read", messageId: "..."}]}`
3. Extension executes commands via `messenger.messages.update()`
4. Extension reports results via `POST /tbird-sync/complete`
5. Events posted to `POST /tbird-sync/events`

## Server Endpoints (cortex_server)

The extension expects these endpoints on `localhost:5001`:

### WebSocket Endpoint (Primary)

**WS /tbird-sync/ws**

Bidirectional WebSocket for real-time communication.

**Server → Extension messages:**
```json
{"type": "command", "data": {"id": "uuid", "action": "mark_read", "messageId": "..."}}
{"type": "ping", "data": {}}
```

**Extension → Server messages:**
```json
{"type": "result", "data": {"id": "uuid", "success": true, "action": "mark_read"}}
{"type": "event", "data": {"event_type": "messages.onNewMailReceived", ...}}
{"type": "pong", "data": {"timestamp": 1234567890}}
```

### HTTP Endpoints (Fallback)

**GET /tbird-sync/pending**
```json
{
  "commands": [
    {"id": "uuid", "action": "mark_read", "messageId": "msg-id@example.com"},
    {"id": "uuid", "action": "set_flagged", "messageId": "msg-id@example.com", "flagged": true}
  ]
}
```

**POST /tbird-sync/complete**
```json
{
  "results": [
    {"id": "uuid", "success": true, "action": "mark_read"},
    {"id": "uuid", "success": false, "error": "Message not found"}
  ]
}
```

**POST /tbird-sync/events** (optional)
```json
{
  "events": [
    {"event_id":"...","event_type":"messages.onNewMailReceived","ts_ms":1730000000000,"seq":1,"payload":{...}}
  ]
}
```

## Supported Actions

### Single Message Actions
| Action | Description |
|--------|-------------|
| `mark_read` | Set message read=true |
| `mark_unread` | Set message read=false |
| `set_flagged` | Set flagged status (requires `flagged: true/false`) |
| `open_message` | Open message in new Thunderbird window |
| `get_status` | Get live read/flagged status from Thunderbird |
| `create_draft` | Create reply draft (requires `body`, optional `replyAll`) |
| `send_reply` | Send reply immediately (requires `body`, optional `replyAll`) |

### Batch Actions
| Action | Description |
|--------|-------------|
| `archive` | Archive messages (requires `messageIds` array) |
| `move` | Move messages to folder (requires `messageIds`, `folder`) |
| `bulk_mark_read` | Mark multiple messages as read (requires `messageIds`) |
| `bulk_get_status` | Get status of multiple messages (requires `messageIds`) |
| `list_folders` | List all available folders |

### Generic Action
| Action | Description |
|--------|-------------|
| `rpc` | Execute an allowlisted Thunderbird WebExtension method (`method`, `args`) |

### Status Query Notes

The `get_status` and `bulk_get_status` commands return **live status** from Thunderbird:
- `read`: Whether message is read (accurate)
- `flagged`: Whether message is starred/flagged (accurate)
- `junk`: Spam status (accurate)

**Important:** `forwarded` and `replied` status are **NOT available** via Thunderbird's WebExtension API.
These can only be read from X-Mozilla-Status headers in mbox files, which may be stale until Thunderbird compacts the folder.

## Requirements

- Thunderbird 115+ (or Betterbird)
- cortex_server running on localhost:5001

## Configuration (Optional)

These are stored in `messenger.storage.local`:

- `cortex_server_url`: override server base URL (default: `http://localhost:5001`)
- `cortex_event_push_enabled`: set to `false` to disable HTTP event push (default: enabled)

## Diagnostics

You can export a diagnostics bundle (debug logs + recent failures) directly from the extension UI:

- Right-click the "Cortex1 Sync" toolbar button and choose "Export Diagnostics".
- Or use the extension command "export-diagnostics" if you bind it to a shortcut in Thunderbird.

The export is saved as JSON/JSONL via the downloads API so it works even when `cortex_server` is not running.

## TODO (Logging / Diagnostics)

- Reduce/structure noisy logs: categorize + rate-limit repeated errors (e.g., connection refused) and keep a bounded ring buffer with clear “dropped N entries” counters.
- Make logging paths explicit on the server side (document `CORTEX_RPC_LOG_PATH`) and optionally support posting extension logs to the server for centralized troubleshooting.

## License

Business Source License 1.1 (BSL 1.1)

- Non-production use allowed; production/commercial/hosted use requires a commercial license.
- Change Date: 2030-01-01
- Change License: Apache 2.0
- Contact: Saqib.Khan@Me.com

This repository is licensed under BSL 1.1 with the Additional Use Grant in LICENSE.
